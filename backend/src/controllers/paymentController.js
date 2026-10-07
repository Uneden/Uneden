import pool from "../config/db.js";
import stripe from "../config/stripe.js";
import { processBookingRefund } from "../services/refundService.js";
import { calculateDepositAmount, ensureDepositsAndCalendarSchema, resolveBookingDepositMeta, resolveCheckoutBaseAmount } from "../utils/depositSchema.js";
import {
  computeBalanceDueCents,
  computeHourlyBalanceDueCents,
  getApprovedHoursBaseCents,
  getFullServiceBaseCents,
  getHourlyInitialChargeBaseDollars,
  computeHourlyBalanceCheckoutAmounts,
  hasUnpaidBalanceDue,
  resolveCheckoutKind,
  usesSplitDepositPayment,
} from "../utils/hourlyPayment.js";
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
import {
  billingAddressToStripeAddress,
  getOrCreateStripeCustomer,
} from "../services/stripeCustomerService.js";
import { recordWorkerPayoutLedger } from "../services/ledgerService.js";

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

import {
  BUYER_COMMISSION_RATE,
  WORKER_PAYOUT_SHARE,
  workerCommissionFromNet,
} from "../utils/commissionRates.js";
import { normalizeProvinceCode } from "../utils/taxProvince.js";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Tax rates by Canadian province
const PROVINCE_TAX_RATES = {
  AB: 0.05,
  BC: 0.12,
  MB: 0.12,
  NB: 0.15,
  NL: 0.15,
  NS: 0.15,
  NT: 0.05,
  NU: 0.05,
  ON: 0.13,
  PE: 0.15,
  QC: 0.14975,
  SK: 0.11,
  YT: 0.05,
};

const PROVINCE_TAX_LABELS = {
  AB: "GST (5%)",
  BC: "GST (5%) + PST (7%)",
  MB: "GST (5%) + PST (7%)",
  NB: "HST (15%)",
  NL: "HST (15%)",
  NS: "HST (15%)",
  NT: "GST (5%)",
  NU: "GST (5%)",
  ON: "HST (13%)",
  PE: "HST (15%)",
  QC: "GST (5%) + QST (9.975%)",
  SK: "GST (5%) + PST (6%)",
  YT: "GST (5%)",
};

function normalizeProvince(province) {
  return normalizeProvinceCode(province) ?? "QC";
}

function getTaxRate(province) {
  return PROVINCE_TAX_RATES[normalizeProvince(province)] ?? PROVINCE_TAX_RATES.QC;
}

function getTaxLabel(province) {
  return PROVINCE_TAX_LABELS[normalizeProvince(province)] ?? PROVINCE_TAX_LABELS.QC;
}

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

