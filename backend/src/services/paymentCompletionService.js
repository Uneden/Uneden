import pool from "../config/db.js";
import stripe from "../config/stripe.js";
import { withTransaction } from "./paymentGuards.js";
import { finalizeCompletion } from "../controllers/bookingController.js";
import { notifyPaymentReceipt } from "./emailService.js";
import { createLocalizedNotification, getUserLang } from "./notificationService.js";
import {
  ensureDepositsAndCalendarSchema,
  calculateDepositAmount,
  resolveDepositBaseAmount,
} from "../utils/depositSchema.js";
import {
  computeBalanceDueCents,
} from "../utils/hourlyPayment.js";
import { BUYER_COMMISSION_RATE } from "../utils/commissionRates.js";
import { recordClientPaymentLedger } from "./ledgerService.js";

const CHECKOUT_TX_DESCRIPTION = {
  full: "Payment for service",
  deposit: "Dépôt — réservation",
  balance: "Solde — prestation",
};

function serviceMetaFromBookingRow(row) {
  return {
    pricing_mode: row.pricing_mode ?? row.service_pricing_mode,
    price: row.price ?? row.service_price,
    price_max: row.price_max,
    estimated_hours: row.estimated_hours ?? row.service_estimated_hours,
    deposit_enabled: row.service_deposit_enabled ?? row.deposit_enabled,
    deposit_type: row.service_deposit_type ?? row.deposit_type,
    deposit_value: row.service_deposit_value ?? row.deposit_value,
  };
}

function computeBalanceDueAfterDeposit(bookingRow, newPaidBase) {
  const meta = serviceMetaFromBookingRow(bookingRow);
  return computeBalanceDueCents(
    { ...bookingRow, paid_service_base_cents: newPaidBase, balance_due_cents: 0 },
    meta,
  );
}

/**
 * If verify + webhook both applied a deposit before idempotency existed,
 * paid_service_base_cents can be 2× the real amount. Correct booking totals.
 */
export async function repairDoubledDepositPaidBase(bookingId) {
  const bookingRow = await loadBookingForHourlyPayment(bookingId);
  if (!bookingRow || bookingRow.payment_status !== "deposit_paid") return false;

  const paidBase = Number(bookingRow.paid_service_base_cents || 0);
  if (paidBase < 1) return false;

  const meta = serviceMetaFromBookingRow(bookingRow);
  const baseDollars = resolveDepositBaseAmount(meta, bookingRow);
  const expectedCents =
    baseDollars != null
      ? Math.round(calculateDepositAmount(baseDollars, meta) * 100)
      : 0;

  const payments = await pool.query(
    `SELECT amount, deposit_amount_cents
     FROM payments
     WHERE booking_id = $1 AND status = 'paid' AND payment_kind = 'deposit'
     ORDER BY created_at ASC`,
    [bookingId],
  );

  const chargedFromPayments = payments.rows.reduce((sum, row) => {
    const cents = Number(row.deposit_amount_cents) || Number(row.amount) || 0;
    return sum + cents;
  }, 0);

  const storedDeposit = Number(bookingRow.deposit_amount_cents || 0);

  let correctCents = 0;
  if (expectedCents > 0 && paidBase === expectedCents * 2) {
    correctCents = expectedCents;
  } else if (storedDeposit > 0 && paidBase === storedDeposit * 2) {
    correctCents = storedDeposit;
  } else if (chargedFromPayments > 0 && paidBase === chargedFromPayments * 2) {
    correctCents = chargedFromPayments;
  } else if (
    expectedCents > 0 &&
    storedDeposit > 0 &&
    storedDeposit === expectedCents * 2 &&
    paidBase === storedDeposit
  ) {
    correctCents = expectedCents;
  } else {
    return false;
  }

  const balanceDueCents = computeBalanceDueAfterDeposit(bookingRow, correctCents);

  const result = await pool.query(
    `UPDATE bookings
     SET paid_service_base_cents = $2,
         balance_due_cents = $3,
         deposit_amount_cents = $2
     WHERE id = $1
       AND payment_status = 'deposit_paid'
       AND paid_service_base_cents = $4`,
    [bookingId, correctCents, balanceDueCents, paidBase],
  );
  return (result.rowCount ?? 0) > 0;
}

