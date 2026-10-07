import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { columnType, maxChars, maxNumeric } from "./helpers/schema.js";
import { MAX_LISTING_TAGS, normalizeListingTags } from "../src/utils/listingTags.js";
import { SERVICE_TEXT_LIMITS } from "../src/utils/serviceFieldCanonical.js";
import { MAX_ESTIMATED_HOURS } from "../src/utils/servicePricing.js";
import { MAX_FIXED_DEPOSIT } from "../src/utils/depositSchema.js";
import { BILLING_ADDRESS_LIMITS, normalizePostalCode } from "../src/utils/billingAddress.js";

/** Listing prices are capped at this in servicePricing.js and priceNegotiation.js. */
const MAX_PRICE = 1_000_000;

describe("listing columns fit what the API writes", () => {
  it("services.subcategory holds the longest tag list the form allows", () => {
    // 5 distinct tags of 80 characters: the case that made "Cours de dessin…" fail.
    const tags = Array.from({ length: MAX_LISTING_TAGS }, (_, i) => `${"x".repeat(79)}${i}`);
    const { subcategory } = normalizeListingTags({ listing_tags: tags });
    expect(subcategory.length).toBeGreaterThan(100);
    expect(subcategory.length).toBeLessThanOrEqual(maxChars("services", "subcategory"));
  });

  it.each(Object.entries(SERVICE_TEXT_LIMITS))(
    "services.%s limit (%i) matches its column",
    (column, limit) => {
      expect(limit).toBeLessThanOrEqual(maxChars("services", column));
    },
  );

  it("estimated hours fit services and bookings", () => {
    expect(MAX_ESTIMATED_HOURS).toBeLessThanOrEqual(maxNumeric("services", "estimated_hours"));
    expect(MAX_ESTIMATED_HOURS).toBeLessThanOrEqual(maxNumeric("bookings", "estimated_hours"));
  });

  it("fixed deposits fit services and bookings", () => {
    expect(MAX_FIXED_DEPOSIT).toBeLessThanOrEqual(maxNumeric("services", "deposit_value"));
    expect(MAX_FIXED_DEPOSIT).toBeLessThanOrEqual(maxNumeric("bookings", "deposit_value"));
  });

  it.each([
    "custom_price",
    "custom_price_min",
    "custom_price_max",
    "client_proposed_price",
    "worker_proposed_price",
    "price_selected_by_client",
    "price_selected_by_worker",
  ])("bookings.%s holds the maximum listing price", (column) => {
    expect(MAX_PRICE).toBeLessThanOrEqual(maxNumeric("bookings", column));
  });
});

describe("billing columns fit what the API writes", () => {
  it.each(Object.entries(BILLING_ADDRESS_LIMITS))(
    "billing_addresses.%s limit (%i) matches its column",
    (column, limit) => {
      expect(limit).toBeLessThanOrEqual(maxChars("billing_addresses", column));
    },
  );

  it("province columns are two-letter codes", () => {
    expect(maxChars("billing_addresses", "province")).toBe(2);
    expect(maxChars("bookings", "client_province")).toBe(2);
  });

  it("normalized postal codes fit users and billing addresses", () => {
    const longest = normalizePostalCode("h2x 1y4 extra garbage");
    expect(longest.length).toBeLessThanOrEqual(maxChars("users", "postal_code"));
    expect(longest.length).toBeLessThanOrEqual(maxChars("billing_addresses", "postal_code"));
  });
});

describe("trigger copies fit their target", () => {
  // sync_user_to_profile copies these on every users UPDATE, without an
  // exception handler: a narrower target fails the whole profile save.
  it.each(["full_name", "company_name"])("profiles.%s is at least as wide as users", (column) => {
    expect(maxChars("profiles", column)).toBeGreaterThanOrEqual(maxChars("users", column));
  });
});

describe("schema helper", () => {
  it("reads baseline types and later ALTER ... TYPE", () => {
    expect(columnType("billing_addresses", "city")).toBe("character varying(100)");
    expect(columnType("services", "subcategory")).toBe("text");
    expect(maxNumeric("services", "deposit_value")).toBeCloseTo(99_999_999.99);
  });
});

describe("SQL accepted by Postgres", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));

  function sourceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const full = dir + name;
      return statSync(full).isDirectory() ? sourceFiles(`${full}/`) : full.endsWith(".js") ? [full] : [];
    });
  }

  function withoutParentheses(sql) {
    let previous;
    let current = sql;
    do {
      previous = current;
      current = current.replace(/\([^()]*\)/g, "");
    } while (current !== previous);
    return current;
  }

  it("has no ORDER BY / LIMIT directly on UPDATE or DELETE", () => {
    const offenders = [];
    for (const file of sourceFiles(SRC)) {
      for (const [, sql] of readFileSync(file, "utf8").matchAll(/[`"]\s*((?:UPDATE|DELETE FROM)\b[^`"]*)[`"]/g)) {
        if (/\b(ORDER BY|LIMIT)\b/i.test(withoutParentheses(sql))) {
          offenders.push(`${file.slice(SRC.length)}: ${sql.trim().split("\n")[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