// ─── Create Stripe Checkout Session (client pays for accepted booking) ────────
export const createCheckoutSession = async (req, res) => {
  try {
    await ensureDepositsAndCalendarSchema(pool);
    const { booking_id, billing_province, billing_address_id } = req.body;
    const clientId = req.user.id;

    // Fetch booking + service + worker + client info
    const booking = await pool.query(
      `SELECT b.*, s.title, s.price, s.price_max, s.image_url,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              COALESCE(b.estimated_hours, s.estimated_hours) AS estimated_hours,
              s.estimated_hours AS service_estimated_hours,
              s.deposit_enabled AS service_deposit_enabled,
              s.deposit_type AS service_deposit_type,
              s.deposit_value AS service_deposit_value,
              u.email AS worker_email, u.province AS worker_province,
              uc.email AS client_email,
              uc.full_name AS client_full_name,
              uc.company_name AS client_company_name,
              uc.account_type AS client_account_type,
              uc.province AS client_province
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users u ON b.worker_id = u.id
       JOIN users uc ON b.client_id = uc.id
       WHERE b.id = $1`,
      [booking_id]
    );

    if (booking.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const b = booking.rows[0];

    if (b.client_id !== clientId) {
      return res.status(403).json({ message: "You are not the client for this booking" });
    }

    const depositFields = resolveBookingDepositMeta(b);
    const serviceMeta = {
      pricing_mode: b.pricing_mode,
      price: b.price,
      price_max: b.price_max,
      estimated_hours: b.estimated_hours ?? b.service_estimated_hours,
      ...depositFields,
    };

    const checkoutKind = resolveCheckoutKind(b, serviceMeta);
    if (!checkoutKind) {
      return res.status(400).json({ message: "This booking has already been paid" });
    }

    if (checkoutKind === "full" || checkoutKind === "deposit") {
      if (b.status !== "accepted") {
        return res.status(400).json({
          message: b.status === "negotiating"
            ? (req.lang === "en"
              ? "Agree on a price with the other party before payment."
              : "Convenez d'un prix avec l'autre partie avant le paiement.")
            : "Booking must be accepted before payment",
        });
      }
    } else if (checkoutKind === "balance") {
      if (b.status !== "active" && b.status !== "completed") {
        return res.status(400).json({ message: "Booking must be active before paying the balance" });
      }
      if (!["deposit_paid", "paid"].includes(b.payment_status)) {
        return res.status(400).json({ message: "Deposit must be paid before the balance" });
      }
    }

    let effectivePrice;
    let balanceCheckoutAmounts = null;
    if (checkoutKind === "deposit") {
      effectivePrice = getHourlyInitialChargeBaseDollars(b, serviceMeta);
    } else if (checkoutKind === "balance") {
      if (!hasUnpaidBalanceDue(b, serviceMeta)) {
        return res.status(400).json({ message: "No balance due for this booking" });
      }
      const balanceCents = computeBalanceDueCents(b, serviceMeta);
      const fullServiceDollars = getFullServiceBaseCents(b, serviceMeta) / 100;
      const taxRatePreview = getTaxRate(
        normalizeProvince(billing_province ?? b.client_province ?? "QC"),
      );
      balanceCheckoutAmounts = computeHourlyBalanceCheckoutAmounts(
        fullServiceDollars,
        balanceCents / 100,
        taxRatePreview,
      );
      effectivePrice = balanceCheckoutAmounts.balanceBase;
    } else {
      effectivePrice = resolveCheckoutBaseAmount(serviceMeta, b);
    }

    let billingAddress = null;
    if (billing_address_id) {
      const billingAddressResult = await pool.query(
        `SELECT id, full_name, address_line1, city, province, postal_code
         FROM billing_addresses
         WHERE id = $1 AND user_id = $2`,
        [billing_address_id, clientId]
      );

      if (billingAddressResult.rows.length === 0) {
        return res.status(404).json({ message: "Billing address not found" });
      }

      billingAddress = billingAddressResult.rows[0];
    }

    // normalizeProvince ensures we always store a 2-letter code (e.g. "QC" not "Quebec")
    const effectiveProvince    = normalizeProvince(billingAddress?.province ?? billing_province ?? b.client_province ?? "QC");
    const isBalanceFeesOnlyCheckout =
      checkoutKind === "balance" &&
      balanceCheckoutAmounts != null &&
      balanceCheckoutAmounts.totalCents >= 1 &&
      balanceCheckoutAmounts.balanceBaseCents < 1;
    if (isBalanceFeesOnlyCheckout) {
      // Service base already covered by deposit; only commission + taxes remain.
    } else if (effectivePrice == null || !Number.isFinite(effectivePrice) || effectivePrice < 0.01) {
      return res.status(400).json({
        message:
          req.lang === "en"
            ? "A confirmed price ($0.01 CAD or more) is required before checkout. Negotiate with the seller or update the booking."
            : "Un montant confirmé (0,01 $ ou plus) est requis avant le paiement. Négociez avec le vendeur ou mettez à jour la réservation.",
      });
    }
    const servicePriceCents    = Math.round(effectivePrice * 100);
    const depositAmount        = checkoutKind === "deposit"
      ? effectivePrice
      : calculateDepositAmount(
          resolveCheckoutBaseAmount(serviceMeta, b) ?? effectivePrice,
          b,
        );
    const depositAmountCents   = Math.round(depositAmount * 100);
    const isDepositOnly        = checkoutKind === "deposit";
    const isBalanceCheckout    = checkoutKind === "balance" && balanceCheckoutAmounts != null;
    const buyerCommissionCents = isDepositOnly
      ? 0
      : isBalanceCheckout
        ? balanceCheckoutAmounts.commissionCents
        : Math.round(servicePriceCents * BUYER_COMMISSION_RATE);
    const taxRate              = getTaxRate(effectiveProvince);
    const taxesCents           = isDepositOnly
      ? 0
      : isBalanceCheckout
        ? balanceCheckoutAmounts.taxesCents
        : Math.round(servicePriceCents * taxRate);
    const totalCents           = isBalanceCheckout
      ? balanceCheckoutAmounts.totalCents
      : servicePriceCents + buyerCommissionCents + taxesCents;
    const province             = effectiveProvince;

    let stripeCustomerId;
    if (billingAddress) {
      const defaultClientName = b.client_account_type === "company"
        ? (b.client_company_name || null)
        : (b.client_full_name || null);

      stripeCustomerId = await getOrCreateStripeCustomer(clientId, {
        email: b.client_email,
        name: billingAddress.full_name || defaultClientName || undefined,
        address: billingAddressToStripeAddress(billingAddress),
      });
    }

    // Update the booking's tax_rate to reflect the billing address province used
    await pool.query(
      "UPDATE bookings SET tax_rate = $1, client_province = $2, deposit_amount_cents = $3 WHERE id = $4",
      [
        taxRate,
        effectiveProvince,
        checkoutKind === "balance" && Number(b.deposit_amount_cents) > 0
          ? Number(b.deposit_amount_cents)
          : depositAmountCents,
        booking_id,
      ]
    );

    const lineItemName =
      checkoutKind === "deposit"
        ? `${b.title} — Dépôt`
        : checkoutKind === "balance"
          ? `${b.title} — Solde`
          : b.title;
    const lineItemDescription =
      checkoutKind === "deposit"
        ? "Dépôt de réservation"
        : checkoutKind === "balance"
          ? "Solde — heures approuvées"
          : "Service";

    // Create Checkout Session — funds go directly to platform account
    const lineItems = [];
    if (servicePriceCents > 0) {
      lineItems.push({
        price_data: {
          currency: "cad",
          product_data: {
            name: lineItemName,
            description: lineItemDescription,
            ...(b.image_url && b.image_url.length <= 2048 && { images: [b.image_url] }),
          },
          unit_amount: servicePriceCents,
        },
        quantity: 1,
      });
    }
    if (!isDepositOnly) {
      lineItems.push(
        {
          price_data: {
            currency: "cad",
            product_data: { name: "Commission acheteur (5%)" },
            unit_amount: buyerCommissionCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: "cad",
            product_data: { name: `Taxes (${getTaxLabel(province)})` },
            unit_amount: taxesCents,
          },
          quantity: 1,
        },
      );
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
      billing_address_collection: "required",
      line_items: lineItems,
      mode: "payment",
      locale: req.body.locale || "fr-CA",
      success_url: `${FRONTEND_URL}/bookings?payment=success&booking=${booking_id}`,
      cancel_url: `${FRONTEND_URL}/bookings?booking=${booking_id}`,
      metadata: {
        booking_id,
        payment_kind: checkoutKind,
        service_price_cents: String(servicePriceCents),
        deposit_amount_cents: String(depositAmountCents),
        buyer_commission_cents: String(buyerCommissionCents),
        taxes_cents: String(taxesCents),
        total_cents: String(totalCents),
        ...(billing_address_id ? { billing_address_id: String(billing_address_id) } : {}),
      },
    }, {
      // Reuse the session when the same booking asks for the same charge again,
      // instead of creating a second one the client could pay separately.
      // The amount is part of the key on purpose: an hourly balance legitimately
      // changes when approved hours change, and must get its own session.
      idempotencyKey: `checkout:${booking_id}:${checkoutKind}:${totalCents}`,
    });

    // Record pending payment in DB. ON CONFLICT covers the idempotent replay:
    // Stripe handed back a session we already recorded, so there is nothing to add.
    await pool.query(
      `INSERT INTO payments
         (booking_id, amount, status, stripe_checkout_session_id, platform_fee, currency, deposit_amount_cents, payment_kind)
       VALUES ($1, $2, 'pending', $3, $4, 'cad', $5, $6)
       ON CONFLICT (stripe_checkout_session_id) DO NOTHING`,
      [booking_id, totalCents, session.id, buyerCommissionCents, depositAmountCents, checkoutKind]
    );

    res.json({ url: session.url, session_id: session.id, checkout_kind: checkoutKind });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ message: "Failed to create checkout session" });
  }
};

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
        console.error("Error processing payment webhook:", err);
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
      }
    }
  }

  res.json({ received: true });
};

