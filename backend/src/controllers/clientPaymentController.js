import pool from "../config/db.js";
import stripe from "../config/stripe.js";
import { buildPaymentCheckoutContext } from "../services/paymentCheckoutService.js";
import {
  billingAddressToStripeAddress,
  createCustomerSetupIntent,
  detachCustomerPaymentMethod,
  getOrCreateStripeCustomer,
  listCustomerPaymentMethods,
} from "../services/stripeCustomerService.js";
import { completePaymentFromIntent } from "../services/paymentCompletionService.js";
import { ensureDepositsAndCalendarSchema } from "../utils/depositSchema.js";
import { respondWithPaymentConflict, settlePendingPayments } from "../services/paymentGuards.js";

export const createPaymentIntent = async (req, res) => {
  try {
    await ensureDepositsAndCalendarSchema(pool);
    const { booking_id, billing_address_id, billing_province, payment_method_id } = req.body;
    const clientId = req.user.id;
    const lang = req.lang === "en" ? "en" : "fr";

    const ctx = await buildPaymentCheckoutContext({
      clientId,
      bookingId: booking_id,
      billingAddressId: billing_address_id,
      billingProvince: billing_province,
      lang,
    });

    if (!ctx.ok) {
      return res.status(ctx.status).json({ message: ctx.message });
    }

    const {
      booking: b,
      checkoutKind,
      billingAddress,
      effectiveProvince,
      servicePriceCents,
      depositAmountCents,
      buyerCommissionCents,
      taxesCents,
      totalCents,
      defaultClientName,
    } = ctx.data;

    const stripeCustomerId = await getOrCreateStripeCustomer(clientId, {
      email: b.client_email,
      name: billingAddress?.full_name || defaultClientName || undefined,
      address: billingAddressToStripeAddress(billingAddress),
    });

    await pool.query(
      "UPDATE bookings SET tax_rate = $1, client_province = $2, deposit_amount_cents = $3 WHERE id = $4",
      [
        ctx.data.taxRate,
        effectiveProvince,
        // Never overwrite the charged deposit when paying the balance (would replace $50 with a recalculated base).
        checkoutKind === "balance" && Number(b.deposit_amount_cents) > 0
          ? Number(b.deposit_amount_cents)
          : depositAmountCents,
        booking_id,
      ],
    );

    const metadata = {
      booking_id: String(booking_id),
      payment_kind: checkoutKind,
      service_price_cents: String(servicePriceCents),
      deposit_amount_cents: String(depositAmountCents),
      buyer_commission_cents: String(buyerCommissionCents),
      taxes_cents: String(taxesCents),
      total_cents: String(totalCents),
      source: "uneden_elements",
      ...(billing_address_id ? { billing_address_id: String(billing_address_id) } : {}),
    };

    // Earlier attempts (second tab, reload, back button) used to be deleted
    // here while their PaymentIntent stayed payable at Stripe: the client
    // could pay twice, and the first payment was never applied. Reuse the
    // attempt when it charges the same thing, cancel it otherwise.
    const reusable = await settlePendingPayments(booking_id, {
      lang,
      reuse: (intent) =>
        intent.amount === totalCents &&
        intent.customer === stripeCustomerId &&
        intent.metadata?.payment_kind === checkoutKind &&
        intent.metadata?.service_price_cents === metadata.service_price_cents &&
        intent.metadata?.taxes_cents === metadata.taxes_cents,
    });

    const paymentIntent = reusable
      ? await stripe.paymentIntents.update(reusable.id, {
          metadata,
          ...(payment_method_id ? { payment_method: payment_method_id } : {}),
        })
      : await stripe.paymentIntents.create({
          amount: totalCents,
          currency: "cad",
          customer: stripeCustomerId,
          ...(payment_method_id ? { payment_method: payment_method_id } : {}),
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          metadata,
        });

    if (!reusable) {
      await pool.query(
        `INSERT INTO payments
           (booking_id, amount, status, stripe_payment_intent_id, platform_fee, currency, deposit_amount_cents, payment_kind)
         VALUES ($1, $2, 'pending', $3, $4, 'cad', $5, $6)`,
        [booking_id, totalCents, paymentIntent.id, buyerCommissionCents, depositAmountCents, checkoutKind],
      );
    }

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      checkout_kind: checkoutKind,
      amount_cents: totalCents,
    });
  } catch (err) {
    if (respondWithPaymentConflict(res, err)) return;
    console.error("[PaymentIntent] create error:", err);
    res.status(500).json({ message: "Failed to create payment intent" });
  }
};

export const confirmPaymentIntent = async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const clientId = req.user.id;

    const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (pi.metadata?.source !== "uneden_elements") {
      return res.status(400).json({ message: "Invalid payment intent" });
    }

    const bookingId = pi.metadata?.booking_id;
    const booking = await pool.query("SELECT client_id FROM bookings WHERE id = $1", [bookingId]);
    if (!booking.rows[0] || booking.rows[0].client_id !== clientId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (pi.status === "succeeded") {
      await completePaymentFromIntent(pi);
      return res.json({ success: true, status: pi.status });
    }

    res.json({ success: false, status: pi.status });
  } catch (err) {
    console.error("[PaymentIntent] confirm error:", err);
    res.status(500).json({ message: "Failed to confirm payment" });
  }
};

export const getPaymentMethods = async (req, res) => {
  try {
    const methods = await listCustomerPaymentMethods(req.user.id);
    res.json({ payment_methods: methods });
  } catch (err) {
    console.error("[PaymentMethods] list error:", err);
    res.status(500).json({ message: "Failed to list payment methods" });
  }
};

export const createSetupIntent = async (req, res) => {
  try {
    const result = await createCustomerSetupIntent(req.user.id);
    res.json(result);
  } catch (err) {
    console.error("[SetupIntent] create error:", err);
    res.status(500).json({ message: "Failed to create setup intent" });
  }
};

export const deletePaymentMethod = async (req, res) => {
  try {
    await detachCustomerPaymentMethod(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    console.error("[PaymentMethods] delete error:", err);
    res.status(500).json({ message: "Failed to remove payment method" });
  }
};

export const getStripePublishableKey = async (_req, res) => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    return res.status(503).json({ message: "Stripe publishable key not configured" });
  }
  res.json({ publishable_key: key });
};
