import { sanitizeText } from "./validate.js";
import { normalizeProvinceCode } from "./taxProvince.js";

/** Column sizes of billing_addresses (supabase/migrations). */
export const BILLING_ADDRESS_LIMITS = {
  label: 50,
  full_name: 255,
  address_line1: 255,
  city: 100,
  postal_code: 10,
};

const CA_POSTAL_CODE = /^[A-Z]\d[A-Z] \d[A-Z]\d$/;

/** "h2x1y4" → "H2X 1Y4"; null when empty. */
export function normalizePostalCode(postalCode) {
  if (!postalCode) return null;
  const compact = String(postalCode).replace(/\s+/g, "").toUpperCase().slice(0, 6);
  if (!compact) return null;
  return compact.length > 3 ? `${compact.slice(0, 3)} ${compact.slice(3)}` : compact;
}

function cleanText(value) {
  if (value === undefined || value === null) return value;
  return sanitizeText(String(value)).trim();
}

/**
 * Validates a billing address body and returns the values to store, so a bad
 * input is a 400 instead of a constraint violation (500).
 * With `partial`, only the fields present are checked and returned (updates).
 * @returns {{ error: string | null, data: Record<string, string | null> }}
 */
export function validateBillingAddressInput(body, { partial = false } = {}) {
  const data = {};
  const has = (field) => body[field] !== undefined && body[field] !== null;

  for (const field of ["label", "full_name", "address_line1", "city"]) {
    if (!has(field)) continue;
    const value = cleanText(body[field]);
    if (value.length > BILLING_ADDRESS_LIMITS[field]) {
      return { error: `${field} must be at most ${BILLING_ADDRESS_LIMITS[field]} characters`, data: {} };
    }
    data[field] = field === "label" || field === "full_name" ? value || null : value;
  }

  if (has("province")) {
    const code = normalizeProvinceCode(body.province);
    if (!code) return { error: "Invalid province", data: {} };
    data.province = code;
  }

  if (has("postal_code")) {
    const postal = normalizePostalCode(body.postal_code);
    if (!postal || !CA_POSTAL_CODE.test(postal)) {
      return { error: "Invalid postal code", data: {} };
    }
    data.postal_code = postal;
  }

  if (!partial) {
    for (const field of ["address_line1", "city", "province", "postal_code"]) {
      if (!data[field]) return { error: `${field} is required`, data: {} };
    }
  } else {
    for (const field of ["address_line1", "city"]) {
      if (data[field] === "") return { error: `${field} cannot be empty`, data: {} };
    }
  }

  return { error: null, data };
}

/**
 * Normalized values of the fields that fit billing_addresses, dropping the
 * others (unknown province, over-long city…). For syncing from the profile,
 * where a bad value must not make the whole profile save fail.
 */
export function pickValidBillingFields(fields) {
  const out = {};
  for (const [field, value] of Object.entries(fields)) {
    const { error, data } = validateBillingAddressInput({ [field]: value }, { partial: true });
    if (!error && data[field]) out[field] = data[field];
  }
  return out;
}
