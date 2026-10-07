import crypto from "crypto";
import { normalizePricingMode } from "./servicePricing.js";

/** Same cap as listing prices (servicePricing.js). */
export const MAX_FIXED_DEPOSIT = 1_000_000;

let schemaReady = false;
/** Single in-flight migration — avoids concurrent ALTER TABLE deadlocks with read queries. */
let schemaInitPromise = null;

export async function ensureDepositsAndCalendarSchema(pool) {
  if (schemaReady) return;
  if (!schemaInitPromise) {
    schemaInitPromise = pool
      .query(`
    ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_type varchar(16);
    ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_value numeric(10, 2);
    ALTER TABLE services ADD COLUMN IF NOT EXISTS estimated_hours numeric(8, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_amount_cents integer NOT NULL DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_enabled boolean;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_type varchar(16);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_value numeric(10, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_hours numeric(8, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pricing_mode varchar(16);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS approved_hours_total numeric(10, 2) NOT NULL DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_service_base_cents integer NOT NULL DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due_cents integer NOT NULL DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_confirmed_by_client_at timestamptz;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_confirmed_by_worker_at timestamptz;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_proposed_price numeric(10, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS worker_proposed_price numeric(10, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_selected_by_client numeric(10, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_selected_by_worker numeric(10, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_selected_source_by_client varchar(16);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_selected_source_by_worker varchar(16);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS custom_price_min numeric(10, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS custom_price_max numeric(10, 2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_province varchar(16);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS deposit_amount_cents integer NOT NULL DEFAULT 0;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_kind varchar(16) NOT NULL DEFAULT 'full';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_ics_token varchar(64) UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_calendar_refresh_token text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_calendar_access_token text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_calendar_token_expiry timestamptz;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_event_id varchar(256);
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS confirmed_by_client boolean NOT NULL DEFAULT false;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS confirmed_by_worker boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS calendar_event_google_sync (
      calendar_event_id uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      google_event_id varchar(256) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (calendar_event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      title varchar(300) NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      location text,
      notes text,
      status varchar(20) NOT NULL DEFAULT 'scheduled',
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_events_booking ON calendar_events (booking_id);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_starts ON calendar_events (starts_at);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_service ON calendar_events (service_id);
    CREATE TABLE IF NOT EXISTS work_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      calendar_event_id uuid REFERENCES calendar_events(id) ON DELETE SET NULL,
      title varchar(300) NOT NULL DEFAULT 'Session',
      starts_at timestamptz,
      ends_at timestamptz,
      hours_worker numeric(8, 2),
      hours_client numeric(8, 2),
      hours_final numeric(8, 2),
      status varchar(32) NOT NULL DEFAULT 'scheduled',
      worker_note text,
      client_note text,
      last_actor uuid REFERENCES users(id),
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_work_sessions_booking ON work_sessions (booking_id);
    CREATE INDEX IF NOT EXISTS idx_work_sessions_status ON work_sessions (status);
  `)
      .then(() => {
        schemaReady = true;
      })
      .catch((err) => {
        schemaInitPromise = null;
        throw err;
      });
  }
  await schemaInitPromise;
}

/**
 * Merge nullable booking deposit overrides with listing defaults.
 * @param {Record<string, unknown>} row
 */
export function resolveBookingDepositMeta(row) {
  const serviceEnabled = row.service_deposit_enabled ?? row.s_deposit_enabled;
  const serviceType = row.service_deposit_type ?? null;
  const serviceValue =
    row.service_deposit_value != null ? Number(row.service_deposit_value) : null;

  const bookingType = row.deposit_type ?? null;
  const bookingValue = row.deposit_value != null ? Number(row.deposit_value) : null;
  const hasBookingOverride =
    bookingType != null &&
    bookingValue != null &&
    Number.isFinite(bookingValue) &&
    bookingValue > 0;

  // Looking listings: poster is the payer. Listing-level deposit never applies.
  // Booking overrides (worker-set during customize / negotiation) still can.
  const listingType = row.service_type ?? row.type ?? null;
  if (listingType === "looking") {
    if (hasBookingOverride) {
      return {
        deposit_enabled: row.deposit_enabled !== false,
        deposit_type: bookingType,
        deposit_value: bookingValue,
      };
    }
    return {
      deposit_enabled: false,
      deposit_type: null,
      deposit_value: null,
    };
  }

  if (hasBookingOverride) {
    return {
      deposit_enabled: row.deposit_enabled !== false,
      deposit_type: bookingType,
      deposit_value: bookingValue,
    };
  }

  const mode = normalizePricingMode(row.pricing_mode ?? row.service_pricing_mode);
  if (mode === "quote") {
    return {
      deposit_enabled: false,
      deposit_type: null,
      deposit_value: null,
    };
  }

  return {
    deposit_enabled: !!serviceEnabled,
    deposit_type: serviceType,
    deposit_value:
      serviceValue != null && Number.isFinite(serviceValue) ? serviceValue : null,
  };
}

/**
 * Base amount (CAD) used for deposit calculation and payment totals.
 * @param {Record<string, unknown>} service
 * @param {Record<string, unknown> | null} [booking]
 */
