import pool from "../config/db.js";
import stripe from "../config/stripe.js";
import { processBookingRefund } from "../services/refundService.js";
import { ensureDepositsAndCalendarSchema, resolveBookingDepositMeta } from "../utils/depositSchema.js";
import { resolveCheckoutKind } from "../utils/hourlyPayment.js";
import {
  createConnectAccountSession,
  ensureStripeConnectAccount,
  getMissingPayoutProfileFields,
  getStoredStripeAccount,
  isUserPayoutProfileComplete,
  loadUserConnectProfile,
  syncConnectAccountStatus,
  syncProfileToStripeAccount,
  CONNECT_EMBEDDED_SESSION_FEATURES,
} from "../services/stripeConnectService.js";
import {
  completeCheckoutPayment,
  completePaymentFromIntent,
  repairDoubledDepositPaidBase,
} from "../services/paymentCompletionService.js";

// ─── Ensure platform_earnings table exists ────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS platform_earnings (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    booking_id    UUID REFERENCES bookings(id),
    type          TEXT NOT NULL CHECK (type IN ('buyer_commission', 'worker_commission')),
    amount        NUMERIC(10, 2) NOT NULL,
    description   TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (booking_id, type)
  )
`).catch((err) => console.error("[DB] Failed to create platform_earnings table:", err.message));

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// ─── Stripe Connect: legacy redirect link (Express fallback) ───────────────
export const createConnectAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await loadUserConnectProfile(userId);
    if (!isUserPayoutProfileComplete(user)) {
      return res.status(400).json({
        message: "Complete your profile before setting up payouts",
        code: "PROFILE_INCOMPLETE",
        missing_fields: getMissingPayoutProfileFields(user),
      });
    }

    const { stripeAccountId, accountType } = await ensureStripeConnectAccount(userId);
    await syncProfileToStripeAccount(userId, stripeAccountId, accountType);

    const isValidRelativePath = (path) =>
      path
      && typeof path === "string"
      && path.startsWith("/")
      && !path.includes("://")
      && !path.startsWith("//");

    const customReturnUrl = req.body?.return_url;
    const customRefreshUrl = req.body?.refresh_url;
    const returnUrl = isValidRelativePath(customReturnUrl)
      ? `${FRONTEND_URL}${customReturnUrl}`
      : `${FRONTEND_URL}/wallet?stripe=success`;
    const refreshUrl = isValidRelativePath(customRefreshUrl)
      ? `${FRONTEND_URL}${customRefreshUrl}`
      : `${FRONTEND_URL}/wallet?stripe=refresh`;

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url, embedded: false });
  } catch (err) {
    console.error("Stripe Connect error:", err);
    res.status(err.statusCode || 500).json({ message: "Failed to create Stripe Connect account" });
  }
};

// ─── Embedded Connect onboarding / account management (preferred) ────────────
export const createAccountSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const mode = req.body?.mode === "management" ? "management" : "onboarding";
    const stored = await getStoredStripeAccount(userId);

    const components =
      mode === "management" && stored?.charges_enabled
        ? {
            account_management: {
              enabled: true,
              features: CONNECT_EMBEDDED_SESSION_FEATURES,
            },
          }
        : {
            account_onboarding: {
              enabled: true,
              features: CONNECT_EMBEDDED_SESSION_FEATURES,
            },
          };

    const session = await createConnectAccountSession(userId, {
      components,
      requireProfile: mode !== "management",
    });
    res.json(session);
  } catch (err) {
    console.error("Account session error:", err);
    if (err.code === "PROFILE_INCOMPLETE") {
      return res.status(400).json({
        message: "Complete your profile before setting up payouts",
        code: err.code,
        missing_fields: err.missing_fields ?? [],
      });
    }
    // Surface Stripe's own error message (e.g. permission/config issues) — safe to show,
    // it's the same text Stripe's API returns, not an internal secret.
    res.status(err.statusCode || 500).json({
      message: "Failed to create account session",
      stripe_message: err.raw?.message || err.message || null,
    });
  }
};

export const getConnectConfig = async (_req, res) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return res.status(503).json({ message: "Stripe publishable key not configured" });
  }
  res.json({ publishable_key: publishableKey });
};

export const syncConnectProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stripeAccountId, accountType } = await ensureStripeConnectAccount(userId);
    const result = await syncProfileToStripeAccount(userId, stripeAccountId, accountType);
    res.json(result);
  } catch (err) {
    console.error("Connect profile sync error:", err);
    if (err.code === "PROFILE_INCOMPLETE") {
      return res.status(400).json({
        message: "Complete your profile before setting up payouts",
        code: err.code,
        missing_fields: err.missing_fields ?? [],
      });
    }
    res.status(err.statusCode || 500).json({ message: "Failed to sync profile to Stripe" });
  }
};

// ─── Get worker's Stripe Connect status ──────────────────────────────────────
export const getConnectStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await loadUserConnectProfile(userId);
    const profileReady = isUserPayoutProfileComplete(user);
    const missingFields = profileReady ? [] : getMissingPayoutProfileFields(user);
    const row = await getStoredStripeAccount(userId);

    if (!row?.stripe_account_id) {
      return res.json({
        connected: false,
        charges_enabled: false,
        details_submitted: false,
        profile_ready: profileReady,
        missing_fields: missingFields,
      });
    }

    try {
      const status = await syncConnectAccountStatus(userId, row.stripe_account_id);
      res.json({
        ...status,
        account_type: row.account_type || status.account_type || "express",
        profile_ready: profileReady,
        missing_fields: missingFields,
      });
    } catch (stripeErr) {
      console.error("[Stripe] accounts.retrieve failed:", stripeErr?.message);

      if (stripeErr?.code === "account_invalid" || stripeErr?.statusCode === 404) {
        await pool.query("DELETE FROM stripe_accounts WHERE user_id = $1", [userId]);
        return res.json({
          connected: false,
          charges_enabled: false,
          details_submitted: false,
          profile_ready: profileReady,
          missing_fields: missingFields,
        });
      }

      return res.json({
        connected: true,
        charges_enabled: row.charges_enabled ?? false,
        details_submitted: row.details_submitted ?? false,
        stripe_account_id: row.stripe_account_id,
        account_type: row.account_type || "express",
        profile_ready: profileReady,
        missing_fields: missingFields,
        cached: true,
      });
    }
  } catch (err) {
    console.error("[Stripe] getConnectStatus error:", err);
    res.status(500).json({ message: "Failed to get Stripe status" });
  }
};

function needsBookingPaymentReconciliation(booking, payment) {
  if (!booking || !payment || payment.status !== "paid") return false;
  const kind = payment.payment_kind || "full";
  const unpaid = !booking.payment_status || booking.payment_status === "unpaid";

  if (kind === "deposit" || kind === "full") {
    return booking.status === "accepted" && unpaid;
  }
  if (kind === "balance") {
    return (
      ["deposit_paid", "paid"].includes(booking.payment_status) &&
      Number(booking.balance_due_cents) > 0
    );
  }
  return false;
}

async function loadVerifyBookingSnapshot(bookingId) {
  const booking = await pool.query(
    `SELECT payment_status, status, paid_service_base_cents, balance_due_cents,
            pricing_mode, deposit_amount_cents, approved_hours_total, tax_rate
     FROM bookings WHERE id = $1`,
    [bookingId],
  );
  const paidPayment = await pool.query(
    `SELECT amount, platform_fee, payment_kind, stripe_checkout_session_id, status
     FROM payments
     WHERE booking_id = $1 AND status = 'paid'
     ORDER BY created_at DESC LIMIT 1`,
    [bookingId],
  );
  return {
    booking: booking.rows[0] ?? null,
    paid: paidPayment.rows[0] ?? null,
  };
}

// ─── Stripe Webhook ──────────────────────────────────────────────────────────
export const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    if (session.metadata?.booking_id) {
      try {
        await completeCheckoutPayment(session);
      } catch (err) {
        // 500 makes Stripe retry; applying a payment is idempotent.
        console.error("Error processing payment webhook:", err);
        return res.status(500).json({ received: false });
      }
    }
  }

  if (event.type === "account.updated") {
    const account = event.data.object;
    try {
      const row = await pool.query(
        "SELECT user_id FROM stripe_accounts WHERE stripe_account_id = $1",
        [account.id],
      );
      if (row.rows[0]?.user_id) {
        await syncConnectAccountStatus(row.rows[0].user_id, account.id);
      }
    } catch (err) {
      console.error("Error processing account.updated webhook:", err);
    }
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    if (paymentIntent.metadata?.booking_id && paymentIntent.metadata?.source === "uneden_elements") {
      try {
        await completePaymentFromIntent(paymentIntent);
      } catch (err) {
        console.error("Error processing payment_intent.succeeded:", err);
        return res.status(500).json({ received: false });
      }
    }
  }

  res.json({ received: true });
};

// ─── Refund payment (for disputes resolved in client's favor) ─────────────────
export const refundPayment = async (req, res) => {
  try {
    // refund_percentage (50–100), as for dispute resolutions. This used to pass
    // refund_amount_cents, which processBookingRefund ignores: every call failed.
    const { booking_id, refund_percentage } = req.body;
    const refundResult = await processBookingRefund({
      bookingId: booking_id,
      refundPercentage: refund_percentage,
      cancelBooking: true,
    });

    res.json({
      success: true,
      ...refundResult,
    });
  } catch (err) {
    console.error("Refund error:", err);
    if (err.statusCode) {
      return res.status(err.statusCode).json(err.payload);
    }
    res.status(500).json({ message: "Failed to refund payment" });
  }
};

// ─── Get payment status for a booking ────────────────────────────────────────
export const getPaymentStatus = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;

    const booking = await pool.query(
      `SELECT b.*, s.price, s.price_max, s.pricing_mode AS service_pricing_mode,
              s.estimated_hours AS service_estimated_hours,
              s.deposit_enabled AS service_deposit_enabled,
              s.deposit_type AS service_deposit_type,
              s.deposit_value AS service_deposit_value,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (booking.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const b = booking.rows[0];
    const serviceMeta = {
      pricing_mode: b.pricing_mode,
      price: b.price,
      price_max: b.price_max,
      estimated_hours: b.estimated_hours ?? b.service_estimated_hours,
      ...resolveBookingDepositMeta(b),
    };

    if (b.client_id !== userId && b.worker_id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const payment = await pool.query(
      `SELECT status, amount, platform_fee, currency, payment_kind, created_at
       FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [bookingId]
    );

    res.json({
      payment_status: b.payment_status,
      balance_due_cents: Number(b.balance_due_cents) || 0,
      paid_service_base_cents: Number(b.paid_service_base_cents) || 0,
      checkout_kind: resolveCheckoutKind(b, serviceMeta),
      payment: payment.rows[0] || null,
    });
  } catch (err) {
    console.error("Get payment status error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Verify and confirm payment after Stripe redirect ─────────────────────────
export const verifyPayment = async (req, res) => {
  try {
    await ensureDepositsAndCalendarSchema(pool);
    const { booking_id } = req.body;
    const userId = req.user.id;

    // Verify the caller is the client for this booking
    const ownershipCheck = await pool.query(
      "SELECT client_id FROM bookings WHERE id = $1",
      [booking_id]
    );
    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (ownershipCheck.rows[0].client_id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const respondWithSnapshot = async (extra = {}) => {
      const { booking, paid } = await loadVerifyBookingSnapshot(booking_id);
      return res.json({
        payment_kind: paid?.payment_kind ?? null,
        amount_cents: paid?.amount ?? null,
        platform_fee_cents: paid?.platform_fee ?? 0,
        booking,
        ...extra,
      });
    };

    // Get the pending payment for this booking
    const payment = await pool.query(
      "SELECT * FROM payments WHERE booking_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [booking_id]
    );

    if (payment.rows.length === 0) {
      const { booking, paid } = await loadVerifyBookingSnapshot(booking_id);

      if (paid && needsBookingPaymentReconciliation(booking, paid)) {
        if (paid.stripe_checkout_session_id) {
          const session = await stripe.checkout.sessions.retrieve(paid.stripe_checkout_session_id);
          if (session.payment_status === "paid") {
            await completeCheckoutPayment(session);
            return respondWithSnapshot({ confirmed: true, already_confirmed: true, reconciled: true });
          }
        }
      }

      await repairDoubledDepositPaidBase(booking_id);

      return respondWithSnapshot({
        confirmed: booking?.status === "active" || booking?.payment_status === "paid" || booking?.payment_status === "deposit_paid",
        already_confirmed: true,
      });
    }

    const p = payment.rows[0];

    // PaymentIntent flow (integrated Elements)
    if (p.stripe_payment_intent_id && !p.stripe_checkout_session_id) {
      const pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);
      if (pi.status !== "succeeded") {
        return res.json({ confirmed: false, stripe_status: pi.status });
      }
      await completePaymentFromIntent(pi);
      await repairDoubledDepositPaidBase(booking_id);
      return respondWithSnapshot({ confirmed: true });
    }

    // Legacy Checkout Session flow
    if (!p.stripe_checkout_session_id) {
      return respondWithSnapshot({ confirmed: false, message: "No checkout session found" });
    }

    const session = await stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id);

    if (session.payment_status !== "paid") {
      return res.json({ confirmed: false, stripe_status: session.payment_status });
    }

    // Update payment record and booking via shared handler
    await completeCheckoutPayment(session);

    return respondWithSnapshot({ confirmed: true });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ message: "Failed to verify payment" });
  }
};
