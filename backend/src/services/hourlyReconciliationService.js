import pool from "../config/db.js";
import { refundAcrossPayments } from "./refundService.js";
import { normalizePricingMode } from "../utils/servicePricing.js";
import { resolveBookingHourlyRate } from "../utils/hourlyPayment.js";
import { createLocalizedNotification } from "../services/notificationService.js";

function getEffectiveBookingPrice(booking) {
  const mode = normalizePricingMode(booking.pricing_mode ?? booking.service_pricing_mode);
  if (mode === "hourly") {
    const rate = resolveBookingHourlyRate(booking);
    const approved = Number(booking.approved_hours_total);
    const hours =
      Number.isFinite(approved) && approved > 0
        ? approved
        : Number(booking.estimated_hours ?? booking.service_estimated_hours ?? 1);
    return Math.round(rate * hours * 100) / 100;
  }
  return Number(booking.custom_price ?? booking.price ?? booking.service_price);
}

/**
 * After hourly completion: refund client if total paid base exceeds approved hours cost.
 */
export async function processHourlyReconciliation(bookingId) {
  const result = await pool.query(
    `SELECT b.*, s.pricing_mode AS service_pricing_mode, s.estimated_hours AS service_estimated_hours,
            s.price AS service_price,
            s.title AS service_title
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.id = $1`,
    [bookingId],
  );

  if (result.rows.length === 0) return { refunded_cents: 0 };

  const booking = result.rows[0];
  const mode = normalizePricingMode(booking.pricing_mode ?? booking.service_pricing_mode);
  if (mode !== "hourly") return { refunded_cents: 0 };

  const paidBaseCents = Number(booking.paid_service_base_cents) || 0;
  if (paidBaseCents <= 0) return { refunded_cents: 0 };

  const finalBase = getEffectiveBookingPrice(booking);
  const finalCents = Math.round(finalBase * 100);
  const diffCents = paidBaseCents - finalCents;

  if (diffCents <= 1) {
    return { refunded_cents: 0, final_base: finalBase, paid_base: paidBaseCents / 100 };
  }

  // Every charge (deposit + balance), not only the latest one, which may be
  // smaller than the overpayment.
  const payments = (
    await pool.query(
      `SELECT id, stripe_payment_intent_id FROM payments
       WHERE booking_id = $1 AND status = 'paid' AND stripe_payment_intent_id IS NOT NULL
       ORDER BY created_at DESC`,
      [bookingId],
    )
  ).rows;
  if (payments.length === 0) {
    return { refunded_cents: 0, final_base: finalBase, paid_base: paidBaseCents / 100 };
  }

  const taxRate = Number(booking.tax_rate) || 0;
  const refundBaseCents = diffCents;
  const refundTaxCents = Math.round(refundBaseCents * taxRate);
  const totalRefundCents = refundBaseCents + refundTaxCents;

  await refundAcrossPayments(payments, totalRefundCents, `hourly-reconcile:${bookingId}`);

  createLocalizedNotification({
    userId: booking.client_id,
    type: "payment",
    link: "/bookings",
    en: {
      title: "Partial refund issued",
      body: `You were refunded $${(totalRefundCents / 100).toFixed(2)} because approved hours were less than the amount paid for "${booking.service_title}".`,
    },
    fr: {
      title: "Remboursement partiel",
      body: `Un remboursement de ${(totalRefundCents / 100).toFixed(2)} $ a été émis — les heures approuvées sont inférieures au montant payé pour « ${booking.service_title} ».`,
    },
  }).catch(() => {});

  return {
    refunded_cents: totalRefundCents,
    final_base: finalBase,
    paid_base: paidBaseCents / 100,
  };
}