export function resolveDepositBaseAmount(service, booking = null) {
  const mode = normalizePricingMode(service.pricing_mode);
  const custom = booking?.custom_price != null ? Number(booking.custom_price) : null;

  if (mode === "quote") {
    if (custom != null && Number.isFinite(custom) && custom >= 0.01) return custom;
    const sp = service.price != null ? Number(service.price) : null;
    if (sp != null && Number.isFinite(sp) && sp >= 0.01) return sp;
    return null;
  }

  if (mode === "range") {
    if (custom != null && Number.isFinite(custom) && custom >= 0.01) return custom;
    const customMax = booking?.custom_price_max != null ? Number(booking.custom_price_max) : null;
    if (customMax != null && Number.isFinite(customMax) && customMax >= 0.01) return customMax;
    const hi = Number(service.price_max ?? service.price);
    if (Number.isFinite(hi) && hi >= 0.01) return hi;
    return null;
  }

  if (mode === "hourly") {
    const rate = Number(service.price);
    if (!Number.isFinite(rate) || rate < 0.01) return null;
    const hours = Number(
      booking?.estimated_hours ?? service.estimated_hours ?? 1,
    );
    const h = Number.isFinite(hours) && hours > 0 ? hours : 1;
    return Math.round(rate * h * 100) / 100;
  }

  const p = custom != null && Number.isFinite(custom) ? custom : Number(service.price);
  return Number.isFinite(p) && p >= 0.01 ? p : null;
}

/** Checkout / billing base before buyer fee and taxes. */
export function resolveCheckoutBaseAmount(service, booking = null) {
  return resolveDepositBaseAmount(service, booking);
}

/**
 * @param {number} servicePrice dollars
 * @param {{ deposit_enabled?: boolean, deposit_type?: string | null, deposit_value?: number | string | null }} service
 * @returns {number} deposit in dollars (0 if none)
 */
export function calculateDepositAmount(servicePrice, service) {
  if (!service?.deposit_enabled) return 0;
  const price = Number(servicePrice);
  if (!Number.isFinite(price) || price < 0.01) return 0;

  const type = service.deposit_type;
  const raw = Number(service.deposit_value);
  if (!type || !Number.isFinite(raw) || raw <= 0) return 0;

  let deposit = type === "percent" ? price * (raw / 100) : raw;
  deposit = Math.min(deposit, price);
  deposit = Math.max(0, deposit);
  return Math.round(deposit * 100) / 100;
}

/**
 * Validates worker/client deposit config against an agreed or proposed price (quote negotiation).
 * @param {number} price
 * @param {string | null | undefined} depositType
 * @param {number | string | null | undefined} depositValue
 * @returns {{ error: string | null }}
 */
export function validateDepositAgainstPrice(price, depositType, depositValue) {
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0.01) {
    return { error: "Invalid price" };
  }
  if (!depositType || depositValue == null || Number(depositValue) <= 0) {
    return { error: null };
  }
  const raw = Number(depositValue);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { error: "Invalid deposit value" };
  }
  if (depositType === "percent") {
    if (raw > 100) return { error: "Deposit percent cannot exceed 100" };
    return { error: null };
  }
  if (depositType === "fixed") {
    if (raw > p) return { error: "Deposit cannot exceed the agreed price" };
    return { error: null };
  }
  return { error: "Invalid deposit type" };
}

/**
 * @param {unknown} body
 * @param {number | null} servicePrice for validation
 * @param {string} [pricingMode]
 */
export function parseDepositFields(body, servicePrice = null, pricingMode = "fixed") {
  const enabled =
    body.deposit_enabled === true ||
    body.deposit_enabled === "true" ||
    body.depositEnabled === true ||
    body.depositEnabled === "true";

  if (!enabled) {
    return { deposit_enabled: false, deposit_type: null, deposit_value: null, error: null };
  }

  const type = body.deposit_type ?? body.depositType ?? null;
  if (type !== "fixed" && type !== "percent") {
    return { error: "Invalid deposit type" };
  }

  const value = Number(body.deposit_value ?? body.depositValue);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: "Invalid deposit value" };
  }
  if (type === "percent" && (value <= 0 || value >= 100)) {
    return { error: "Deposit percentage must be between 1 and 99" };
  }
  // Quote listings have no price to bound the deposit; deposit_value is numeric(10,2).
  if (type === "fixed" && value > MAX_FIXED_DEPOSIT) {
    return { error: "Deposit too high" };
  }

  const mode = normalizePricingMode(pricingMode);
  if (mode === "quote" && (servicePrice == null || !Number.isFinite(servicePrice))) {
    return {
      deposit_enabled: true,
      deposit_type: type,
      deposit_value: type === "percent" ? value : Math.round(value * 100) / 100,
      error: null,
    };
  }

  if (servicePrice != null && Number.isFinite(servicePrice) && servicePrice >= 0.01) {
    const deposit = calculateDepositAmount(servicePrice, {
      deposit_enabled: true,
      deposit_type: type,
      deposit_value: value,
    });
    if (deposit < 0.01) {
      return { error: "Deposit must be less than the service price" };
    }
  }

  return {
    deposit_enabled: true,
    deposit_type: type,
    deposit_value: type === "percent" ? value : Math.round(value * 100) / 100,
    error: null,
  };
}

export async function ensureUserCalendarToken(pool, userId) {
  const existing = await pool.query(
    "SELECT calendar_ics_token FROM users WHERE id = $1",
    [userId],
  );
  if (existing.rows[0]?.calendar_ics_token) {
    return existing.rows[0].calendar_ics_token;
  }
  const token = crypto.randomBytes(24).toString("hex");
  await pool.query("UPDATE users SET calendar_ics_token = $1 WHERE id = $2", [token, userId]);
  return token;
}

export async function findUserIdByCalendarToken(pool, token) {
  if (!token) return null;
  const result = await pool.query(
    "SELECT id FROM users WHERE calendar_ics_token = $1",
    [token],
  );
  return result.rows[0]?.id ?? null;
}
