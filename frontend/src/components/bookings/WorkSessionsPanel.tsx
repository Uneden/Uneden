"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import HoursMinutesInput from "@/components/bookings/HoursMinutesInput";
import { bookingBtnGreen } from "@/components/bookings/bookingButtonStyles";
import {
  formatWorkDuration,
  parseHoursMinutesInput,
  partsToInputStrings,
} from "@/lib/workHours";
import { setVisibleInterval } from "@/lib/visibleInterval";

export type WorkSession = {
  id: string;
  booking_id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  hours_worker: number | null;
  hours_client: number | null;
  hours_final: number | null;
  status: string;
  worker_note: string | null;
  client_note: string | null;
  my_role?: "worker" | "client";
};

const STATUS_CLASS: Record<string, string> = {
  scheduled: "bg-gray-100 text-gray-700",
  pending_client: "bg-amber-100 text-amber-800",
  pending_worker: "bg-blue-100 text-blue-800",
  approved: "bg-green-100 text-green-800",
  disputed: "bg-red-100 text-red-800",
};

const LIVE_POLL_MS = 3500;

function sessionsFingerprint(sessions: WorkSession[]): string {
  return JSON.stringify(
    sessions.map((s) => ({
      id: s.id,
      status: s.status,
      hours_worker: s.hours_worker,
      hours_client: s.hours_client,
      hours_final: s.hours_final,
      updated_at: (s as WorkSession & { updated_at?: string }).updated_at,
    })),
  );
}

type Props = {
  bookingId: string;
  isHourly: boolean;
  userRole: "worker" | "client";
  canEdit: boolean;
  approvedHoursTotal?: number | string | null;
  onUpdated?: () => void;
};

