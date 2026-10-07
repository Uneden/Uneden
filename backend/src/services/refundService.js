import pool from "../config/db.js";
import {
  WORKER_COMMISSION_RATE,
  workerNetFromGross,
} from "../utils/commissionRates.js";
import stripe from "../config/stripe.js";
import { withTransaction } from "./paymentGuards.js";

function createRefundError(statusCode, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = { message, ...extra };
  return error;
}

function roundCents(value) {
  return Math.round(Number(value) || 0);
}

function roundDollars(value) {
  return Number((Number(value) || 0).toFixed(2));
}

/**
 * Returns refund summary based on base price only.
 * Buyer fee (5%) is never refundable.
 * Taxes are refunded proportionally on top of the base refund.
 * Min refund: 50% of base. Max refund: 100% of base (+ proportional taxes).
 */
export function buildRefundSummary(paymentRow, servicePrice) {
  if (!paymentRow) return null;

  const basePriceCents = roundCents(Number(servicePrice) * 100);
  const platformFeeCents = roundCents(paymentRow.platform_fee); // 5% buyer fee, never refunded

  return {
    base_price_cents: basePriceCents,
    platform_fee_cents: platformFeeCents,
    min_percentage: 50,
    max_percentage: 100,
  };
}

/**
 * Splits a refund over the booking's charges, in the order given (newest
 * first). Deposit + balance bookings have two PaymentIntents: refunding the
 * whole amount on the last one either fails at Stripe or leaves part unpaid.
 * @param {number} totalCents
 * @param {number[]} refundableCents what each charge can still refund
 * @returns {number[] | null} cents per charge, or null if the charges can't cover it
 */
export function splitRefundAcrossCharges(totalCents, refundableCents) {
  let remaining = Math.max(0, Math.round(totalCents));
  const parts = refundableCents.map((available) => {
    const part = Math.min(remaining, Math.max(0, Math.round(available)));
    remaining -= part;
    return part;
  });
  return remaining > 0 ? null : parts;
}

/**
 * Refunds totalCents across the given payment rows at Stripe. Idempotency
 * keys make a retry or a double click return the same refunds instead of
 * refunding twice.
 * @returns {Promise<object[]>} the Stripe refunds
 */
export async function refundAcrossPayments(payments, totalCents, keyPrefix) {
  if (totalCents <= 0) return [];
  const charges = await Promise.all(
    payments.map(async (payment) => {
      const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id, {
        expand: ["latest_charge"],
      });
      const charge = intent.latest_charge;
      return charge && typeof charge === "object" ? charge.amount - charge.amount_refunded : 0;
    }),
  );
  const parts = splitRefundAcrossCharges(totalCents, charges);
  if (!parts) {
    throw createRefundError(400, "The refund exceeds what is left to refund on this booking's payments");
  }
  const refunds = [];
  for (let i = 0; i < payments.length; i++) {
    if (parts[i] <= 0) continue;
    refunds.push(
      await stripe.refunds.create(
        { payment_intent: payments[i].stripe_payment_intent_id, amount: parts[i] },
        { idempotencyKey: `${keyPrefix}:${payments[i].id}:${parts[i]}` },
      ),
    );
  }
  return refunds;
}

/**
 * Process a booking refund based on a percentage of the base price.
 * - refundPercentage: 50–100 (% of base price to refund)
 * - Client receives: base × % + taxes × %
 * - Worker loses: base × % × worker net share
 * - Platform loses: base × % × worker commission rate + taxes × %
 * - Buyer fee (5%): always kept by platform
 *
 * Stripe calls come first and are idempotent; the database is then updated
 * once, by whoever claims the payments (a double click finds none left).
 */
