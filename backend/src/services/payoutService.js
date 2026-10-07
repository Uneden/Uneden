import pool from "../config/db.js";
import {
  WORKER_COMMISSION_RATE,
  workerCommissionFromNet,
  grossFromWorkerNet,
} from "../utils/commissionRates.js";
import stripe from "../config/stripe.js";
import { notifyPayoutReceived } from "./emailService.js";
import { createNotification, getUserLang } from "./notificationService.js";
import { recordWorkerPayoutLedger } from "./ledgerService.js";
import { withTransaction } from "./paymentGuards.js";
import { finalizeCompletion } from "../controllers/bookingController.js";

const MIN_BUSINESS_DAYS = 5;             // money must sit 5 business days before payout

// Reference date: Friday, Jan 3 2025 — anchor for bi-weekly cycle
const REFERENCE_FRIDAY = new Date("2025-01-03T16:00:00Z"); // 16:00 UTC = 12:00 EST
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

// ─── Date helpers ─────────────────────────────────────────────────────────────

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * Calculate the date that is `days` business days before `from`.
 * Used to determine the eligibility cutoff.
 */
export function subtractBusinessDays(from, days) {
  const result = new Date(from);
  let counted = 0;
  while (counted < days) {
    result.setDate(result.getDate() - 1);
    if (!isWeekend(result)) counted++;
  }
  return result;
}

/**
 * Returns the next payout date (bi-weekly Friday) after `from`.
 */
export function getNextPayoutDate(from = new Date()) {
  const fromMs = from.getTime();
  const refMs = REFERENCE_FRIDAY.getTime();
  const cyclesElapsed = Math.floor((fromMs - refMs) / TWO_WEEKS_MS);
  const nextMs = refMs + (cyclesElapsed + 1) * TWO_WEEKS_MS;
  return new Date(nextMs);
}

/**
 * Returns true if `date` falls on a payout Friday (bi-weekly cycle).
 */
export function isPayoutDay(date = new Date()) {
  if (date.getUTCDay() !== 5) return false; // must be Friday (UTC)
  const diffMs = date.getTime() - REFERENCE_FRIDAY.getTime();
  const diffWeeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  return diffWeeks % 2 === 0;
}

// ─── Payout logic ─────────────────────────────────────────────────────────────

// Booking payment states whose worker credit can be paid out.
const PAYABLE_PAYMENT_STATUSES = ["paid", "refunded", "deposit_paid"];

/**
 * Bookings whose worker credit can be paid out: completed work, or a client
 * cancellation where the worker keeps the deposit (status cancelled). Bookings
 * with an open dispute wait for its outcome.
 */
const PAYABLE_BOOKING_SQL = `
  b.status IN ('completed', 'cancelled')
  AND b.payment_status = ANY($PAYABLE::text[])
  AND EXISTS (
    SELECT 1 FROM payments p
    WHERE p.booking_id = b.id AND p.status IN ('paid', 'refunded')
  )
  AND NOT EXISTS (
    SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status = 'open'
  )`;

/**
 * Process bi-weekly payout for one user.
 * Transfers the worker's net share of eligible service earnings to their Stripe Connect account.
 *
 * Each booking is claimed (payment_status → transferred) before its transfer
 * and the transfer carries an idempotency key, so concurrent runs (cron +
 * admin trigger, a retried run) can't pay the same booking twice.
 */
