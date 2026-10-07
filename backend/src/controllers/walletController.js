import pool from "../config/db.js";
import { WORKER_COMMISSION_RATE, WORKER_PAYOUT_SHARE } from "../utils/commissionRates.js";
import crypto from "node:crypto";
import { getNextPayoutDate, isPayoutDay, subtractBusinessDays, processAllPayouts } from "../services/payoutService.js";
import ExcelJS from "exceljs";
import { logAdminAction } from "../services/auditService.js";

const PERIOD_INTERVAL = {
  "2weeks":  "2 weeks",
  "1month":  "1 month",
  "3months": "3 months",
  "6months": "6 months",
  "1year":   "1 year",
};

const MIN_BUSINESS_DAYS = 5;
const DISPUTE_WINDOW_DAYS = 3;
/** Worker earnings can be credited while balance is still due (split deposit). */
const WORKER_HOLD_PAYMENT_STATUSES = ["paid", "refunded", "deposit_paid"];

function getDisputeCutoffDate() {
  return new Date(Date.now() - DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export const getWallet = async (req, res) => {
  try {
    const userId = req.user.id;

    // Upsert wallet row so the endpoint always returns something
    await pool.query(
      "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId]
    );

    const result = await pool.query(
      "SELECT balance FROM wallets WHERE user_id = $1",
      [userId]
    );

    const wallet = result.rows[0] ?? { balance: 0 };

    // Compute total_earned from credit transactions where user is the worker
    // This always reflects refund adjustments (credit amount is reduced by refundService)
    const earnedResult = await pool.query(
      `SELECT COALESCE(SUM(t.amount), 0) AS total_earned
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       WHERE t.user_id = $1 AND t.type = 'credit' AND b.worker_id = $1`,
      [userId]
    );
    const total_earned = Number(earnedResult.rows[0]?.total_earned ?? 0);

    // Net client spend: debits minus dispute refunds (cancellation updates debit amount in place)
    const spentResult = await pool.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN t.type = 'debit' THEN t.amount::numeric
           WHEN t.type = 'credit' AND (
             t.description ILIKE '%remboursement%'
             OR t.description ILIKE '%refund%'
           ) THEN -t.amount::numeric
           ELSE 0
         END
       ), 0) AS total_spent
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       WHERE t.user_id = $1 AND b.client_id = $1`,
      [userId]
    );
    const total_spent = Number(spentResult.rows[0]?.total_spent ?? 0);

    // ── Payout breakdown ──────────────────────────────────────────────────────
    // Dispute window: 3 calendar days after completion
    // After 3 days with no open dispute → available for payout
    const disputeCutoff = getDisputeCutoffDate();

    // Available for payout: no open dispute AND (completed > 3 days ago OR dispute was closed)
    const availableResult = await pool.query(
      `SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       WHERE t.user_id = $1
         AND t.type = 'credit'
         AND b.worker_id = $1
         AND b.status = 'completed'
         AND b.payment_status = ANY($3::text[])
         AND EXISTS (
           SELECT 1 FROM payments p
           WHERE p.booking_id = b.id AND p.status IN ('paid', 'refunded')
         )
         AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status = 'open')
         AND (
           b.completed_at <= $2
           OR EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status IN ('resolved', 'rejected'))
         )`,
      [userId, disputeCutoff.toISOString(), WORKER_HOLD_PAYMENT_STATUSES]
    );

    // Pending: completed within last 3 days OR open dispute
    const pendingResult = await pool.query(
      `SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       WHERE t.user_id = $1
         AND t.type = 'credit'
         AND b.worker_id = $1
         AND b.status = 'completed'
         AND b.payment_status = ANY($3::text[])
         AND EXISTS (
           SELECT 1 FROM payments p
           WHERE p.booking_id = b.id AND p.status IN ('paid', 'refunded')
         )
         AND (
           (b.completed_at > $2 AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id))
           OR EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status = 'open')
         )`,
      [userId, disputeCutoff.toISOString(), WORKER_HOLD_PAYMENT_STATUSES]
    );

    const availableForPayout = Number(availableResult.rows[0]?.total ?? 0);
    const pendingAmount      = Number(pendingResult.rows[0]?.total ?? 0);
    // Credit transactions are already recorded at gross × WORKER_PAYOUT_SHARE (commission already deducted)
    // so net_payout = availableForPayout with no further deduction
    const nextPayoutDate     = getNextPayoutDate();

    res.json({
      ...wallet,
      total_earned,
      total_spent,
      available_for_payout: availableForPayout,
      pending_amount: pendingAmount,
      commission_amount: 0,
      net_payout: availableForPayout,
      next_payout_date: nextPayoutDate.toISOString(),
    });
  } catch (err) {
    console.error("getWallet error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/** Bookings in dispute window: worker earnings on hold + client dispute/refund eligibility */
export const getPendingDisputeDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const disputeCutoff = getDisputeCutoffDate();

    const workerHolds = await pool.query(
      `SELECT b.id AS booking_id,
              s.title AS listing_title,
              t.amount,
              b.completed_at,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS other_user_name,
              EXISTS (
                SELECT 1 FROM disputes d
                WHERE d.booking_id = b.id AND d.status = 'open'
              ) AS has_open_dispute
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       JOIN services s ON s.id = b.service_id
       JOIN users uc ON uc.id = b.client_id
       WHERE t.user_id = $1
         AND t.type = 'credit'
         AND b.worker_id = $1
         AND b.status = 'completed'
         AND b.payment_status = ANY($3::text[])
         AND EXISTS (
           SELECT 1 FROM payments p
           WHERE p.booking_id = b.id AND p.status IN ('paid', 'refunded')
         )
         AND (
           (b.completed_at > $2 AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id))
           OR EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status = 'open')
         )
       ORDER BY b.completed_at DESC`,
      [userId, disputeCutoff.toISOString(), WORKER_HOLD_PAYMENT_STATUSES],
    );

    const disputeEligible = await pool.query(
      `SELECT b.id AS booking_id,
              s.title AS listing_title,
              b.completed_at,
              CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS other_user_name,
              COALESCE((
                SELECT SUM(t.amount::numeric)
                FROM transactions t
                WHERE t.booking_id = b.id AND t.user_id = b.client_id AND t.type = 'debit'
              ), 0) AS amount_paid
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       JOIN users uw ON uw.id = b.worker_id
       WHERE b.client_id = $1
         AND b.status = 'completed'
         AND b.completed_at IS NOT NULL
         AND b.completed_at > $2
         AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id)
       ORDER BY b.completed_at DESC`,
      [userId, disputeCutoff.toISOString()],
    );

    res.json({
      worker_holds: workerHolds.rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
        has_open_dispute: Boolean(row.has_open_dispute),
      })),
      dispute_eligible: disputeEligible.rows.map((row) => ({
        ...row,
        amount_paid: Number(row.amount_paid),
      })),
    });
  } catch (err) {
    console.error("getPendingDisputeDetails error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/** Worker credits past dispute window — available for next payout */
export const getApprovedPayoutDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const disputeCutoff = getDisputeCutoffDate();

    const result = await pool.query(
      `SELECT b.id AS booking_id,
              s.title AS listing_title,
              t.amount,
              b.completed_at,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS other_user_name
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       JOIN services s ON s.id = b.service_id
       JOIN users uc ON uc.id = b.client_id
       WHERE t.user_id = $1
         AND t.type = 'credit'
         AND b.worker_id = $1
         AND b.status = 'completed'
         AND b.payment_status = ANY($3::text[])
         AND EXISTS (
           SELECT 1 FROM payments p
           WHERE p.booking_id = b.id AND p.status IN ('paid', 'refunded')
         )
         AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status = 'open')
         AND (
           b.completed_at <= $2
           OR EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status IN ('resolved', 'rejected'))
         )
       ORDER BY b.completed_at DESC`,
      [userId, disputeCutoff.toISOString(), WORKER_HOLD_PAYMENT_STATUSES],
    );

    res.json({
      items: result.rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
      })),
    });
  } catch (err) {
    console.error("getApprovedPayoutDetails error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/** Worker credits that make up total_earned */
export const getEarnedDetails = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT t.id,
              t.booking_id,
              t.type,
              t.amount,
              t.description,
              t.other_user_name,
              t.listing_title,
              t.created_at
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       WHERE t.user_id = $1 AND t.type = 'credit' AND b.worker_id = $1
       ORDER BY t.created_at DESC`,
      [userId],
    );

    res.json({
      items: result.rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
      })),
    });
  } catch (err) {
    console.error("getEarnedDetails error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/** Client debits (and refund credits) that make up total_spent */
export const getSpentDetails = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT t.id,
              t.booking_id,
              t.type,
              t.amount,
              t.description,
              t.other_user_name,
              t.listing_title,
              t.created_at
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       WHERE t.user_id = $1
         AND b.client_id = $1
         AND (
           t.type = 'debit'
           OR (
             t.type = 'credit'
             AND (
               t.description ILIKE '%remboursement%'
               OR t.description ILIKE '%refund%'
             )
           )
         )
       ORDER BY t.created_at DESC`,
      [userId],
    );

    res.json({
      items: result.rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
      })),
    });
  } catch (err) {
    console.error("getSpentDetails error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const period = req.query.period || "2weeks";
    const params = [userId];
    let dateFilter = "";

    if (period !== "all" && PERIOD_INTERVAL[period]) {
      dateFilter = `AND created_at >= NOW() - INTERVAL '${PERIOD_INTERVAL[period]}'`;
    }

    const result = await pool.query(
      `SELECT id, booking_id, type, amount, description, other_user_name, listing_title, created_at
       FROM transactions
       WHERE user_id = $1 ${dateFilter}
       ORDER BY created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getTransactions error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const exportTransactions = async (req, res) => {
  try {
    const period = req.query.period || "all";
    let dateFilter = "";

    if (period !== "all" && PERIOD_INTERVAL[period]) {
      dateFilter = `AND t.created_at >= NOW() - INTERVAL '${PERIOD_INTERVAL[period]}'`;
    }

    const result = await pool.query(
      `SELECT
         t.id                                                              AS "ID Transaction",
         TO_CHAR(t.created_at AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD') AS "Date",
         TO_CHAR(t.created_at AT TIME ZONE 'America/Toronto', 'HH24:MI:SS') AS "Heure",
         'CA'                                                              AS "Pays",
         COALESCE(uw.province, 'QC')                                      AS "Province",
         t.booking_id                                                      AS "ID Réservation",
         CASE t.type WHEN 'debit' THEN 'Paiement client' ELSE 'Crédit prestataire' END AS "Type",
         COALESCE(p.full_name, p.company_name, 'Unknown')                 AS "Utilisateur",
         t.other_user_name                                                 AS "Autre partie",
         t.listing_title                                                   AS "Titre du service",
         COALESCE(b.custom_price, b.price)                                  AS "Prix de base (CAD)",
         ROUND(COALESCE(b.custom_price, b.price) * 0.05, 2)              AS "Commission acheteur 5% (CAD)",
         COALESCE(b.tax_rate, 0.14975) * 100                              AS "Taux de taxes (%)",
         ROUND(COALESCE(b.custom_price, b.price) * COALESCE(b.tax_rate, 0.14975), 2) AS "Total taxes (CAD)",
         ROUND(COALESCE(b.custom_price, b.price) * (1 + 0.05 + COALESCE(b.tax_rate, 0.14975)), 2) AS "Total facturé au client (CAD)",
         ROUND(COALESCE(b.custom_price, b.price) * ${WORKER_COMMISSION_RATE}, 2)              AS "Commission plateforme ${WORKER_COMMISSION_RATE * 100}% (CAD)",
         ROUND(COALESCE(b.custom_price, b.price) * ${WORKER_PAYOUT_SHARE}, 2)              AS "Versement prestataire ${WORKER_PAYOUT_SHARE * 100}% (CAD)",
         t.amount                                                          AS "Montant transaction (CAD)",
         COALESCE(b.status, '—')                                          AS "Statut réservation"
       FROM transactions t
       LEFT JOIN users p ON p.id = t.user_id
       LEFT JOIN bookings b ON b.id = t.booking_id
       LEFT JOIN users uw ON uw.id = b.worker_id
       WHERE 1=1 ${dateFilter}
       ORDER BY t.created_at DESC`
    );

    const rows = result.rows;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Transactions");

    if (rows.length > 0) {
      const cols = Object.keys(rows[0]);
      const widths = [38,12,10,6,9,38,22,24,24,28,18,24,16,16,26,28,30,22,20];
      ws.columns = cols.map((header, i) => ({ header, key: header, width: widths[i] ?? 20 }));
      ws.getRow(1).font = { bold: true };
      rows.forEach((row) => ws.addRow(row));
    }

    const filename = `transactions_${period}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("exportTransactions error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getPayoutDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const { date } = req.query;
    if (!date) return res.status(400).json({ message: "date required" });

    // Find credit transactions created within ±12 hours of the payout debit date
    const from = new Date(new Date(date).getTime() - 12 * 60 * 60 * 1000);
    const to   = new Date(new Date(date).getTime() + 12 * 60 * 60 * 1000);

    const result = await pool.query(
      `SELECT b.id AS booking_id, s.title, COALESCE(b.custom_price, s.price) AS base_price,
              t.amount AS worker_amount
       FROM transactions t
       JOIN bookings b ON b.id = t.booking_id
       JOIN services s ON s.id = b.service_id
       JOIN payments p ON p.booking_id = b.id AND p.status = 'transferred'
       WHERE t.user_id = $1
         AND t.type = 'credit'
         AND b.worker_id = $1
         AND b.status = 'completed'
         AND b.payment_status = 'transferred'
         AND p.updated_at BETWEEN $2 AND $3`,
      [userId, from.toISOString(), to.toISOString()]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getPayoutDetails error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const triggerPayout = async (req, res) => {
  try {
    await processAllPayouts();

    await logAdminAction({
      adminId:    req.user.id,
      adminEmail: req.user.email,
      action:     "payout.trigger",
      targetType: "payout",
      details:    { triggered_at: new Date().toISOString() },
      ipAddress:  req.ip,
    });

    res.json({ success: true, message: "Payout run completed" });
  } catch (err) {
    console.error("triggerPayout error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Payout run called by the scheduled GitHub workflow (payouts.yml). Render's
 * free instance sleeps when idle, so the in-process Friday cron rarely fires;
 * this request wakes it up. Authenticated by the CRON_SECRET shared secret,
 * and only pays out on bi-weekly payout Fridays.
 */
export const runScheduledPayout = async (req, res) => {
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const valid =
    secret.length >= 32 &&
    provided.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  if (!valid) return res.status(401).json({ message: "Unauthorized" });

  if (!isPayoutDay(new Date())) {
    return res.json({ skipped: true, reason: "Not a payout day" });
  }
  try {
    const result = await processAllPayouts();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("runScheduledPayout error:", err);
    res.status(500).json({ message: "Payout run failed" });
  }
};

// ─── Platform earnings summary (admin only) ───────────────────────────────────
export const getPlatformEarnings = async (req, res) => {
  try {
    const { period } = req.query; // e.g. "7days", "30days", "alltime"

    const intervalMap = {
      "7days":   "7 days",
      "30days":  "30 days",
      "90days":  "90 days",
      "1year":   "1 year",
      "alltime": null,
    };

    const interval = intervalMap[period] ?? null;
    const dateFilter = interval
      ? `AND created_at >= NOW() - INTERVAL '${interval}'`
      : "";

    const totals = await pool.query(
      `SELECT
         type,
         COALESCE(SUM(amount), 0) AS total,
         COUNT(*) AS count
       FROM platform_earnings
       WHERE 1=1 ${dateFilter}
       GROUP BY type`
    );

    const summary = { buyer_commission: 0, worker_commission: 0, total: 0, count: 0 };
    for (const row of totals.rows) {
      const amt = Number(row.total);
      summary[row.type] = amt;
      summary.total += amt;
      summary.count += Number(row.count);
    }
    summary.buyer_commission  = Number(summary.buyer_commission.toFixed(2));
    summary.worker_commission = Number(summary.worker_commission.toFixed(2));
    summary.total             = Number(summary.total.toFixed(2));

    // Recent earnings rows
    const recent = await pool.query(
      `SELECT pe.id, pe.booking_id, pe.type, pe.amount, pe.description, pe.created_at
       FROM platform_earnings pe
       ORDER BY pe.created_at DESC
       LIMIT 100`
    );

    res.json({ summary, entries: recent.rows });
  } catch (err) {
    console.error("getPlatformEarnings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
