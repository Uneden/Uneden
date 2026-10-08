import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { bookingStatusErrorMessage } from "./bookingStatusError";

const t = ((key: string) => key) as unknown as TFunction;

describe("bookingStatusErrorMessage", () => {
  it("shows the API's localised message for payment conflicts", () => {
    const body = { code: "ALREADY_PAID", message: "Cette réservation vient d'être payée. Actualisez la page." };
    expect(bookingStatusErrorMessage(409, body, t)).toBe(body.message);
  });

  it("explains a conflict when the booking moved on", () => {
    expect(bookingStatusErrorMessage(409, { message: "A cancelled booking cannot be accepted" }, t)).toBe(
      "bookings.statusChangeConflict",
    );
  });

  it("explains a refused action", () => {
    expect(bookingStatusErrorMessage(403, null, t)).toBe("bookings.statusChangeForbidden");
  });

  it("falls back to a generic failure", () => {
    expect(bookingStatusErrorMessage(500, null, t)).toBe("bookings.statusChangeFailed");
    expect(bookingStatusErrorMessage(400, { message: "Invalid booking status" }, t)).toBe("bookings.statusChangeFailed");
  });
});