export async function processUserPayout(userId) {
  // Get Stripe Connect account + worker info
  const stripeAccount = await pool.query(
    "SELECT stripe_account_id FROM stripe_accounts WHERE user_id = $1",
    [userId]
  );

  if (stripeAccount.rows.length === 0 || !stripeAccount.rows[0].stripe_account_id) {
    createNotification({
      userId,
      type: "payment",
      title: "Compte bancaire requis",
      body: "Un versement vous est dû mais votre compte Stripe n'est pas configuré. Connectez votre compte dans Portefeuille pour recevoir vos paiements.",
      link: "/wallet",
    }).catch(() => {});
    return null;
  }

  const stripeAccountId = stripeAccount.rows[0].stripe_account_id;

  const workerInfo = await pool.query(
    "SELECT email, CASE WHEN account_type = 'company' THEN company_name ELSE full_name END AS display_name FROM users WHERE id = $1",
    [userId]
  );
  const workerEmail = workerInfo.rows[0]?.email;
  const workerName  = workerInfo.rows[0]?.display_name;
  const eligibilityCutoff = subtractBusinessDays(new Date(), MIN_BUSINESS_DAYS);

  // Find all unpaid worker credit transactions older than MIN_BUSINESS_DAYS business days
  const creditsResult = await pool.query(
    `SELECT t.id AS tx_id, t.amount, t.booking_id, t.created_at,
            b.payment_status AS previous_payment_status,
            (
              SELECT p.stripe_payment_intent_id
              FROM payments p
              WHERE p.booking_id = t.booking_id AND p.status IN ('paid', 'refunded')
              ORDER BY CASE COALESCE(p.payment_kind, 'full')
                WHEN 'balance' THEN 0 WHEN 'full' THEN 1 WHEN 'deposit' THEN 2 ELSE 3 END,
                p.created_at DESC
              LIMIT 1
            ) AS stripe_payment_intent_id
     FROM transactions t
     JOIN bookings b ON b.id = t.booking_id
     WHERE t.user_id = $1
       AND t.type = 'credit'
       AND b.worker_id = $1
       AND ${PAYABLE_BOOKING_SQL.replace("$PAYABLE", "$3")}
       AND t.created_at <= $2
     ORDER BY t.created_at ASC`,
    [userId, eligibilityCutoff.toISOString(), PAYABLE_PAYMENT_STATUSES]
  );

  if (creditsResult.rows.length === 0) return null;

  let totalTransferredCents = 0;
  const processedBookings = [];

  for (const row of creditsResult.rows) {
    // Credit amount is already net (gross × WORKER_PAYOUT_SHARE) — transfer it as-is
    const transferCents = Math.round(Number(row.amount) * 100);
    if (transferCents <= 0) continue;

    // Claim the booking: a concurrent run finds it no longer payable.
    const claim = await pool.query(
      `UPDATE bookings SET payment_status = 'transferred'
       WHERE id = $1 AND payment_status = ANY($2::text[])
       RETURNING id`,
      [row.booking_id, PAYABLE_PAYMENT_STATUSES],
    );
    if (claim.rows.length === 0) continue;

    // source_transaction requires a charge ID (ch_xxx), not a payment intent ID (pi_xxx).
    // Resolve the PI to its underlying charge before transferring.
    let sourceTransaction = row.stripe_payment_intent_id;
    let transfer;
    try {
      if (sourceTransaction && sourceTransaction.startsWith("pi_")) {
        const pi = await stripe.paymentIntents.retrieve(sourceTransaction);
        const chargeId = typeof pi.latest_charge === "object"
          ? pi.latest_charge?.id
          : pi.latest_charge;
        if (chargeId) sourceTransaction = chargeId;
      }

      transfer = await stripe.transfers.create(
        {
          amount: transferCents,
          currency: "cad",
          destination: stripeAccountId,
          source_transaction: sourceTransaction,
          description: `Versement bi-mensuel — réservation ${row.booking_id}`,
          metadata: {
            booking_id: String(row.booking_id),
            worker_id: String(userId),
            transfer_type: "biweekly_payout",
          },
        },
        { idempotencyKey: `payout:${row.booking_id}:${row.tx_id}` },
      );
    } catch (err) {
      console.error(`[Payout] Transfer failed for booking ${row.booking_id}:`, err.message);
      // Release the claim so the next run retries this booking.
      await pool.query(
        `UPDATE bookings SET payment_status = $2 WHERE id = $1 AND payment_status = 'transferred'`,
        [row.booking_id, row.previous_payment_status],
      ).catch((releaseErr) =>
        console.error(`[Payout] Could not release booking ${row.booking_id}:`, releaseErr.message),
      );
      continue;
    }

    const workerCommission = workerCommissionFromNet(transferCents / 100).toFixed(2);
    try {
      // Bookkeeping for this transfer: all of it or none.
      await withTransaction(async (db) => {
        // stripe_transfer_id lets a later dispute refund reverse the transfer.
        await db.query(
          `UPDATE payments SET status = 'transferred', stripe_transfer_id = $2, updated_at = NOW()
           WHERE booking_id = $1 AND status IN ('paid', 'refunded')`,
          [row.booking_id, transfer.id],
        );
        await db.query(
          `INSERT INTO platform_earnings (booking_id, type, amount, description)
           VALUES ($1, 'worker_commission', $2, $3)
           ON CONFLICT (booking_id, type) DO NOTHING`,
          [row.booking_id, workerCommission, `Commission vendeur ${WORKER_COMMISSION_RATE * 100}% au versement`],
        );
        await recordWorkerPayoutLedger({
          bookingId: row.booking_id,
          workerId: userId,
          transferId: transfer.id,
          transferCents,
          workerCommissionCents: Math.round(Number(workerCommission) * 100),
          description: `Versement bi-mensuel — réservation ${row.booking_id}`,
        }, db);
        await db.query(
          `UPDATE wallets SET balance = GREATEST(0, balance - $1), updated_at = NOW() WHERE user_id = $2`,
          [transferCents / 100, userId],
        );
      });
    } catch (err) {
      // The money left and the booking stays claimed (no second transfer);
      // only the bookkeeping above is missing and needs a manual fix.
      console.error(`[Payout] Transfer ${transfer.id} sent but bookkeeping failed for booking ${row.booking_id}:`, err);
    }

    totalTransferredCents += transferCents;
    processedBookings.push(row.booking_id);
  }

  if (processedBookings.length === 0) return null;

  const totalTransferredDollars = (totalTransferredCents / 100);

  // Record the payout debit transaction (wallet already reduced per booking)
  await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description)
     VALUES ($1, 'debit', $2, 'Versement bi-mensuel automatique')`,
    [userId, totalTransferredDollars]
  );

  const transferredDollars = totalTransferredDollars.toFixed(2);
  const grossDollars = grossFromWorkerNet(totalTransferredDollars).toFixed(2);
  const commissionDollars = (Number(grossDollars) - totalTransferredDollars).toFixed(2);
  const nextPayout = getNextPayoutDate(new Date()).toLocaleDateString(
    (await getUserLang(userId)) === "en" ? "en-CA" : "fr-CA",
    { weekday: "long", year: "numeric", month: "long", day: "numeric" },
  );

  if (workerEmail) {
    const lang = await getUserLang(userId);
    notifyPayoutReceived(workerEmail, workerName, transferredDollars, commissionDollars, grossDollars, processedBookings.length, nextPayout, lang)
      .catch((err) => console.error("[Payout] Email failed:", err.message));
  }

  return {
    transferred_cents: totalTransferredCents,
    commission_cents: 0,
    bookings_count: processedBookings.length,
  };
}

/**
 * Recover any completed bookings whose credit transaction was never inserted
 * (e.g. finalizeCompletion failed silently due to a DB hiccup). Goes through
 * finalizeCompletion itself, so the amount is computed the same way (hourly,
 * agreed range price…) and the unique credit index keeps it idempotent.
 */
async function recoverMissingCredits() {
  const missing = await pool.query(
    `SELECT b.*, s.title, s.pricing_mode AS service_pricing_mode,
            s.estimated_hours AS service_estimated_hours, s.price AS service_price,
            CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name
     FROM bookings b
     JOIN services s ON b.service_id = s.id
     JOIN users uc ON b.client_id = uc.id
     WHERE b.status = 'completed'
       AND b.payment_status = 'paid'
       AND NOT EXISTS (
         SELECT 1 FROM transactions t WHERE t.booking_id = b.id AND t.type = 'credit' AND t.user_id = b.worker_id
       )`
  );

  for (const booking of missing.rows) {
    try {
      await finalizeCompletion(booking);
    } catch (err) {
      console.error(`[Payout] Failed to recover credit for booking ${booking.id}:`, err.message);
    }
  }
}

let payoutRunInProgress = false;

/**
 * Process bi-weekly payouts for all eligible workers.
 * @returns {Promise<{ skipped?: boolean, workers?: number }>}
 */
export async function processAllPayouts() {
  // Cron and admin trigger in the same process: one run at a time. The
  // per-booking claim covers runs in different processes.
  if (payoutRunInProgress) return { skipped: true };
  payoutRunInProgress = true;
  try {
    // Recover any bookings where finalizeCompletion failed silently
    await recoverMissingCredits().catch((err) =>
      console.error("[Payout] recoverMissingCredits failed:", err.message)
    );

    const eligibilityCutoff = subtractBusinessDays(new Date(), MIN_BUSINESS_DAYS);

    const workers = await pool.query(
      `SELECT DISTINCT t.user_id
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       WHERE t.type = 'credit'
         AND b.worker_id = t.user_id
         AND ${PAYABLE_BOOKING_SQL.replace("$PAYABLE", "$2")}
         AND t.created_at <= $1`,
      [eligibilityCutoff.toISOString(), PAYABLE_PAYMENT_STATUSES]
    );

    let processed = 0;
    for (const { user_id } of workers.rows) {
      try {
        const result = await processUserPayout(user_id);
        if (result) processed++;
      } catch (err) {
        console.error(`[Payout] Error for user ${user_id}:`, err.message);
      }
    }
    return { workers: processed };
  } finally {
    payoutRunInProgress = false;
  }
}
