import { describe, expect, it } from "vitest";
import { getTaxRateForProvince, normalizeProvinceCode } from "../src/utils/taxProvince.js";
import {
  normalizePostalCode,
  pickValidBillingFields,
  validateBillingAddressInput,
} from "../src/utils/billingAddress.js";

const VALID = {
  label: "Domicile",
  full_name: "Test Buyer",
  address_line1: "1 Rue Test",
  city: "Longueuil",
  province: "QC",
  postal_code: "j4k2j5",
};

describe("normalizeProvinceCode", () => {
  it.each([
    ["QC", "QC"],
    ["qc", "QC"],
    [" QC ", "QC"],
    ["Québec", "QC"],
    ["Quebec", "QC"],
    ["QUÉBEC", "QC"],
    ["Ontario", "ON"],
    ["Colombie-Britannique", "BC"],
    ["Terre-Neuve-et-Labrador", "NL"],
    ["Nouvelle-Écosse", "NS"],
    ["Île-du-Prince-Édouard", "PE"],
    ["Territoires du Nord-Ouest", "NT"],
  ])("%s → %s", (input, code) => {
    expect(normalizeProvinceCode(input)).toBe(code);
  });

  it.each(["", null, undefined, "Q", "Province de Québec", "California", "XX"])(
    "rejects %s",
    (input) => {
      expect(normalizeProvinceCode(input)).toBeNull();
    },
  );

  it("only ever returns a two-letter code or null (char(2) columns)", () => {
    const inputs = ["Québec ", "quebec.", "ON", "Nunavut", "Yukon", "PEI", "B.C.", "ab", "Saskatchewan"];
    for (const input of inputs) {
      const code = normalizeProvinceCode(input);
      expect(code === null || /^[A-Z]{2}$/.test(code)).toBe(true);
    }
  });

  it("keeps tax rates for full names", () => {
    expect(getTaxRateForProvince("Ontario")).toBe(0.13);
    expect(getTaxRateForProvince("Québec")).toBe(0.14975);
  });
});

describe("normalizePostalCode", () => {
  it.each([
    ["j4k2j5", "J4K 2J5"],
    ["J4K 2J5", "J4K 2J5"],
    [" h2x  1y4 ", "H2X 1Y4"],
    ["", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(normalizePostalCode(input)).toBe(expected);
  });
});

describe("validateBillingAddressInput", () => {
  it("normalizes a complete address", () => {
    const { error, data } = validateBillingAddressInput({ ...VALID, province: "Québec" });
    expect(error).toBeNull();
    expect(data).toEqual({
      label: "Domicile",
      full_name: "Test Buyer",
      address_line1: "1 Rue Test",
      city: "Longueuil",
      province: "QC",
      postal_code: "J4K 2J5",
    });
  });

  it.each(["address_line1", "city", "province", "postal_code"])("requires %s", (field) => {
    const { error } = validateBillingAddressInput({ ...VALID, [field]: undefined });
    expect(error).toMatch(field);
  });

  it("rejects a province that is not a Canadian code (would overflow char(2))", () => {
    expect(validateBillingAddressInput({ ...VALID, province: "Province de Québec" }).error).toBe(
      "Invalid province",
    );
  });

  it.each(["12345", "J4K", "J4K 2J"])("rejects postal code %s", (postal) => {
    expect(validateBillingAddressInput({ ...VALID, postal_code: postal }).error).toBe("Invalid postal code");
  });

  it.each([
    ["label", 51],
    ["full_name", 256],
    ["address_line1", 256],
    ["city", 101],
  ])("rejects a %s longer than its column", (field, length) => {
    const { error } = validateBillingAddressInput({ ...VALID, [field]: "a".repeat(length) });
    expect(error).toMatch(field);
  });

  it("strips HTML", () => {
    const { data } = validateBillingAddressInput({ ...VALID, city: "<b>Longueuil</b>" });
    expect(data.city).toBe("Longueuil");
  });

  it("partial: returns only the fields sent", () => {
    const { error, data } = validateBillingAddressInput({ city: "Laval" }, { partial: true });
    expect(error).toBeNull();
    expect(data).toEqual({ city: "Laval" });
  });

  it("partial: refuses to blank a required field", () => {
    expect(validateBillingAddressInput({ city: "  " }, { partial: true }).error).toMatch("city");
  });
});

describe("pickValidBillingFields", () => {
  it("drops the fields billing_addresses would reject instead of failing", () => {
    expect(
      pickValidBillingFields({
        full_name: "Test",
        address_line1: "1 Rue Test",
        city: "x".repeat(150),
        province: "Somewhere",
        postal_code: "h2x1y4",
      }),
    ).toEqual({ full_name: "Test", address_line1: "1 Rue Test", postal_code: "H2X 1Y4" });
  });
});
