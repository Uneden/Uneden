/**
 * Modes tarifaires pour les annonces (services.price + price_min/max + pricing_mode).
 */
export const PRICING_MODES = ["fixed", "range", "quote", "hourly"];

/** Same cap as booking updates; services.estimated_hours is numeric(8,2). */
export const MAX_ESTIMATED_HOURS = 1000;

/**
 * @param {unknown} raw
 * @returns {"fixed"|"range"|"quote"}
 */
export function normalizePricingMode(raw) {
  const s = raw === null || raw === undefined ? "fixed" : String(raw).toLowerCase().trim();
  if (s === "range" || s === "quote" || s === "hourly") return s;
  return "fixed";
}

/**
 * Valide le corps create/update et retourne les champs DB ou { error: string }.
 * @param {Record<string, unknown>} body
 * @param {{ isCreate: boolean, existing?: Record<string, unknown> | null }} opts
 */
export function resolveServicePricingFields(body, opts) {
  const { isCreate, existing } = opts;
  const mode = normalizePricingMode(body.pricing_mode ?? body.pricingMode);

  const num = (v) => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };

  const priceIn = num(body.price);
  const priceMinIn = num(body.price_min ?? body.priceMin);
  const priceMaxIn = num(body.price_max ?? body.priceMax);

  if (mode === "fixed") {
    const p = priceIn;
    if (p === undefined || Number.isNaN(p) || p < 0.01) {
      return { error: "Price must be at least $0.01" };
    }
    if (p > 1_000_000) return { error: "Price too high" };
    return {
      pricing_mode: "fixed",
      price: p,
      price_min: p,
      price_max: p,
    };
  }

  if (mode === "range") {
    const lo = priceMinIn !== undefined ? priceMinIn : priceIn;
    const hi = priceMaxIn;
    if (lo === undefined || Number.isNaN(lo) || lo < 0.01) {
      return { error: "Minimum price must be at least $0.01" };
    }
    if (hi === undefined || Number.isNaN(hi)) {
      return { error: "Maximum price is required for a price range" };
    }
    if (hi < lo) return { error: "Maximum price must be greater than or equal to minimum" };
    if (hi > 1_000_000) return { error: "Price too high" };
    /** `price` = borne basse pour tris et filtres */
    return {
      pricing_mode: "range",
      price: lo,
      price_min: lo,
      price_max: hi,
    };
  }

  /** quote — prix après accord (custom_price sur réservation) */
  if (mode === "quote") {
    return {
      pricing_mode: "quote",
      price: null,
      price_min: null,
      price_max: null,
    };
  }

  if (mode === "hourly") {
    const rate = priceIn;
    if (rate === undefined || Number.isNaN(rate) || rate < 0.01) {
      return { error: "Hourly rate must be at least $0.01" };
    }
    if (rate > 1_000_000) return { error: "Hourly rate too high" };
    const estHours = num(body.estimated_hours ?? body.estimatedHours);
    if (estHours !== undefined && estHours > MAX_ESTIMATED_HOURS) {
      return { error: `Estimated hours must be at most ${MAX_ESTIMATED_HOURS}` };
    }
    const estimated_hours =
      estHours !== undefined && !Number.isNaN(estHours) && estHours > 0 ? estHours : null;
    return {
      pricing_mode: "hourly",
      price: rate,
      price_min: rate,
      price_max: rate,
      estimated_hours,
    };
  }

  return { error: "Invalid pricing mode" };
}
