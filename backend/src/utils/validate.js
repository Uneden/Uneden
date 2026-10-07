/**
 * Centralized input validation & sanitization utilities
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip all HTML tags from a string */
export function stripHtml(str) {
  if (typeof str !== "string") return str;
  // Same result as str.replace(/<[^>]*>/g, ""), but linear: that regex
  // backtracks quadratically on input like "<<<<…" (ReDoS, CodeQL
  // js/polynomial-redos). A "<" with no ">" after it is kept, as before.
  let out = "";
  let i = 0;
  while (i < str.length) {
    const open = str.indexOf("<", i);
    if (open === -1) break;
    const close = str.indexOf(">", open + 1);
    if (close === -1) break;
    out += str.slice(i, open);
    i = close + 1;
  }
  return (out + str.slice(i)).trim();
}

/** Sanitize a plain-text field — strip HTML and trim */
export function sanitizeText(value) {
  if (value === null || value === undefined) return value;
  return stripHtml(String(value));
}

/** Validate UUID format */
export function isValidUUID(value) {
  return typeof value === "string" && UUID_REGEX.test(value);
}

/** Validate string length */
export function maxLength(value, max) {
  return typeof value !== "string" || value.length <= max;
}

/**
 * Validate and sanitize a set of fields.
 * Returns { errors: string[] | null, data: sanitized fields }
 *
 * Rules format:
 *   { fieldName: { required?, maxLen?, type?, enum? } }
 */
export function validateInput(body, rules) {
  const errors = [];
  const data = {};

  for (const [field, rule] of Object.entries(rules)) {
    let value = body[field];

    // Required check
    if (rule.required && (value === undefined || value === null || value === "")) {
      errors.push(`${field} is required`);
      continue;
    }

    // Skip further checks if not provided and not required
    if (value === undefined || value === null) {
      data[field] = value;
      continue;
    }

    // Type: string
    if (rule.type === "string") {
      value = sanitizeText(value);
      if (rule.maxLen && value.length > rule.maxLen) {
        errors.push(`${field} must be at most ${rule.maxLen} characters`);
        continue;
      }
    }

    // Type: number
    if (rule.type === "number") {
      value = Number(value);
      if (isNaN(value)) {
        errors.push(`${field} must be a number`);
        continue;
      }
      if (rule.min !== undefined && value < rule.min) {
        errors.push(`${field} must be at least ${rule.min}`);
        continue;
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(`${field} must be at most ${rule.max}`);
        continue;
      }
    }

    // Type: uuid
    if (rule.type === "uuid") {
      if (!isValidUUID(value)) {
        errors.push(`${field} must be a valid UUID`);
        continue;
      }
    }

    // Enum check
    if (rule.enum && !rule.enum.includes(value)) {
      errors.push(`${field} must be one of: ${rule.enum.join(", ")}`);
      continue;
    }

    data[field] = value;
  }

  return {
    errors: errors.length > 0 ? errors : null,
    data,
  };
}