export default function WorkSessionsPanel({
  bookingId,
  isHourly,
  userRole,
  canEdit,
  approvedHoursTotal,
  onUpdated,
}: Props) {
  const { t } = useTranslation();
  const { session } = useAuth();
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoursPart, setHoursPart] = useState("");
  const [minutesPart, setMinutesPart] = useState("");
  const [modifyHoursPart, setModifyHoursPart] = useState("");
  const [modifyMinutesPart, setModifyMinutesPart] = useState("");
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [modifySession, setModifySession] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sessionsFingerprintRef = useRef("");
  const approvedHoursRef = useRef(approvedHoursTotal);

  const approvedTotal = Number(approvedHoursTotal) || 0;

  const clearHoursInput = () => {
    setHoursPart("");
    setMinutesPart("");
    setActiveSession(null);
  };

  const clearModifyInput = () => {
    setModifyHoursPart("");
    setModifyMinutesPart("");
    setModifySession(null);
  };

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!session?.access_token || !isHourly) return;
    if (!opts?.silent) setLoading(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/work-sessions?booking_id=${bookingId}`,
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      if (!res.ok) return;
      const data = await res.json();
      const next = Array.isArray(data) ? data : [];
      const fp = sessionsFingerprint(next);
      if (fp !== sessionsFingerprintRef.current) {
        sessionsFingerprintRef.current = fp;
        setSessions(next);
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [bookingId, isHourly, session?.access_token]);

  useEffect(() => {
    load();
  }, [load]);

  // Live sync while modal is open (other party submits / approves hours)
  useEffect(() => {
    if (!isHourly || !session?.access_token) return;
    const poll = () => load({ silent: true });
    return setVisibleInterval(poll, LIVE_POLL_MS);
  }, [isHourly, session?.access_token, load]);

  useEffect(() => {
    if (approvedHoursRef.current === approvedHoursTotal) return;
    approvedHoursRef.current = approvedHoursTotal;
    load({ silent: true });
  }, [approvedHoursTotal, load]);

  if (!isHourly) return null;

  const apiPost = async (path: string, body: Record<string, unknown>) => {
    if (!session?.access_token) return false;
    setSaving(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/work-sessions${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.message || t("workSessions.error"));
        return false;
      }
      await load({ silent: true });
      onUpdated?.();
      clearHoursInput();
      clearModifyInput();
      return true;
    } finally {
      setSaving(false);
    }
  };

  const parseHoursMinutes = (hoursStr: string, minutesStr: string) => {
    const total = parseHoursMinutesInput(hoursStr, minutesStr);
    if (total == null) {
      toast.error(t("workSessions.invalidHours"));
      return null;
    }
    return total;
  };

  const activateSessionInput = (sessionId: string, decimal?: number | null) => {
    setActiveSession(sessionId);
    if (activeSession !== sessionId) {
      const parts = partsToInputStrings(decimal);
      setHoursPart(parts.hours);
      setMinutesPart(parts.minutes);
    }
  };

  const activateModifyInput = (sessionId: string, decimal?: number | null) => {
    setModifySession(sessionId);
    if (modifySession !== sessionId) {
      const parts = partsToInputStrings(decimal);
      setModifyHoursPart(parts.hours);
      setModifyMinutesPart(parts.minutes);
    }
  };

  const sessionHoursForSubmit = (s: WorkSession) => {
    if (activeSession === s.id) {
      return parseHoursMinutes(hoursPart, minutesPart);
    }
    if (s.hours_worker != null) return s.hours_worker;
    return parseHoursMinutes(hoursPart, minutesPart);
  };

  const handleCreate = () => apiPost("/", { booking_id: bookingId, title: t("workSessions.defaultTitle") });

  const handleCreateAndSubmit = async () => {
    if (!session?.access_token || userRole !== "worker" || !canEdit) return;
    const hours = parseHoursMinutes(hoursPart, minutesPart);
    if (hours == null) return;

    setSaving(true);
    try {
      const createRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/work-sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ booking_id: bookingId, title: t("workSessions.defaultTitle") }),
      });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        toast.error(err.message || t("workSessions.error"));
        return;
      }
      const created = await createRes.json();
      const submitRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/work-sessions/${created.id}/submit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ hours }),
        },
      );
      if (!submitRes.ok) {
        const err = await submitRes.json().catch(() => ({}));
        toast.error(err.message || t("workSessions.error"));
        return;
      }
      toast.success(t("workSessions.submittedSuccess"));
      await load({ silent: true });
      onUpdated?.();
      clearHoursInput();
    } finally {
      setSaving(false);
    }
  };

  const workerCanSubmitOnSession = (status: string) =>
    canEdit && userRole === "worker" && ["scheduled", "pending_worker"].includes(status);

  const displayParts = (sessionId: string, decimal: number | null | undefined) => {
    if (activeSession === sessionId) {
      return { hours: hoursPart, minutes: minutesPart };
    }
    return partsToInputStrings(decimal);
  };

  const displayModifyParts = (sessionId: string, decimal: number | null | undefined) => {
    if (modifySession === sessionId) {
      return { hours: modifyHoursPart, minutes: modifyMinutesPart };
    }
    return partsToInputStrings(decimal);
  };

  const hasHoursInput = hoursPart.trim() !== "" || minutesPart.trim() !== "";
  const hasModifyInput = modifyHoursPart.trim() !== "" || modifyMinutesPart.trim() !== "";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{t("workSessions.title")}</h3>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">{t("workSessions.hourlyBillingHint")}</p>
          {approvedTotal > 0 && (
            <p className="text-xs text-green-700 mt-0.5 font-medium">
              {t("workSessions.totalApproved", { duration: formatWorkDuration(approvedTotal, t) })}
            </p>
          )}
        </div>
        {canEdit && userRole === "worker" && sessions.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={handleCreate} disabled={saving}>
            {t("workSessions.addSession")}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-4 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            {userRole === "worker" ? t("workSessions.emptyWorker") : t("workSessions.emptyClient")}
          </p>
          {canEdit && userRole === "worker" && (
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end rounded-lg border border-dashed border-gray-200 bg-gray-50 p-3">
              <HoursMinutesInput
                idPrefix="empty-submit"
                label={t("workSessions.hoursLabel")}
                hours={hoursPart}
                minutes={minutesPart}
                onHoursChange={setHoursPart}
                onMinutesChange={setMinutesPart}
                className="flex-1"
              />
              <Button
                type="button"
                size="sm"
                className={cn(bookingBtnGreen, "shrink-0")}
                disabled={saving || !hasHoursInput}
                onClick={handleCreateAndSubmit}
              >
                {t("workSessions.submitHours")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {sessions.map((s) => {
            const inputParts = displayParts(s.id, s.hours_worker);
            const modifyParts = displayModifyParts(s.id, s.hours_worker);
            const clientProposal = s.hours_client ?? s.hours_worker;

            return (
              <li key={s.id} className="rounded-xl border border-gray-200 p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-gray-900">{s.title}</p>
                    {s.hours_final != null && (
                      <p className="text-sm text-green-700">
                        {t("workSessions.approvedHours", {
                          duration: formatWorkDuration(s.hours_final, t),
                        })}
                      </p>
                    )}
                    {s.hours_worker != null && s.status !== "approved" && (
                      <p className="text-xs text-gray-500">
                        {t("workSessions.submittedHours", {
                          duration: formatWorkDuration(s.hours_worker, t),
                        })}
                      </p>
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-medium",
                      STATUS_CLASS[s.status] ?? STATUS_CLASS.scheduled,
                    )}
                  >
                    {t(`workSessions.status.${s.status}`, s.status)}
                  </span>
                </div>

                {workerCanSubmitOnSession(s.status) && (
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                    <HoursMinutesInput
                      idPrefix={`submit-${s.id}`}
                      label={t("workSessions.hoursLabel")}
                      hours={inputParts.hours}
                      minutes={inputParts.minutes}
                      onHoursChange={(value) => {
                        activateSessionInput(s.id, s.hours_worker);
                        setHoursPart(value);
                      }}
                      onMinutesChange={(value) => {
                        activateSessionInput(s.id, s.hours_worker);
                        setMinutesPart(value);
                      }}
                      onFocus={() => activateSessionInput(s.id, s.hours_worker)}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      className={cn(bookingBtnGreen, "shrink-0")}
                      disabled={saving}
                      onClick={() => {
                        const hours = sessionHoursForSubmit(s);
                        if (hours != null) apiPost(`/${s.id}/submit`, { hours });
                      }}
                    >
                      {t("workSessions.submitHours")}
                    </Button>
                  </div>
                )}

                {canEdit && userRole === "client" && s.status === "pending_client" && (
                  <div className="space-y-2 border-t border-gray-100 pt-2">
                    <p className="text-xs text-gray-600">{t("workSessions.clientReviewHint")}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className={bookingBtnGreen}
                        disabled={saving}
                        onClick={() => apiPost(`/${s.id}/client-respond`, { action: "approve" })}
                      >
                        {t("workSessions.approve")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => apiPost(`/${s.id}/client-respond`, { action: "contest" })}
                      >
                        {t("workSessions.contest")}
                      </Button>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                      <HoursMinutesInput
                        idPrefix={`modify-${s.id}`}
                        label={t("workSessions.modifyHours")}
                        hours={modifyParts.hours}
                        minutes={modifyParts.minutes}
                        onHoursChange={(value) => {
                          activateModifyInput(s.id, s.hours_worker);
                          setModifyHoursPart(value);
                        }}
                        onMinutesChange={(value) => {
                          activateModifyInput(s.id, s.hours_worker);
                          setModifyMinutesPart(value);
                        }}
                        onFocus={() => activateModifyInput(s.id, s.hours_worker)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={saving || !hasModifyInput}
                        onClick={() => {
                          const hours =
                            modifySession === s.id
                              ? parseHoursMinutes(modifyHoursPart, modifyMinutesPart)
                              : parseHoursMinutes(
                                  partsToInputStrings(s.hours_worker).hours,
                                  partsToInputStrings(s.hours_worker).minutes,
                                );
                          if (hours != null) {
                            apiPost(`/${s.id}/client-respond`, { action: "modify", hours });
                          }
                        }}
                      >
                        {t("workSessions.proposeChange")}
                      </Button>
                    </div>
                  </div>
                )}

                {canEdit && userRole === "worker" && s.status === "pending_worker" && clientProposal != null && (
                  <div className="space-y-2 border-t border-gray-100 pt-2">
                    <p className="text-xs text-gray-600">
                      {t("workSessions.workerReviewHint", {
                        duration: formatWorkDuration(clientProposal, t),
                      })}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className={bookingBtnGreen}
                        disabled={saving}
                        onClick={() => apiPost(`/${s.id}/worker-respond`, { action: "approve" })}
                      >
                        {t("workSessions.acceptModification")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => apiPost(`/${s.id}/worker-respond`, { action: "dispute" })}
                      >
                        {t("workSessions.dispute")}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
