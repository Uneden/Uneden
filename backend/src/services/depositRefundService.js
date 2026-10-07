import pool from "../config/db.js";
import { withTransaction } from "./paymentGuards.js";
import { refundAcrossPayments } from "./refundService.js";
import { workerNetFromGross } from "../utils/commissionRates.js";
import { createLocalizedNotification } from "../services/notificationService.js";

import { resolveDepositBaseAmount } from "../utils/depositSchema.js";

function roundCents(value) {
  return Math.round(Number(value) || 0);
}

function roundDollars(value) {
  return Number((Number(value) || 0).toFixed(2));
}

/**
 * Client cancels a paid active booking when listing had a deposit.
 * Client refund = (service price - deposit) + proportional taxes.
 * Worker keeps their net share of deposit base; platform keeps commission + buyer fee.
 */
export async function processDepositCancellationRefund({ bookingId, cancelledByUserId }) {
  const result = await pool.query(
    `SELECT b.*, p.id AS payment_id, p.stripe_payment_intent_id, p.platform_fee, p.amount AS payment_amount,
            s.title AS service_title, s.pricing_mode, s.price, s.price_max, s.estimated_hours AS service_estimated_hours,
            s.deposit_enabled,
            CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
            CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN users uw ON uw.id = b.worker_id
     JOIN users uc ON uc.id = b.client_id
     JOIN payments p ON p.booking_id = b.id AND p.status = 'paid'
     WHERE b.id = $1
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [bookingId]
  );

  if (result.rows.length === 0) {
    const err = new Error("No paid booking found");
    err.statusCode = 404;
    throw err;
  }

  const row = result.rows[0];

  if (row.client_id !== cancelledByUserId) {
    const err = new Error("Only the client can cancel with deposit policy");
    err.statusCode = 403;
    throw err;
  }

  if (row.status !== "active" || !["paid", "deposit_paid"].includes(row.payment_status)) {
    const err = new Error("Only active paid bookings can be cancelled this way");
    err.statusCode = 400;
    throw err;
  }

  const depositCents = roundCents(row.deposit_amount_cents);
  const paidBaseCents = roundCents(row.paid_service_base_cents);
  const isDepositOnly = row.payment_status === "deposit_paid";

  if (!row.deposit_enabled || depositCents <= 0) {
    const err = new Error("This booking has no deposit policy");
    err.statusCode = 400;
    throw err;
  }

  const baseAmount = resolveDepositBaseAmount(
    {
      pricing_mode: row.pricing_mode,
      price: row.price,
      price_max: row.price_max,
      estimated_hours: row.estimated_hours ?? row.service_estimated_hours,
    },
    row,
  );
  const servicePriceCents = roundCents((baseAmount ?? Number(row.custom_price ?? row.price)) * 100);
  const taxRate = Number(row.tax_rate) || 0;

  let refundBaseCents;
  let workerDepositCents;

  if (isDepositOnly) {
    refundBaseCents = 0;
    workerDepositCents = roundCents(workerNetFromGross(paidBaseCents / 100) * 100);
  } else {
    refundBaseCents = Math.max(0, servicePriceCents - depositCents);
    workerDepositCents = roundCents(workerNetFromGross(depositCents / 100) * 100);
  }

  const totalTaxesCents = isDepositOnly
    ? 0
    : roundCents(servicePriceCents * taxRate);
  const totalClientRefundCents = refundBaseCents + totalTaxesCents;

  // Every charge of the booking (deposit + balance for hourly), not just the
  // latest one; idempotent so a double click refunds once.
  const payments = (
    await pool.query(
      `SELECT id, stripe_payment_intent_id FROM payments
       WHERE booking_id = $1 AND status = 'paid' AND stripe_payment_intent_id IS NOT NULL
       ORDER BY created_at DESC`,
      [bookingId],
    )
  ).rows;
  await refundAcrossPayments(payments, totalClientRefundCents, `deposit-cancel:${bookingId}`);

  const totalClientRefundDollars = roundDollars(totalClientRefundCents / 100);
  const commissionCents = roundCents(row.platform_fee);
  const netCostDollars = roundDollars(
    isDepositOnly
      ? (paidBaseCents + commissionCents) / 100
      : (depositCents + commissionCents) / 100,
  );

  const applied = await withTransaction(async (db) => {
    // Claim the cancellation: a concurrent request finds the booking no longer active.
    const claimed = await db.query(
      `UPDATE bookings SET status = 'cancelled', payment_status = 'refunded'
       WHERE id = $1 AND status = 'active'
       RETURNING id`,
      [bookingId],
    );
    if (claimed.rows.length === 0) return false;

    await db.query(
      `UPDATE payments SET status = 'refunded', updated_at = NOW()
       WHERE booking_id = $1 AND status = 'paid'`,
      [bookingId],
    );

    // Update the original debit transaction to the net cost (deposit + commission)
    // so the wallet shows a single entry instead of debit + credit
    await db.query(
      `UPDATE transactions
       SET amount = $1, description = 'Annulé — dépôt retenu'
       WHERE booking_id = $2 AND user_id = $3 AND type = 'debit'`,
      [netCostDollars, bookingId, row.client_id],
    );

    // Adjust total_spent to reflect only the net cost
    await db.query(
      `UPDATE wallets
       SET total_spent = GREATEST(0, total_spent - $1), updated_at = NOW()
       WHERE user_id = $2`,
      [totalClientRefundDollars, row.client_id],
    );

    if (workerDepositCents > 0) {
      const workerDepositDollars = roundDollars(workerDepositCents / 100);
      await db.query(
        `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [row.worker_id],
      );
      const credit = await db.query(
        `INSERT INTO transactions (user_id, booking_id, type, amount, description, other_user_name, listing_title)
         VALUES ($1, $2, 'credit', $3, 'Dépôt retenu — annulation client', $4, $5)
         ON CONFLICT (booking_id, user_id) WHERE type = 'credit' AND booking_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [row.worker_id, bookingId, workerDepositDollars, row.client_name, row.service_title],
      );
      if (credit.rows.length > 0) {
        await db.query(
          `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1, updated_at = NOW()
           WHERE user_id = $2`,
          [workerDepositDollars, row.worker_id],
        );
      }
    }

    await db.query(
      `UPDATE calendar_events SET status = 'cancelled', updated_at = NOW()
       WHERE booking_id = $1 AND status = 'scheduled'`,
      [bookingId],
    );
    return true;
  });
  if (!applied) {
    const err = new Error("This booking was already cancelled");
    err.statusCode = 409;
    throw err;
  }

  createLocalizedNotification({
    userId: row.worker_id,
    type: "booking_cancelled",
    link: "/bookings",
    en: {
      title: "Booking cancelled",
      body: `${row.client_name} cancelled "${row.service_title}". The deposit was retained.`,
    },
    fr: {
      title: "Réservation annulée",
      body: `${row.client_name} a annulé « ${row.service_title} ». Le dépôt a été retenu.`,
    },
  }).catch(() => {});

  return {
    refund_cents: totalClientRefundCents,
    deposit_retained_cents: depositCents,
    worker_deposit_cents: workerDepositCents,
  };
}
