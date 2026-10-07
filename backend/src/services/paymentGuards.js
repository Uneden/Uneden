import pool from "../config/db.js";
import stripe from "../config/stripe.js";

/** 409 telling the caller to stop because money is (being) collected for the booking. */
export class PaymentConflictError extends Error {
  constructor(code, lang = "fr") {
    const messages = {
      ALREADY_PAID: {
        fr: "Cette réservation vient d'être payée. Actualisez la page.",
        en: "This booking has just been paid. Refresh the page.",
      },
      PAYMENT_IN_PROGRESS: {
        fr: "Un paiement est en cours de traitement pour cette réservation. Réessayez dans quelques minutes.",
        en: "A payment for this booking is being processed. Try again in a few minutes.",
      },
    };
    super(messages[code]?.[lang === "en" ? "en" : "fr"] ?? code);
    this.statusCode = 409;
    this.code = code;
  }
}

/** Runs fn(client) in a transaction: everything is written, or nothing. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const IN_FLIGHT = new Set(["processing", "requires_capture"]);

async function cancelIntent(paymentIntent) {
  if (paymentIntent.status === "succeeded" || paymentIntent.status === "canceled") return paymentIntent;
  if (IN_FLIGHT.has(paymentIntent.status)) return paymentIntent;
  try {
    return await stripe.paymentIntents.cancel(paymentIntent.id);
  } catch {
    // Confirmed between retrieve and cancel: report its real state.
    return stripe.paymentIntents.retrieve(paymentIntent.id);
  }
}

async function expireSession(session) {
  if (session.status !== "open") return session;
  try {
    return await stripe.checkout.sessions.expire(session.id);
  } catch {
    return stripe.checkout.sessions.retrieve(session.id);
  }
}

/**
 * Makes sure no earlier payment attempt for this booking can still go through,
 * before anything changes what the client pays for (new attempt, price change,
 * cancellation): pending PaymentIntents are cancelled and open Checkout
 * Sessions expired, at Stripe, so the client can't be charged twice nor for a
 * stale price. A payment that already succeeded is applied to the booking and
 * a PaymentConflictError stops the caller.
 *
 * @param {string} bookingId
 * @param {{ reuse?: (paymentIntent: object) => boolean, lang?: string }} [options]
 *   reuse: a still-payable PaymentIntent the caller can hand back instead of
 *   creating a new one (same amount, same customer).
 * @returns {Promise<object | null>} the reusable PaymentIntent, if any
 */
export async function settlePendingPayments(bookingId, { reuse, lang = "fr" } = {}) {
  // Dynamic import: paymentCompletionService imports bookingController, which imports this module.
  const { completePaymentFromIntent, completeCheckoutPayment } = await import("./paymentCompletionService.js");

  const pending = await pool.query(
    `SELECT id, stripe_payment_intent_id, stripe_checkout_session_id
     FROM payments
     WHERE booking_id = $1 AND status = 'pending'
     ORDER BY created_at DESC`,
    [bookingId],
  );

  let reusable = null;
  for (const row of pending.rows) {
    if (row.stripe_checkout_session_id) {
      const session = await expireSession(await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id));
      if (session.payment_status === "paid") {
        await completeCheckoutPayment(session);
        throw new PaymentConflictError("ALREADY_PAID", lang);
      }
      if (session.status === "complete") throw new PaymentConflictError("PAYMENT_IN_PROGRESS", lang);
      if (session.status !== "expired") throw new Error(`Could not expire checkout session ${session.id}`);
    } else if (row.stripe_payment_intent_id) {
      let intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
      const payable = !["succeeded", "canceled"].includes(intent.status) && !IN_FLIGHT.has(intent.status);
      if (!reusable && payable && reuse?.(intent)) {
        reusable = intent;
        continue;
      }
      intent = await cancelIntent(intent);
      if (intent.status === "succeeded") {
        await completePaymentFromIntent(intent);
        throw new PaymentConflictError("ALREADY_PAID", lang);
      }
      if (IN_FLIGHT.has(intent.status)) throw new PaymentConflictError("PAYMENT_IN_PROGRESS", lang);
      // Only mark the attempt cancelled once Stripe says it can no longer be paid.
      if (intent.status !== "canceled") throw new Error(`Could not cancel payment intent ${intent.id}`);
    }

    await pool.query(
      `UPDATE payments SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [row.id],
    );
  }
  return reusable;
}

/** Sends a PaymentConflictError (or any error with statusCode) as JSON; false otherwise. */
export function respondWithPaymentConflict(res, err) {
  if (!(err instanceof PaymentConflictError)) return false;
  res.status(err.statusCode).json({ message: err.message, code: err.code });
  return true;
}
