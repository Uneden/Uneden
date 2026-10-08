import type { TFunction } from "i18next";

/**
 * Message for a refused booking status change (accept / reject / cancel).
 * Payment conflicts carry a `code` and a message the API already localised
 * ("this booking has just been paid…"); other refusals get a generic one.
 * A 409 means the booking moved on (accepted elsewhere, paid, cancelled):
 * callers should also reload it.
 */
export function bookingStatusErrorMessage(
  status: number,
  body: { message?: string; code?: string } | null,
  t: TFunction,
): string {
  if (body?.code && body.message) return body.message;
  if (status === 409) return t("bookings.statusChangeConflict");
  if (status === 403) return t("bookings.statusChangeForbidden");
  return t("bookings.statusChangeFailed");
}
