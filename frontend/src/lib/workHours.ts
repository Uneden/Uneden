export type HoursMinutes = { hours: number; minutes: number };

/** Decimal hours from whole hours + minutes (60 min = 1 h). */
export function decimalHoursFromParts(hours: number, minutes: number): number {
  return hours + minutes / 60;
}

/** Split decimal hours into whole hours and minutes for display/input. */
export function partsFromDecimalHours(total: number): HoursMinutes {
  const safe = Math.max(0, Number(total) || 0);
  const hours = Math.floor(safe);
  const minutes = Math.round((safe - hours) * 60);
  if (minutes === 60) return { hours: hours + 1, minutes: 0 };
  return { hours, minutes };
}

/** Parse user input; returns decimal hours or null if invalid. */
export function parseHoursMinutesInput(hoursStr: string, minutesStr: string): number | null {
  const h = hoursStr.trim() === "" ? 0 : Number(hoursStr);
  const m = minutesStr.trim() === "" ? 0 : Number(minutesStr);

  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || m < 0 || m > 59) return null;
  if (h > 24 || (h === 24 && m > 0)) return null;

  const total = decimalHoursFromParts(h, m);
  if (total <= 0 || total > 24) return null;

  return Math.round(total * 10000) / 10000;
}

type FormatDurationT = (key: string, opts?: Record<string, unknown>) => string;

/** Human-readable duration for UI (e.g. "2 h 30 min", "45 min"). */
export function formatWorkDuration(totalHours: number, t: FormatDurationT): string {
  const { hours, minutes } = partsFromDecimalHours(totalHours);
  if (hours === 0 && minutes === 0) return t("workSessions.durationZero");
  if (hours === 0) return t("workSessions.durationMinutesOnly", { minutes });
  if (minutes === 0) return t("workSessions.durationHoursOnly", { hours });
  return t("workSessions.durationHoursMinutes", { hours, minutes });
}

export function partsToInputStrings(total: number | null | undefined): { hours: string; minutes: string } {
  if (total == null || !Number.isFinite(Number(total)) || Number(total) <= 0) {
    return { hours: "", minutes: "" };
  }
  const { hours, minutes } = partsFromDecimalHours(Number(total));
  return { hours: String(hours), minutes: String(minutes) };
}

/** Hours used for billing display: approved first, then estimate. */
export function resolveBillingHours(booking: {
  approved_hours_total?: number | string | null;
  estimated_hours?: number | string | null;
}): number | null {
  const approved = Number(booking.approved_hours_total);
  if (Number.isFinite(approved) && approved > 0) return approved;
  const estimated = Number(booking.estimated_hours);
  if (Number.isFinite(estimated) && estimated > 0) return estimated;
  return null;
}

export function formatHourlyRateSubtext(
  rate: number,
  totalHours: number,
  fmtMoney: (n: number) => string,
  t: FormatDurationT,
): string {
  return `${fmtMoney(rate)} $/h × ${formatWorkDuration(totalHours, t)}`;
}