async function loadBookingForHourlyPayment(bookingId, db = pool, { lock = false } = {}) {
  const result = await db.query(
    `SELECT b.*, s.title, s.price AS service_price, s.pricing_mode AS service_pricing_mode,
            s.price_max, s.estimated_hours AS service_estimated_hours,
            s.deposit_enabled AS service_deposit_enabled,
            s.deposit_type AS service_deposit_type,
            s.deposit_value AS service_deposit_value,
            CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN users uc ON uc.id = b.client_id
     WHERE b.id = $1
     ${lock ? "FOR UPDATE OF b" : ""}`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    price: row.custom_price ?? row.service_price,
    pricing_mode: row.pricing_mode ?? row.service_pricing_mode,
  };
}

/**
 * Whether the booking, as it is now, can take this kind of payment. A payment
 * can land after the booking moved on (cancelled, rejected, paid in another
 * tab): it must then be refunded, not applied.
 */
export function bookingAcceptsPayment(booking, paymentKind) {
  if (!booking) return false;
  const unpaid = !booking.payment_status || booking.payment_status === "unpaid";
  if (paymentKind === "balance") {
    return ["active", "completed"].includes(booking.status) &&
      ["deposit_paid", "paid"].includes(booking.payment_status);
  }
  return booking.status === "accepted" && unpaid;
}

/**
 * Refunds a payment that cannot be applied (see bookingAcceptsPayment). The
 * idempotency key makes webhook retries and verify calls refund only once.
 */
async function refundUnappliedPayment({ bookingId, paymentIntentId, clientId }) {
  await stripe.refunds.create(
    { payment_intent: paymentIntentId },
    { idempotencyKey: `unapplied-payment:${paymentIntentId}` },
  );
  await pool.query(
    `UPDATE payments SET status = 'refunded', updated_at = NOW()
     WHERE stripe_payment_intent_id = $1 AND status = 'refunding'`,
    [paymentIntentId],
  );
  console.error(`[Payment] Refunded ${paymentIntentId}: booking ${bookingId} no longer accepted this payment`);
  if (clientId) {
    createLocalizedNotification({
      userId: clientId,
      type: "payment",
      link: `/bookings?booking=${bookingId}`,
      en: {
        title: "Payment refunded",
        body: "Your payment arrived after the booking changed (cancelled or already paid). It has been fully refunded.",
      },
      fr: {
        title: "Paiement remboursé",
        body: "Votre paiement est arrivé après un changement de la réservation (annulée ou déjà payée). Il vous a été entièrement remboursé.",
      },
    }).catch(() => {});
  }
}

/**
 * Apply successful payment to booking, transactions, platform earnings, and ledger.
 * Used by Checkout Session webhook and PaymentIntent webhook.
 *
 * Everything below runs in one transaction: claiming the payment row and
 * updating the booking used to be separate writes, so a failure in between
 * left a payment marked paid on a booking still "unpaid", which no retry could
 * repair (the claim was already taken). Throws on failure so the Stripe
 * webhook answers 500 and Stripe retries.
 */
