const PROVINCE_TAX_RATES = {
  AB: 0.05, BC: 0.12, MB: 0.12, NB: 0.15, NL: 0.15, NS: 0.15,
  NT: 0.05, NU: 0.05, ON: 0.13, PE: 0.15, QC: 0.14975, SK: 0.11, YT: 0.05,
};

/** Keys are folded with foldProvinceName (no accents, hyphens → spaces). */
const PROVINCE_NAME_TO_CODE = {
  alberta: "AB",
  "british columbia": "BC",
  "colombie britannique": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  "nouveau brunswick": "NB",
  "newfoundland and labrador": "NL",
  "terre neuve et labrador": "NL",
  newfoundland: "NL",
  "nova scotia": "NS",
  "nouvelle ecosse": "NS",
  "northwest territories": "NT",
  "territoires du nord ouest": "NT",
  nunavut: "NU",
  ontario: "ON",
  "prince edward island": "PE",
  "ile du prince edouard": "PE",
  quebec: "QC",
  saskatchewan: "SK",
  yukon: "YT",
};

function foldProvinceName(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s.-]+/g, " ")
    .trim();
}

/**
 * Two-letter province code ("QC") from a code or an English/French name, or
 * null when unrecognised. Callers store the result in char(2) columns
 * (billing_addresses.province, bookings.client_province), so never return
 * anything else.
 */
export function normalizeProvinceCode(province) {
  if (!province) return null;
  const upper = String(province).trim().toUpperCase();
  if (PROVINCE_TAX_RATES[upper] !== undefined) return upper;
  return PROVINCE_NAME_TO_CODE[foldProvinceName(province)] ?? null;
}

export function getTaxRateForProvince(province) {
  if (!province) return PROVINCE_TAX_RATES.QC;
  const code = normalizeProvinceCode(province);
  return PROVINCE_TAX_RATES[code ?? "QC"] ?? PROVINCE_TAX_RATES.QC;
}

/** Province used for buyer taxes: default billing address, then profile province. */
export async function resolveClientTaxProvince(pool, clientId) {
  const billing = await pool.query(
    `SELECT province FROM billing_addresses
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at ASC
     LIMIT 1`,
    [clientId],
  );
  if (billing.rows[0]?.province) {
    return normalizeProvinceCode(billing.rows[0].province);
  }
  const clientResult = await pool.query("SELECT province FROM users WHERE id = $1", [clientId]);
  return normalizeProvinceCode(clientResult.rows[0]?.province ?? null);
}

function hasTaxLocationText(value) {
  return Boolean(value && String(value).trim());
}

/** Buyer needs street, city, province, postal code (profile or billing) before booking an offer. */
export async function isClientTaxLocationComplete(pool, clientId) {
  const billing = await pool.query(
    `SELECT address_line1, city, province, postal_code
     FROM billing_addresses
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at ASC
     LIMIT 1`,
    [clientId],
  );
  const b = billing.rows[0];
  if (
    b &&
    hasTaxLocationText(b.address_line1) &&
    hasTaxLocationText(b.city) &&
    hasTaxLocationText(b.province) &&
    hasTaxLocationText(b.postal_code)
  ) {
    return true;
  }

  const user = await pool.query(
    `SELECT address, city, province, postal_code FROM users WHERE id = $1`,
    [clientId],
  );
  const u = user.rows[0];
  return Boolean(
    u &&
    hasTaxLocationText(u.address) &&
    hasTaxLocationText(u.city) &&
    hasTaxLocationText(u.province) &&
    hasTaxLocationText(u.postal_code),
  );
}

/** SQL fragment: billing province first, then users.province (alias `u` required). */
export const CLIENT_TAX_PROVINCE_SQL = `
  COALESCE(
    (SELECT ba.province FROM billing_addresses ba
     WHERE ba.user_id = u.id
     ORDER BY ba.is_default DESC, ba.created_at ASC
     LIMIT 1),
    u.province
  )`;
