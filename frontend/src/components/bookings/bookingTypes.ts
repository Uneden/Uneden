export type BookingStatus = "pending" | "negotiating" | "accepted" | "active" | "completed" | "cancelled" | "rejected";

interface BookingBase {
  id: string;
  service_id: string;
  client_id: string;
  worker_id: string;
  status: BookingStatus;
  created_at: string;
  title: string;
  price: string | number;
  image_url: string | null;
  image_urls?: string[] | null;
  category: string | null;
  service_location: string | null;
  service_description?: string | null;
  hide_exact_location?: boolean;
  location?: string | null;
  address?: string | null;
  city?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  locations?: Array<{ address?: string; city?: string; lat?: number; lng?: number; location?: string }> | null;
  has_reviewed: boolean;
  has_dispute: boolean;
  payment_status: string | null;
  completed_by_worker: boolean;
  completed_by_client: boolean;
  client_description: string | null;
  service_type?: "offer" | "looking";
  is_one_time?: boolean;
  worker_note?: string | null;
  custom_price?: number | null;
  last_modified_at?: string | null;
  modified_fields?: string[] | null;
  cancel_requested_by?: string | null;
  cancel_reason?: string | null;
  tax_rate?: number | null;
  worker_province?: string | null;
  client_province?: string | null;
  completed_at?: string | null;
  dispute_id?: string | null;
  dispute_status?: "open" | "resolved" | "rejected" | null;
  dispute_resolution?: string | null;
  dispute_created_at?: string | null;
  deposit_enabled?: boolean;
  deposit_type?: string | null;
  deposit_value?: number | string | null;
  deposit_amount_cents?: number | null;
  pricing_mode?: string | null;
  estimated_hours?: number | string | null;
  approved_hours_total?: number | string | null;
  paid_service_base_cents?: number | null;
  balance_due_cents?: number | null;
  price_max?: number | string | null;
  price_confirmed_by_client_at?: string | null;
  price_confirmed_by_worker_at?: string | null;
  client_proposed_price?: number | string | null;
  worker_proposed_price?: number | string | null;
  price_selected_by_client?: number | string | null;
  price_selected_by_worker?: number | string | null;
  price_selected_source_by_client?: "client" | "worker" | null;
  price_selected_source_by_worker?: "client" | "worker" | null;
}

export interface ReceivedBooking extends BookingBase {
  client_name: string;
  worker_name?: string;
}

export interface SentBooking extends BookingBase {
  worker_name: string;
  client_name?: string;
}

export const STATUS_CONFIG: Record<BookingStatus, { labelKey: string; bar: string; badge: string }> = {
  pending:     { labelKey: "bookings.pending",     bar: "bg-yellow-400", badge: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  negotiating: { labelKey: "bookings.negotiating", bar: "bg-amber-400",  badge: "bg-amber-100 text-amber-800 border-amber-200" },
  accepted:    { labelKey: "bookings.accepted",    bar: "bg-green-500",  badge: "bg-green-100 text-green-800 border-green-200" },
  active:    { labelKey: "bookings.active",    bar: "bg-green-500",  badge: "bg-green-100 text-green-800 border-green-200" },
  completed: { labelKey: "bookings.completed", bar: "bg-green-500",  badge: "bg-green-100 text-green-800 border-green-200" },
  cancelled: { labelKey: "bookings.cancelled", bar: "bg-red-400",    badge: "bg-red-100 text-red-700 border-red-200" },
  rejected:  { labelKey: "bookings.rejected",  bar: "bg-red-400",    badge: "bg-red-100 text-red-700 border-red-200" },
};

export function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString("fr-CA", { month: "short", day: "numeric", year: "numeric" });
  } catch { return dateStr; }
}

/** Sort key for completed/history lists — prefers completion date, then created_at. */
export function getBookingSortDate(booking: {
  completed_at?: string | null;
  created_at: string;
}): number {
  const raw = booking.completed_at ?? booking.created_at;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function sortBookingsByDateDesc<T extends { completed_at?: string | null; created_at: string }>(
  list: T[],
): T[] {
  return [...list].sort((a, b) => getBookingSortDate(b) - getBookingSortDate(a));
}

export const BOOKING_GROUPS = [
  { labelKey: "bookings.groupRequests", statuses: ["pending"] as BookingStatus[] },
  { labelKey: "bookings.groupNegotiation", statuses: ["negotiating"] as BookingStatus[] },
  { labelKey: "bookings.groupActive",   statuses: ["accepted", "active"] as BookingStatus[] },
  { labelKey: "bookings.groupClosed",   statuses: ["cancelled", "rejected"] as BookingStatus[] },
] as const;