export async function applySuccessfulPayment({
  bookingId,
  paymentIntentId,
  checkoutSessionId = null,
  paymentKind,
  paidServiceCents,
  totalAmountCents,
  buyerCommissionCents = 0,
  taxesCents = 0,
}) {
  await ensureDepositsAndCalendarSchema(pool);
  if (!paymentIntentId) return;

  const outcome = await withTransaction(async (db) => {
    // Lock the payment row: concurrent webhook + verify calls queue here.
    const paymentRow = (
      await db.query(
        checkoutSessionId
          ? `SELECT id, status FROM payments WHERE stripe_checkout_session_id = $1 FOR UPDATE`
          : `SELECT id, status FROM payments WHERE stripe_payment_intent_id = $1 AND booking_id = $2 FOR UPDATE`,
        checkoutSessionId ? [checkoutSessionId] : [paymentIntentId, bookingId],
      )
    ).rows[0];
    if (!paymentRow) return { done: true }; // unknown attempt: nothing to apply it to
    if (paymentRow.status === "refunding") return { refund: true };
    // "cancelled": the attempt was superseded (new attempt, price change,
    // cancellation) yet still got paid: refund it rather than apply it.
    if (paymentRow.status !== "pending" && paymentRow.status !== "cancelled") return { done: true };

    const bookingRow = await loadBookingForHourlyPayment(bookingId, db, { lock: true });
    if (paymentRow.status === "cancelled" || !bookingAcceptsPayment(bookingRow, paymentKind)) {
      await db.query(
        `UPDATE payments SET status = 'refunding', stripe_payment_intent_id = $2, updated_at = NOW() WHERE id = $1`,
        [paymentRow.id, paymentIntentId],
      );
      return { refund: true, clientId: bookingRow?.client_id };
    }

    await db.query(
      `UPDATE payments SET status = 'paid', stripe_payment_intent_id = $2, updated_at = NOW() WHERE id = $1`,
      [paymentRow.id, paymentIntentId],
    );

    const newPaidBase = Number(bookingRow.paid_service_base_cents || 0) + paidServiceCents;
    const balanceDueCents = computeBalanceDueAfterDeposit(bookingRow, newPaidBase);

    if (paymentKind === "deposit") {
      await db.query(
        `UPDATE bookings
         SET payment_status = 'deposit_paid', status = 'active',
             paid_service_base_cents = $2, balance_due_cents = $3
         WHERE id = $1`,
        [bookingId, newPaidBase, balanceDueCents],
      );
    } else if (paymentKind === "balance") {
      await db.query(
        `UPDATE bookings
         SET paid_service_base_cents = $2, balance_due_cents = $3, payment_status = $4
         WHERE id = $1`,
        [bookingId, newPaidBase, balanceDueCents, balanceDueCents <= 0 ? "paid" : "deposit_paid"],
      );
    } else {
      await db.query(
        `UPDATE bookings
         SET payment_status = 'paid', status = 'active',
             paid_service_base_cents = paid_service_base_cents + GREATEST($2, 0),
             balance_due_cents = 0
         WHERE id = $1`,
        [bookingId, paidServiceCents],
      );
    }

    const details = (
      await db.query(
        `SELECT b.client_id, p.amount, p.payment_kind, s.title, s.image_url, s.image_urls,
                CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
                CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
                uc.email AS client_email
         FROM bookings b
         JOIN services s ON b.service_id = s.id
         JOIN users uw ON b.worker_id = uw.id
         JOIN users uc ON b.client_id = uc.id
         JOIN payments p ON p.id = $2
         WHERE b.id = $1`,
        [bookingId, paymentRow.id],
      )
    ).rows[0];

    const kind = details.payment_kind || paymentKind;
    const amountDollars = (details.amount / 100).toFixed(2);
    const txDescription = CHECKOUT_TX_DESCRIPTION[kind] || CHECKOUT_TX_DESCRIPTION.full;

    const existingDebit = await db.query(
      `SELECT id FROM transactions WHERE booking_id = $1 AND type = 'debit' AND description = $2`,
      [bookingId, txDescription],
    );
    const firstDebit = existingDebit.rows.length === 0;
    if (firstDebit) {
      await db.query(
        `INSERT INTO transactions (user_id, booking_id, type, amount, description, other_user_name, listing_title)
         VALUES ($1, $2, 'debit', $3, $4, $5, $6)`,
        [details.client_id, bookingId, amountDollars, txDescription, details.worker_name, details.title],
      );
      await db.query(
        `INSERT INTO wallets (user_id, balance, total_spent)
         VALUES ($1, 0, $2)
         ON CONFLICT (user_id) DO UPDATE SET total_spent = wallets.total_spent + $2`,
        [details.client_id, amountDollars],
      );
    }

    if (paidServiceCents > 0 && paymentKind !== "deposit") {
      const buyerCommission = (Math.round(paidServiceCents * BUYER_COMMISSION_RATE) / 100).toFixed(2);
      await db.query(
        `INSERT INTO platform_earnings (booking_id, type, amount, description)
         VALUES ($1, 'buyer_commission', $2, 'Commission acheteur 5% — ' || $3)
         ON CONFLICT (booking_id, type) DO UPDATE
         SET amount = (platform_earnings.amount::numeric + EXCLUDED.amount::numeric)::numeric(10,2)`,
        [bookingId, buyerCommission, details.title],
      );
    }

    await recordClientPaymentLedger({
      bookingId,
      clientId: details.client_id,
      paymentIntentId,
      totalCents: totalAmountCents ?? details.amount,
      servicePriceCents: paidServiceCents,
      buyerCommissionCents: buyerCommissionCents || Math.round(paidServiceCents * BUYER_COMMISSION_RATE),
      taxesCents,
      paymentKind: kind,
      title: details.title,
    }, db);

    return { applied: true, details, amountDollars, sendReceipt: firstDebit };
  });

  if (outcome.refund) {
    await refundUnappliedPayment({ bookingId, paymentIntentId, clientId: outcome.clientId });
    return;
  }
  if (!outcome.applied) return;

  // Side effects only once the money is recorded.
  const { details, amountDollars, sendReceipt } = outcome;
  if (sendReceipt) {
    const clientLang = await getUserLang(details.client_id);
    notifyPaymentReceipt(
      details.client_email, details.client_name, details.title, amountDollars, details.worker_name,
      bookingId, details.image_url, details.image_urls, clientLang,
    );
  }

  const payoutBooking = await loadBookingForHourlyPayment(bookingId);
  if (payoutBooking?.status === "completed" && payoutBooking.payment_status === "paid") {
    await finalizeCompletion(payoutBooking).catch((err) =>
      console.error("Finalize completion after payment failed for booking", bookingId, err.message),
    );
  }
}

