import pool from "../config/db.js";
import { WORKER_PAYOUT_SHARE } from "../utils/commissionRates.js";

export const LEDGER_ENTRY_TYPES = {
  CLIENT_PAYMENT: "client_payment",
  BUYER_COMMISSION: "buyer_commission",
  TAX_COLLECTED: "tax_collected",
  WORKER_PAYABLE: "worker_payable",
  WORKER_PAYOUT: "worker_payout",
  WORKER_COMMISSION: "worker_commission",
  REFUND: "refund",
};

let schemaReady = false;

export async function ensureLedgerSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id        UUID REFERENCES bookings(id) ON DELETE SET NULL,
      user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
      entry_type        TEXT NOT NULL CHECK (entry_type IN (
        'client_payment',
        'buyer_commission',
        'tax_collected',
        'worker_payable',
        'worker_payout',
        'worker_commission',
        'refund'
      )),
      amount_cents      BIGINT NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'cad',
      stripe_object_id  TEXT,
      stripe_object_type TEXT,
      description       TEXT,
      metadata          JSONB NOT NULL DEFAULT '{}',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_stripe_unique
      ON ledger_entries (stripe_object_id, entry_type)
      WHERE stripe_object_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ledger_entries_booking_idx ON ledger_entries (booking_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ledger_entries_type_idx ON ledger_entries (entry_type)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ledger_entries_created_idx ON ledger_entries (created_at)
  `);
  schemaReady = true;
}

/**
 * Record a ledger entry. Positive amount_cents = inflow to platform; negative = outflow.
 * Idempotent when stripe_object_id + entry_type are provided.
 */
export async function recordLedgerEntry({
  bookingId = null,
  userId = null,
  entryType,
  amountCents,
  currency = "cad",
  stripeObjectId = null,
  stripeObjectType = null,
  description = null,
  metadata = {},
}, db = pool) {
  await ensureLedgerSchema();
  if (!entryType || !Number.isFinite(amountCents) || amountCents === 0) return null;

  if (stripeObjectId) {
    const existing = await db.query(
      `SELECT id FROM ledger_entries
       WHERE stripe_object_id = $1 AND entry_type = $2`,
      [stripeObjectId, entryType],
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
  }

  // ON CONFLICT: two concurrent deliveries of the same Stripe event both
  // passing the SELECT above must not make the second one fail.
  const result = await db.query(
    `INSERT INTO ledger_entries
       (booking_id, user_id, entry_type, amount_cents, currency,
        stripe_object_id, stripe_object_type, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (stripe_object_id, entry_type) WHERE stripe_object_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      bookingId,
      userId,
      entryType,
      Math.round(amountCents),
      currency,
      stripeObjectId,
      stripeObjectType,
      description,
      JSON.stringify(metadata ?? {}),
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function recordClientPaymentLedger({
  bookingId,
  clientId,
  paymentIntentId,
  totalCents,
  servicePriceCents,
  buyerCommissionCents,
  taxesCents,
  paymentKind,
  title,
}, db = pool) {
  const baseId = paymentIntentId || `booking-${bookingId}`;
  await recordLedgerEntry({
    bookingId,
    userId: clientId,
    entryType: LEDGER_ENTRY_TYPES.CLIENT_PAYMENT,
    amountCents: totalCents,
    stripeObjectId: `${baseId}:client_payment`,
    stripeObjectType: "payment_intent",
    description: `Paiement client — ${title}`,
    metadata: { payment_kind: paymentKind, service_price_cents: servicePriceCents },
  }, db);

  if (buyerCommissionCents > 0) {
    await recordLedgerEntry({
      bookingId,
      userId: clientId,
      entryType: LEDGER_ENTRY_TYPES.BUYER_COMMISSION,
      amountCents: buyerCommissionCents,
      stripeObjectId: `${baseId}:buyer_commission`,
      stripeObjectType: "payment_intent",
      description: `Commission acheteur — ${title}`,
      metadata: { payment_kind: paymentKind },
    }, db);
  }

  if (taxesCents > 0) {
    await recordLedgerEntry({
      bookingId,
      userId: clientId,
      entryType: LEDGER_ENTRY_TYPES.TAX_COLLECTED,
      amountCents: taxesCents,
      stripeObjectId: `${baseId}:tax_collected`,
      stripeObjectType: "payment_intent",
      description: `Taxes collectées — ${title}`,
      metadata: { payment_kind: paymentKind },
    }, db);
  }

  if (servicePriceCents > 0 && paymentKind !== "deposit") {
    const workerPayableCents = Math.round(servicePriceCents * WORKER_PAYOUT_SHARE);
    await recordLedgerEntry({
      bookingId,
      entryType: LEDGER_ENTRY_TYPES.WORKER_PAYABLE,
      amountCents: -workerPayableCents,
      stripeObjectId: `${baseId}:worker_payable`,
      stripeObjectType: "payment_intent",
      description: `Passif travailleur (95%) — ${title}`,
      metadata: { service_price_cents: servicePriceCents },
    }, db);
  }
}

export async function recordWorkerPayoutLedger({
  bookingId,
  workerId,
  transferId,
  transferCents,
  workerCommissionCents,
  description,
}, db = pool) {
  await recordLedgerEntry({
    bookingId,
    userId: workerId,
    entryType: LEDGER_ENTRY_TYPES.WORKER_PAYOUT,
    amountCents: -transferCents,
    stripeObjectId: transferId,
    stripeObjectType: "transfer",
    description,
  }, db);

  if (workerCommissionCents > 0) {
    await recordLedgerEntry({
      bookingId,
      userId: workerId,
      entryType: LEDGER_ENTRY_TYPES.WORKER_COMMISSION,
      amountCents: workerCommissionCents,
      stripeObjectId: `${transferId}:worker_commission`,
      stripeObjectType: "transfer",
      description: `Commission vendeur au versement`,
    }, db);
  }
}

export async function getLedgerReconciliation({ from, to } = {}) {
  await ensureLedgerSchema();
  const params = [];
  const conditions = [];
  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const summary = await pool.query(
    `SELECT entry_type,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
     FROM ledger_entries
     ${where}
     GROUP BY entry_type
     ORDER BY entry_type`,
    params,
  );

  const platformEarnings = await pool.query(
    `SELECT type, COALESCE(SUM(amount::numeric), 0) AS total
     FROM platform_earnings
     ${from || to ? `WHERE created_at >= COALESCE($1::timestamptz, '-infinity')
                    AND created_at <= COALESCE($2::timestamptz, 'infinity')` : ""}
     GROUP BY type`,
    from || to ? [from ?? null, to ?? null] : [],
  );

  const inflow = summary.rows
    .filter((r) => Number(r.total_cents) > 0)
    .reduce((s, r) => s + Number(r.total_cents), 0);
  const outflow = summary.rows
    .filter((r) => Number(r.total_cents) < 0)
    .reduce((s, r) => s + Math.abs(Number(r.total_cents)), 0);

  return {
    period: { from: from ?? null, to: to ?? null },
    ledger_by_type: summary.rows,
    platform_earnings: platformEarnings.rows,
    totals: {
      ledger_inflow_cents: inflow,
      ledger_outflow_cents: outflow,
      ledger_net_cents: inflow - outflow,
    },
  };
}