// ─── Release payment to worker (called when booking is marked completed) ──────
export const releasePayment = async (req, res) => {
  try {
    const { booking_id } = req.body;
    const userId = req.user.id;

    // Fetch booking
    const booking = await pool.query(
      `SELECT b.*, sa.stripe_account_id
       FROM bookings b
       LEFT JOIN stripe_accounts sa ON sa.user_id = b.worker_id
       WHERE b.id = $1`,
      [booking_id]
    );

    if (booking.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const b = booking.rows[0];

    if (b.worker_id !== userId) {
      return res.status(403).json({ message: "Only the worker can release payment" });
    }

    if (b.status !== "completed") {
      return res.status(400).json({ message: "Booking must be completed before releasing payment" });
    }

    if (b.payment_status !== "paid") {
      return res.status(400).json({ message: "No payment found for this booking" });
    }

    // Fetch payment record
    const payment = await pool.query(
      "SELECT * FROM payments WHERE booking_id = $1 AND status = 'paid'",
      [booking_id]
    );

    if (payment.rows.length === 0) {
      return res.status(404).json({ message: "Payment record not found" });
    }

    const p = payment.rows[0];

    if (!b.stripe_account_id) {
      return res.status(400).json({ message: "Worker has no Stripe account" });
    }

    // Verify Stripe account is fully enabled before transferring
    const stripeAccount = await stripe.accounts.retrieve(b.stripe_account_id);
    if (!stripeAccount.charges_enabled) {
      return res.status(400).json({ message: "Worker's Stripe account is not fully set up yet" });
    }

    // Transfer worker net share to worker (platform commission already deducted from credits)
    const effectivePrice = Number(b.custom_price ?? b.price);
    const servicePriceCents = Math.round(effectivePrice * 100);
    const transferAmount = Math.round(servicePriceCents * WORKER_PAYOUT_SHARE);

    // source_transaction requires a charge ID (ch_xxx), not a payment intent ID (pi_xxx)
    let sourceTransaction = p.stripe_payment_intent_id;
    if (sourceTransaction && sourceTransaction.startsWith("pi_")) {
      try {
        const pi = await stripe.paymentIntents.retrieve(sourceTransaction);
        const chargeId = typeof pi.latest_charge === "object" ? pi.latest_charge?.id : pi.latest_charge;
        if (chargeId) sourceTransaction = chargeId;
      } catch (piErr) {
        console.error(`[releasePayment] Could not resolve charge for PI ${sourceTransaction}:`, piErr.message);
      }
    }

    const transfer = await stripe.transfers.create({
      amount: transferAmount,
      currency: p.currency || "cad",
      destination: b.stripe_account_id,
      source_transaction: sourceTransaction,
      metadata: {
        booking_id: String(booking_id),
        worker_id: String(b.worker_id),
        transfer_type: "manual_release",
      },
    });

    const workerCommissionCents = Math.round(workerCommissionFromNet(transferAmount / 100) * 100);
    await recordWorkerPayoutLedger({
      bookingId: booking_id,
      workerId: b.worker_id,
      transferId: transfer.id,
      transferCents: transferAmount,
      workerCommissionCents,
      description: `Versement manuel — réservation ${booking_id}`,
    });

    // Update payment record
    await pool.query(
      `UPDATE payments SET status = 'transferred', stripe_transfer_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [transfer.id, p.id]
    );

    // Update booking payment_status
    await pool.query(
      "UPDATE bookings SET payment_status = 'transferred' WHERE id = $1",
      [booking_id]
    );

    res.json({ success: true, transfer_id: transfer.id });
  } catch (err) {
    console.error("Release payment error:", err);
    res.status(500).json({ message: "Failed to release payment" });
  }
};

// ─── Refund payment (for disputes resolved in client's favor) ─────────────────
export const refundPayment = async (req, res) => {
  try {
    const { booking_id, refund_amount_cents } = req.body;
    const refundResult = await processBookingRefund({
      bookingId: booking_id,
      refundAmountCents: refund_amount_cents,
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