export async function completeCheckoutPayment(session) {
  const bookingId = session.metadata?.booking_id;
  if (!bookingId) return;

  const paymentIntentId = session.payment_intent;
  const paymentRow = await pool.query(
    `SELECT payment_kind, deposit_amount_cents, amount
     FROM payments WHERE stripe_checkout_session_id = $1`,
    [session.id],
  );
  const paymentKind =
    session.metadata?.payment_kind || paymentRow.rows[0]?.payment_kind || "full";
  const metaServiceCents = session.metadata?.service_price_cents;
  let paidServiceCents =
    metaServiceCents != null && metaServiceCents !== ""
      ? Number(metaServiceCents)
      : NaN;
  if (!Number.isFinite(paidServiceCents) && paymentRow.rows[0]) {
    paidServiceCents =
      Number(paymentRow.rows[0].deposit_amount_cents) ||
      Number(paymentRow.rows[0].amount) ||
      0;
  } else if (!Number.isFinite(paidServiceCents)) {
    paidServiceCents = 0;
  }

  const buyerCommissionCents = Number(session.metadata?.buyer_commission_cents ?? 0);
  const taxesCents = Number(session.metadata?.taxes_cents ?? 0);
  const totalAmountCents = Number(session.metadata?.total_cents ?? paymentRow.rows[0]?.amount ?? 0);

  await applySuccessfulPayment({
    bookingId,
    paymentIntentId,
    checkoutSessionId: session.id,
    paymentKind,
    paidServiceCents,
    totalAmountCents,
    buyerCommissionCents,
    taxesCents,
  });
}

export async function completePaymentFromIntent(paymentIntent) {
  const bookingId = paymentIntent.metadata?.booking_id;
  if (!bookingId) return;

  const paymentKind = paymentIntent.metadata?.payment_kind || "full";
  const paidServiceCents = Number(paymentIntent.metadata?.service_price_cents ?? 0);
  const buyerCommissionCents = Number(paymentIntent.metadata?.buyer_commission_cents ?? 0);
  const taxesCents = Number(paymentIntent.metadata?.taxes_cents ?? 0);
  const totalAmountCents = paymentIntent.amount_received || paymentIntent.amount;

  await applySuccessfulPayment({
    bookingId,
    paymentIntentId: paymentIntent.id,
    paymentKind,
    paidServiceCents,
    totalAmountCents,
    buyerCommissionCents,
    taxesCents,
  });
}
