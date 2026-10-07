/**
 * Clés canoniques pour services.availability et services.mobility (anglais stable).
 * Libellés FR/UNIQUEMENT via i18n frontend.
 */

import { normalizePricingMode } from "./servicePricing.js";
import { normalizeDurationForStorage } from "./serviceDuration.js";

function foldAscii(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normToken(s) {
  return foldAscii(s)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string | null | undefined} raw */
export function normalizeAvailability(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const k = normToken(trimmed);

  const map = {
    anytime: "anytime",
    "any time": "anytime",
    weekends: "weekends",
    weekend: "weekends",
    "week ends": "weekends",
    "week end": "weekends",
    weekds: "weekends",
    weekdays: "weekdays",
    weekday: "weekdays",
    "week days": "weekdays",
    evenings: "evenings",
    evening: "evenings",
    soirs: "evenings",
    soir: "evenings",
    flexible: "flexible",
    souple: "flexible",
  };

  if (map[k]) return map[k];

  const direct = ["anytime", "weekends", "weekdays", "evenings", "flexible"];
  if (direct.includes(k)) return k;

  return trimmed;
}

/** @param {string | null | undefined} raw */
export function normalizeMobility(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const k = normToken(trimmed);

  const map = {
    yes: "yes",
    no: "no",
    limited: "limited",
    city: "city",
    ville: "city",
    regional: "regional",
  };

  if (map[k]) return map[k];

  if (k === "en ville" || k === "in city") return "city";

  const direct = ["yes", "no", "limited", "city", "regional"];
  if (direct.includes(k)) return k;

  return trimmed;
}

/** Sizes of the bounded varchar columns of services (supabase/migrations). */
export const SERVICE_TEXT_LIMITS = {
  poster_type: 20,
  availability: 50,
  language: 50,
  mobility: 50,
  urgency: 50,
  duration: 100,
};

/**
 * Error message for the first value (as it will be stored) too long for its
 * column, so the API answers 400 instead of failing the INSERT with a 500.
 * @param {Record<string, unknown>} values
 * @returns {string | null}
 */
export function serviceTextLengthError(values) {
  for (const [field, max] of Object.entries(SERVICE_TEXT_LIMITS)) {
    const value = values[field];
    if (value != null && String(value).length > max) {
      return `${field} must be at most ${max} characters`;
    }
  }
  return null;
}

/**
 * Harmonise les champs sur une ligne service (réponses API).
 * @param {Record<string, unknown>} row
 */
export function canonServiceFieldsInPlace(row) {
  if (!row || typeof row !== "object") return row;
  if ("availability" in row) row.availability = normalizeAvailability(row.availability);
  if ("mobility" in row) row.mobility = normalizeMobility(row.mobility);
  if ("duration" in row) row.duration = normalizeDurationForStorage(row.duration);
  if ("pricing_mode" in row) row.pricing_mode = normalizePricingMode(row.pricing_mode);
  else row.pricing_mode = "fixed";
  return row;
}
