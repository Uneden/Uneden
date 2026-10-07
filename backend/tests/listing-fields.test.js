import { describe, expect, it } from "vitest";
import { normalizeListingTags } from "../src/utils/listingTags.js";
import { serviceTextLengthError } from "../src/utils/serviceFieldCanonical.js";
import { MAX_ESTIMATED_HOURS, resolveServicePricingFields } from "../src/utils/servicePricing.js";
import { parseDepositFields } from "../src/utils/depositSchema.js";

describe("normalizeListingTags", () => {
  it("joins tags into subcategory and flags custom ones", () => {
    const result = normalizeListingTags({ listing_tags: ["Babysitting", "Cours de dessin"] });
    expect(result.tags).toEqual(["Babysitting", "Cours de dessin"]);
    expect(result.subcategory).toBe("Babysitting · Cours de dessin");
    expect(result.hasCustomTags).toBe(true);
  });

  it("dedupes ignoring case and accents, keeps 5, cuts at 80 chars", () => {
    const result = normalizeListingTags({
      listing_tags: ["Ménage", "menage", "a", "b", "c", "d", "e", "x".repeat(120)],
    });
    expect(result.tags).toEqual(["Ménage", "a", "b", "c", "d"]);

    const long = normalizeListingTags({ listing_tags: ["x".repeat(120)] });
    expect(long.tags[0]).toHaveLength(80);
  });

  it("accepts a JSON string and falls back to subcategory", () => {
    expect(normalizeListingTags({ listing_tags: '["Plumbing"]' }).tags).toEqual(["Plumbing"]);
    expect(normalizeListingTags({ subcategory: "Plumbing" }).tags).toEqual(["Plumbing"]);
    expect(normalizeListingTags({}).subcategory).toBeNull();
  });
});

describe("serviceTextLengthError", () => {
  it("accepts the values the forms send", () => {
    expect(
      serviceTextLengthError({
        availability: "weekends",
        language: "fr",
        mobility: "city",
        urgency: "few-days",
        duration: null,
        poster_type: null,
      }),
    ).toBeNull();
  });

  it("names the first field too long for its column", () => {
    expect(serviceTextLengthError({ urgency: "u".repeat(51) })).toBe("urgency must be at most 50 characters");
    expect(serviceTextLengthError({ duration: "d".repeat(101) })).toMatch("duration");
  });
});

describe("pricing bounds", () => {
  const hourly = (estimated_hours) =>
    resolveServicePricingFields({ pricing_mode: "hourly", price: 25, estimated_hours }, { isCreate: true });

  it("accepts estimated hours up to the cap", () => {
    expect(hourly(MAX_ESTIMATED_HOURS).estimated_hours).toBe(MAX_ESTIMATED_HOURS);
    expect(hourly(0).estimated_hours).toBeNull();
  });

  it("rejects estimated hours that would overflow numeric(8,2)", () => {
    expect(hourly(1_000_000).error).toMatch("Estimated hours");
  });

  it("rejects a fixed deposit too large for numeric(10,2) on quote listings", () => {
    const body = { deposit_enabled: true, deposit_type: "fixed", deposit_value: 500_000_000 };
    expect(parseDepositFields(body, null, "quote").error).toBe("Deposit too high");
    expect(parseDepositFields({ ...body, deposit_value: 50 }, null, "quote").error).toBeNull();
  });
});