export async function processBookingRefund({ bookingId, refundPercentage, cancelBooking = false }) {
  const pctInput = Number(refundPercentage);
  if (!Number.isFinite(pctInput) || pctInput < 50 || pctInput > 100) {
    throw createRefundError(400, "refund_percentage must be a number between 50 and 100");
  }
  const pct = pctInput / 100;

  const bookingResult = await pool.query(
    `SELECT b.id, b.client_id, b.worker_id, b.tax_rate, b.paid_service_base_cents,
            COALESCE(b.custom_price, s.price) AS service_price,
            s.title AS service_title,
            CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
            CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN users uc ON uc.id = b.client_id
     JOIN users uw ON uw.id = b.worker_id
     WHERE b.id = $1`,
    [bookingId],
  );
  const booking = bookingResult.rows[0];
  if (!booking) throw createRefundError(404, "Booking not found");

  const payments = (
    await pool.query(
      `SELECT id, stripe_payment_intent_id, stripe_transfer_id
       FROM payments
       WHERE booking_id = $1 AND status IN ('paid', 'transferred') AND stripe_payment_intent_id IS NOT NULL
       ORDER BY created_at DESC`,
      [bookingId],
    )
  ).rows;
  if (payments.length === 0) {
    throw createRefundError(404, "No eligible payment found for this booking");
  }

  // What the client actually paid for the service (deposit + balance, agreed
  // range or hourly amount); the listing price is only a fallback.
  const paidBaseCents = roundCents(booking.paid_service_base_cents);
  const basePriceCents = paidBaseCents > 0 ? paidBaseCents : roundCents(Number(booking.service_price) * 100);
  const taxRate = Number(booking.tax_rate) || 0;
  if (basePriceCents <= 0) {
    throw createRefundError(400, "Invalid base price for this booking");
  }

  const refundBaseCents = roundCents(basePriceCents * pct);
  const refundTaxesCents = roundCents(refundBaseCents * taxRate);
  const totalClientRefundCents = refundBaseCents + refundTaxesCents;
  const workerReversalCents = roundCents(workerNetFromGross(refundBaseCents / 100) * 100);
  const platformCommissionLossCents = roundCents(refundBaseCents * WORKER_COMMISSION_RATE);

  // 1. Take back the worker's share if it was already transferred.
  const transferId = payments.find((p) => p.stripe_transfer_id)?.stripe_transfer_id;
  if (transferId && workerReversalCents > 0) {
    await stripe.transfers.createReversal(
      transferId,
      { amount: workerReversalCents },
      { idempotencyKey: `refund-reversal:${bookingId}:${workerReversalCents}` },
    );
  }

  // 2. Refund the client (base portion + proportional taxes).
  const refunds = await refundAcrossPayments(payments, totalClientRefundCents, `booking-refund:${bookingId}`);

  // 3. Record it once.
  await withTransaction(async (db) => {
    const claimed = await db.query(
      `UPDATE payments SET status = 'refunded', updated_at = NOW()
       WHERE booking_id = $1 AND status IN ('paid', 'transferred')
       RETURNING id`,
      [bookingId],
    );
    if (claimed.rows.length === 0) return; // a concurrent call already recorded it

    await db.query(
      cancelBooking
        ? "UPDATE bookings SET payment_status = 'refunded', status = 'cancelled' WHERE id = $1"
        : "UPDATE bookings SET payment_status = 'refunded' WHERE id = $1",
      [bookingId],
    );

    const totalClientRefundDollars = roundDollars(totalClientRefundCents / 100);
    await db.query(
      `UPDATE wallets
       SET total_spent = GREATEST(0, total_spent - $1), updated_at = NOW()
       WHERE user_id = $2`,
      [totalClientRefundDollars, booking.client_id],
    );
    await db.query(
      `INSERT INTO transactions (user_id, booking_id, type, amount, description, other_user_name, listing_title)
       VALUES ($1, $2, 'credit', $3, 'Remboursement - litige résolu', $4, $5)
       ON CONFLICT (booking_id, user_id) WHERE type = 'credit' AND booking_id IS NOT NULL DO NOTHING`,
      [booking.client_id, bookingId, totalClientRefundDollars, booking.worker_name, booking.service_title],
    );

    if (workerReversalCents <= 0) return;
    const workerReversalDollars = roundDollars(workerReversalCents / 100);
    await db.query(
      `UPDATE wallets
       SET balance = GREATEST(0, balance - $1),
           total_earned = GREATEST(0, total_earned - $1),
           updated_at = NOW()
       WHERE user_id = $2`,
      [workerReversalDollars, booking.worker_id],
    );

    // Reduce the worker's credit so the payout only sends what is left.
    const creditTx = await db.query(
      `SELECT id, amount FROM transactions
       WHERE booking_id = $1 AND user_id = $2 AND type = 'credit'`,
      [bookingId, booking.worker_id],
    );
    if (creditTx.rows.length > 0) {
      const remainingAmount = roundDollars(Number(creditTx.rows[0].amount) - workerReversalDollars);
      if (remainingAmount <= 0) {
        await db.query("DELETE FROM transactions WHERE id = $1", [creditTx.rows[0].id]);
      } else {
        await db.query(
          `UPDATE transactions SET amount = $1, description = $2 WHERE id = $3`,
          [remainingAmount, `Paiement reçu — ajusté après litige (${Math.round(pct * 100)}% remboursé)`, creditTx.rows[0].id],
        );
      }
    }

    if (platformCommissionLossCents > 0) {
      await db.query(
        `UPDATE platform_earnings
         SET amount = GREATEST(0, amount - $2)
         WHERE booking_id = $1 AND type = 'worker_commission'`,
        [bookingId, roundDollars(platformCommissionLossCents / 100)],
      );
      await db.query(
        `DELETE FROM platform_earnings
         WHERE booking_id = $1 AND type = 'worker_commission' AND amount <= 0`,
        [bookingId],
      );
    }
  });

  return {
    refund_id: refunds[0]?.id ?? null,
    refund_ids: refunds.map((r) => r.id),
    refund_percentage: Math.round(pct * 100),
    refund_base_cents: refundBaseCents,
    refund_taxes_cents: refundTaxesCents,
    total_client_refund_cents: totalClientRefundCents,
    worker_reversal_cents: workerReversalCents,
    platform_commission_loss_cents: platformCommissionLossCents,
  };
}
