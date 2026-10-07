import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { setVisibleInterval } from "@/lib/visibleInterval";

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
  service_title?: string | null;
  service_image_url?: string | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

export function useNotifications() {
  const { session } = useAuth();
  const token = session?.access_token ?? null;
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API}/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setNotifications(await res.json());
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Poll every 30 seconds — use local variable, no useRef
  useEffect(() => {
    if (!token) return;
    fetchNotifications();
    return setVisibleInterval(fetchNotifications, 30_000);
  }, [token, fetchNotifications]);

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  const markRead = useCallback(async (id: string) => {
    if (!token) return;
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    );
    fetch(`${API}/notifications/${id}/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, [token]);

  const markAllRead = useCallback(async () => {
    if (!token) return;
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() }))
    );
    fetch(`${API}/notifications/read-all`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, [token]);

  const deleteOne = useCallback(async (id: string) => {
    if (!token) return;
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    fetch(`${API}/notifications/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, [token]);

  const clearAll = useCallback(async () => {
    if (!token) return;
    setNotifications([]);
    fetch(`${API}/notifications/all`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, [token]);

  // Mark all unread notifications whose link contains a given substring (e.g. "chat=CHAT_ID")
  const markReadByLink = useCallback((linkSubstring: string) => {
    if (!token) return;
    setNotifications((prev) => {
      const toMark = prev.filter((n) => !n.read_at && n.link?.includes(linkSubstring));
      toMark.forEach((n) => {
        fetch(`${API}/notifications/${n.id}/read`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      });
      return prev.map((n) =>
        !n.read_at && n.link?.includes(linkSubstring)
          ? { ...n, read_at: new Date().toISOString() }
          : n
      );
    });
  }, [token]);

  // Sync when a chat is opened from another place (e.g. Contacter modal).
  useEffect(() => {
    const onMarked = (event: Event) => {
      const chatId = (event as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (!chatId || !token) return;
      const linkSubstring = `chat=${chatId}`;
      setNotifications((prev) => {
        const toMark = prev.filter((n) => !n.read_at && n.link?.includes(linkSubstring));
        if (toMark.length === 0) return prev;
        toMark.forEach((n) => {
          fetch(`${API}/notifications/${n.id}/read`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        });
        return prev.map((n) =>
          !n.read_at && n.link?.includes(linkSubstring)
            ? { ...n, read_at: new Date().toISOString() }
            : n,
        );
      });
    };
    window.addEventListener("chat-marked-read", onMarked);
    return () => window.removeEventListener("chat-marked-read", onMarked);
  }, [token]);

  return { notifications, unreadCount, loading, markRead, markAllRead, markReadByLink, deleteOne, clearAll, refresh: fetchNotifications };
}
