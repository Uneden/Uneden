import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { setVisibleInterval } from "@/lib/visibleInterval";

export interface BookingNotif {
  id: string;
  service_title: string;
  other_name: string;
  other_avatar: string | null;
  status: string;
  created_at: string;
  role: "worker" | "client";
  seen: boolean;
}

const RECEIVED_SEEN_KEY = (uid: string) => `bookings_received_seen_${uid}`;
const SENT_SEEN_KEY     = (uid: string) => `bookings_sent_seen_${uid}`;

function lsGetIds(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]")); } catch { return new Set(); }
}
function lsSaveIds(key: string, ids: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...ids])); } catch {}
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

export function useUnreadBookings() {
  const { user, session } = useAuth();
  const [notifs, setNotifs] = useState<BookingNotif[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchNotifs = useCallback(async () => {
    if (!user || !session?.access_token) return;

    try {
      const res = await fetch(`${API}/bookings/unread-summary`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;

      const rows: {
        id: string;
        status: string;
        created_at: string;
        role: "worker" | "client";
        service_title: string;
        other_name: string;
        other_avatar: string | null;
      }[] = await res.json();

      const seenReceived = lsGetIds(RECEIVED_SEEN_KEY(user.id));
      const seenSent     = lsGetIds(SENT_SEEN_KEY(user.id));

      const result: BookingNotif[] = rows.map(b => ({
        id:            b.id,
        service_title: b.service_title,
        other_name:    b.other_name,
        other_avatar:  b.other_avatar,
        status:        b.status,
        created_at:    b.created_at,
        role:          b.role,
        seen:          b.role === "worker" ? seenReceived.has(b.id) : seenSent.has(b.id),
      })).sort((a, b) => {
        if (a.seen !== b.seen) return a.seen ? 1 : -1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      setNotifs(result);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [user, session]);

  useEffect(() => {
    if (!user) {
      setNotifs([]);
      setLoading(false);
      return;
    }

    fetchNotifs();

    // Poll every 30 s instead of keeping a Supabase Realtime channel open on every page.
    const stopPolling = setVisibleInterval(() => fetchNotifs(), 30_000);

    const onSeenUpdated = () => fetchNotifs();
    window.addEventListener("bookings-seen-updated", onSeenUpdated);

    return () => {
      stopPolling();
      window.removeEventListener("bookings-seen-updated", onSeenUpdated);
    };
  }, [user, fetchNotifs]);

  const unseenCount = notifs.filter((n) => !n.seen).length;

  const markSeen = useCallback((id: string) => {
    if (!user) return;
    const notif = notifs.find((n) => n.id === id);
    if (!notif) return;
    const key = notif.role === "worker" ? RECEIVED_SEEN_KEY(user.id) : SENT_SEEN_KEY(user.id);
    const ids = lsGetIds(key);
    ids.add(id);
    lsSaveIds(key, ids);
    setNotifs((prev) => prev.map((n) => n.id === id ? { ...n, seen: true } : n));
  }, [user, notifs]);

  const markAllSeen = useCallback(() => {
    if (!user) return;
    const recIds  = lsGetIds(RECEIVED_SEEN_KEY(user.id));
    const sentIds = lsGetIds(SENT_SEEN_KEY(user.id));
    notifs.forEach((n) => {
      if (n.role === "worker") recIds.add(n.id);
      else sentIds.add(n.id);
    });
    lsSaveIds(RECEIVED_SEEN_KEY(user.id), recIds);
    lsSaveIds(SENT_SEEN_KEY(user.id), sentIds);
    setNotifs((prev) => prev.map((n) => ({ ...n, seen: true })));
    window.dispatchEvent(new Event("bookings-seen-updated"));
  }, [user, notifs]);

  const markReadByLink = useCallback((_linkSubstring: string) => {}, []);

  return { notifs, loading, unseenCount, markSeen, markAllSeen, markReadByLink };
}
