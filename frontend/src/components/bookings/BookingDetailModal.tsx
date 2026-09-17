"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollLock } from "@/hooks/useScrollLock";
import Link from "next/link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  X, MapPin, Tag, CheckCircle, FileText, Grid3x3,
  TrendingDown, TrendingUp, ChevronLeft, Star,
  ImagePlus, Loader2,
} from "lucide-react";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import DisputeThread from "@/components/bookings/DisputeThread";
import WorkerCustomizeSection from "./WorkerCustomizeSection";
import PriceNegotiationSection from "./PriceNegotiationSection";
import BookingDetailFooter from "./BookingDetailFooter";
import { useTranslation } from "react-i18next";
import { getTaxRate, getTaxLabel, formatTaxRate } from "@/lib/taxes";
import {
  WORKER_COMMISSION_RATE,
  WORKER_PAYOUT_SHARE,
  workerNetFromGross,
  workerCommissionFromGross,
} from "@/lib/commissionRates";
import { uploadDisputeAttachments, type DisputeAttachment } from "@/lib/disputeAttachments";
import { getBookingDisputeFinancialOutcome } from "@/lib/disputeFinancials";
import { bookingLiveFingerprint, getModifiedFieldLabels } from "@/lib/bookingModifiedFields";
import { supabase } from "@/lib/supabaseClient";
import { negotiationCardClass } from "./negotiationCardStyles";
import { getIntlLocale } from "@/lib/locale";
import { sanitizePlainText } from "@/lib/sanitize";
import AppImage from "@/components/ui/AppImage";
import { toast } from "sonner";
import PaymentInlinePanel, {
  type PaymentInlinePanelHandle,
  type PaymentInlinePhase,
} from "@/components/payment/PaymentInlinePanel";
import { HourlyDepositReceiptBreakdown } from "@/components/payment/HourlyDepositReceiptBreakdown";
import { SplitDepositFullReceiptBreakdown } from "@/components/payment/SplitDepositFullReceiptBreakdown";
import CancelConfirmPanel from "@/components/bookings/CancelConfirmPanel";
import { BookingCalendarPanel } from "@/components/calendar/CalendarPageClient";
import WorkSessionsPanel from "@/components/bookings/WorkSessionsPanel";
import { formatHourlyRateSubtext, resolveBillingHours } from "@/lib/workHours";
import {
  computeHourlyBalanceDueCents,
  needsBookingPayment,
  resolveCheckoutKind,
  resolveCheckoutPrice,
  resolveBalanceFullServiceBase,
  isWorkBasedPricingMode,
  resolvePaymentBadgeDisplay,
  type CheckoutKind,
} from "@/lib/hourlyPayment";
import { normalizePricingMode, resolveBookingCheckoutBase, getEffectiveBookingPrice, getBookingPriceRangeBounds, formatBookingServiceBaseDisplay, formatBookingCheckoutTotalDisplay, formatBookingFeeComponentRange, shouldShowListingOriginalPriceStrike } from "@/lib/listingPrice";
import { isAwaitingPriceAgreement, canAccessPriceNegotiation, isPriceAgreementComplete } from "@/lib/priceNegotiation";
import { buildClientPaymentSummary, buildSplitDepositFullReceipt } from "@/lib/paymentSuccessSummary";
import { getServiceLocationEntries } from "@/lib/serviceLocation";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";

type BookingStatus = "pending" | "negotiating" | "accepted" | "active" | "completed" | "cancelled" | "rejected";
type BookingStep = "detail" | "payment" | "review" | "dispute" | "cancel";
type CancelMode = "deposit" | "dispute";

export interface BookingDetail {
  id: string;
  service_id: string;
  client_id: string;
  worker_id: string;
  status: BookingStatus;
  created_at: string;
  updated_at?: string | null;
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
  client_description: string | null;
  has_reviewed: boolean;
  has_dispute: boolean;
  payment_status: string | null;
  completed_by_worker: boolean;
  completed_by_client: boolean;
  is_one_time?: boolean;
  worker_note?: string | null;
  custom_price?: number | null;
  custom_price_min?: number | null;
  custom_price_max?: number | null;
  last_modified_at?: string | null;
  modified_fields?: string[] | null;
  cancel_requested_by?: string | null;
  cancel_reason?: string | null;
  completed_at?: string | null;
  client_name?: string;
  worker_name?: string;
  service_type?: "offer" | "looking";
  client_province?: string | null;
  worker_province?: string | null;
  tax_rate?: number | null;
  dispute_id?: string | null;
  dispute_status?: "open" | "resolved" | "rejected" | null;
  dispute_resolution?: string | null;
  dispute_created_at?: string | null;
  dispute_refund_percentage?: number | null;
  deposit_enabled?: boolean;
  deposit_type?: string | null;
  deposit_value?: number | string | null;
  deposit_amount_cents?: number | null;
  price_max?: number | string | null;
  pricing_mode?: string | null;
  estimated_hours?: number | string | null;
  approved_hours_total?: number | string | null;
  paid_service_base_cents?: number | null;
  balance_due_cents?: number | null;
  price_confirmed_by_client_at?: string | null;
  price_confirmed_by_worker_at?: string | null;
  client_proposed_price?: number | string | null;
  worker_proposed_price?: number | string | null;
  price_selected_by_client?: number | string | null;
  price_selected_by_worker?: number | string | null;
  price_selected_source_by_client?: "client" | "worker" | null;
  price_selected_source_by_worker?: "client" | "worker" | null;
}

interface Props {
  booking: BookingDetail;
  userRole: "worker" | "client";
  accessToken: string;
  onClose: () => void;
  onUpdated: (bookingId: string, updates: Partial<BookingDetail>) => void;
  onMessage: (userId: string) => void;
  /** Parent should ignore dismiss while true (payment confirmation ghost-clicks). */
  onPaymentLockChange?: (locked: boolean) => void;
  /** Renders inside a parent shell (no backdrop); parent handles scroll lock. */
  embedded?: boolean;
  /** Back to parent list (embedded mode). */
  onBack?: () => void;
  /** Label on embedded back button (defaults to pending modal title). */
  embeddedBackLabel?: string;
}

const STATUS_BADGE: Record<BookingStatus, string> = {
  pending:     "bg-yellow-100 text-yellow-800 border-yellow-200",
  negotiating: "bg-amber-100 text-amber-800 border-amber-200",
  accepted:    "bg-green-100 text-green-800 border-green-200",
  active:    "bg-green-100 text-green-800 border-green-200",
  completed: "bg-green-100 text-green-800 border-green-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
  rejected:  "bg-red-100 text-red-700 border-red-200",
};

function formatDate(dateStr: string, lang: string) {
  try {
    return new Date(dateStr).toLocaleDateString(getIntlLocale(lang, { fr: 'fr-CA', en: 'en-CA' }), {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
  } catch { return dateStr; }
}

/** Même principe que ServiceHero (page détail service) : Embla, flèches, compteur 1/n. */
function BookingDetailHeroCarousel({ images, title }: { images: string[]; title: string }) {
  const validImages = images.filter(Boolean);
  const count = validImages.length;
  const [api, setApi] = useState<CarouselApi>();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!api) return;
    const handleSelect = () => setIndex(api.selectedScrollSnap());
    handleSelect();
    api.on("select", handleSelect);
    api.on("reInit", handleSelect);
    return () => {
      api.off("select", handleSelect);
      api.off("reInit", handleSelect);
    };
  }, [api]);

  if (count === 0) {
    return (
      <div className="w-full h-full bg-linear-to-br from-gray-50 to-gray-100 flex items-center justify-center">
        <Grid3x3 className="h-10 w-10 text-gray-300" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <Carousel
        key={validImages.join("|")}
        setApi={setApi}
        opts={{ align: "start", loop: count > 1 }}
        className="h-full w-full"
      >
        <CarouselContent className="ml-0 h-full">
          {validImages.map((image, imageIndex) => (
            <CarouselItem key={`${image}-${imageIndex}`} className="pl-0 h-full">
              <AppImage
                src={image}
                alt={`${title} - ${imageIndex + 1}`}
                width={1600}
                height={900}
                sizes="(max-width: 1024px) 100vw, 512px"
                className="h-full w-full object-cover"
              />
            </CarouselItem>
          ))}
        </CarouselContent>

        {count > 1 && (
          <>
            <CarouselPrevious
              className="left-3 top-1/2 z-10 border-0 bg-black/40 text-white hover:bg-black/60 hover:text-white disabled:pointer-events-none disabled:opacity-40"
            />
            <CarouselNext
              className="right-3 top-1/2 z-10 border-0 bg-black/40 text-white hover:bg-black/60 hover:text-white disabled:pointer-events-none disabled:opacity-40"
            />
          </>
        )}
      </Carousel>

      {count > 1 && (
        <span className="absolute top-3 right-3 z-11 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full pointer-events-none">
          {index + 1} / {count}
        </span>
      )}
    </div>
  );
}

export default function BookingDetailModal({
  booking: initialBooking, userRole, accessToken,
  onClose, onUpdated, onMessage, onPaymentLockChange,
  embedded = false,
  onBack,
  embeddedBackLabel,
}: Props) {
  const { t, i18n } = useTranslation();
  useScrollLock(!embedded);
  const [booking, setBooking] = useState(initialBooking);
  // Comes with the booking row (joined in the bookings API), so it renders on first
  // paint. The fetch below is only a fallback for rows loaded without the field.
  const [serviceDescription, setServiceDescription] = useState<string | null>(
    initialBooking.service_description ?? null
  );
  const [updating, setUpdating] = useState(false);
  const [step, setStep] = useState<BookingStep>("detail");
  const [layoutMode, setLayoutMode] = useState<"review" | "dispute" | "payment" | "cancel">("review");
  const [cancelMode, setCancelMode] = useState<CancelMode>("dispute");
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewHovered, setReviewHovered] = useState(0);
  const [reviewComment, setReviewComment] = useState("");
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewSuccess, setReviewSuccess] = useState(false);
  const [disputeDescription, setDisputeDescription] = useState("");
  const [disputePhotos, setDisputePhotos] = useState<File[]>([]);
  const [disputePreviews, setDisputePreviews] = useState<string[]>([]);
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);
  const [disputeUploading, setDisputeUploading] = useState(false);
  const [disputeError, setDisputeError] = useState("");
  const [disputeSuccess, setDisputeSuccess] = useState(false);
  const bookingRef = useRef(booking);
  const disputeFileInputRef = useRef<HTMLInputElement>(null);
  const paymentPanelRef = useRef<PaymentInlinePanelHandle>(null);
  const [paymentPhase, setPaymentPhase] = useState<PaymentInlinePhase>("billing");
  /** Frozen when opening payment so realtime status updates cannot flip deposit → full mid-flow. */
  const [paymentCheckoutKind, setPaymentCheckoutKind] = useState<CheckoutKind | null>(null);
  const [paymentFrozenPrice, setPaymentFrozenPrice] = useState<number | null>(null);
  const [paymentFrozenTitle, setPaymentFrozenTitle] = useState<string | null>(null);
  const paymentInFlightRef = useRef(false);
  /** Blocks backdrop ghost-clicks after Stripe iframe unmount / list reflow. */
  const suppressCloseUntilRef = useRef(0);
  const [closeLocked, setCloseLocked] = useState(false);
  const modalShellRef = useRef<HTMLDivElement>(null);
  const [paymentShellMinHeight, setPaymentShellMinHeight] = useState<number | null>(null);
  bookingRef.current = booking;

  useEffect(() => {
    // While paying, ignore parent list/realtime prop churn so the modal stays open
    // and the checkout kind / panel state do not reset mid-confirmation.
    if (step === "payment" || paymentInFlightRef.current) return;
    setBooking(initialBooking);
  }, [initialBooking, step]);

  // Always refetch on open so deposit repair + fresh payment_status apply (list cache can be stale).
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/bookings/${initialBooking.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (paymentInFlightRef.current) return;
        setBooking((prev) => ({ ...prev, ...data }));
        onUpdated(initialBooking.id, data);
      } catch {
        // ignore
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per booking open
  }, [initialBooking.id, accessToken]);

  const refreshBookingFromApi = useCallback(async () => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/bookings/${bookingRef.current.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const current = bookingRef.current;
      if (bookingLiveFingerprint(current) === bookingLiveFingerprint(data)) return data;
      // During payment confirmation, keep local snapshot stable; parent list can still update.
      if (paymentInFlightRef.current) return data;
      setBooking({ ...current, ...data });
      onUpdated(current.id, data);
      return data;
    } catch {
      return null;
    }
  }, [accessToken, onUpdated]);

  const setPaymentLock = useCallback((locked: boolean) => {
    setCloseLocked(locked);
    paymentInFlightRef.current = locked;
    onPaymentLockChange?.(locked);
    if (locked) {
      suppressCloseUntilRef.current = Date.now() + 5000;
    }
  }, [onPaymentLockChange]);

  const handleInlinePaymentSuccess = useCallback(async () => {
    // Refresh booking so the success receipt / detail panel show fresh payment_status.
    // Do NOT touch step/phase here — PaymentInlinePanel transitions itself to the
    // success receipt, and the user leaves it via the Close button (handlePaymentHeaderBack).
    setPaymentLock(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/bookings/${bookingRef.current.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const refreshed = await res.json();
        const current = bookingRef.current;
        setBooking({ ...current, ...refreshed });
      }
    } catch {
      // ignore — refreshBookingFromApi covers any follow-up sync
    }
  }, [accessToken, setPaymentLock]);

  const requestClose = useCallback(() => {
    if (closeLocked || paymentInFlightRef.current) return;
    if (step === "payment") return;
    if (Date.now() < suppressCloseUntilRef.current) return;
    onClose();
  }, [closeLocked, onClose, step]);

  const handlePaymentPhaseChange = useCallback((phase: PaymentInlinePhase) => {
    setPaymentPhase(phase);
    if (phase === "confirming") {
      setPaymentLock(true);
      const el = modalShellRef.current;
      if (el) setPaymentShellMinHeight(el.offsetHeight);
    }
  }, [setPaymentLock]);

  // Hard block: while payment is locked, no click outside the shell can dismiss anything.
  useEffect(() => {
    if (!closeLocked && step !== "payment") return;
    const swallow = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (modalShellRef.current?.contains(target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("pointerdown", swallow, true);
    document.addEventListener("pointerup", swallow, true);
    document.addEventListener("click", swallow, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("mouseup", swallow, true);
    return () => {
      document.removeEventListener("pointerdown", swallow, true);
      document.removeEventListener("pointerup", swallow, true);
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("mousedown", swallow, true);
      document.removeEventListener("mouseup", swallow, true);
    };
  }, [closeLocked, step]);

  useEffect(() => {
    if (initialBooking.service_description !== undefined) return;
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/services/${initialBooking.service_id}`)
      .then((r) => r.json())
      .then((s) => { if (s?.description) setServiceDescription(s.description); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live sync while negotiating (price proposals / confirmations) or active (completion marks)
  useEffect(() => {
    const poll = () => {
      if (paymentInFlightRef.current) return;
      const status = bookingRef.current.status;
      if (status === "active" || status === "negotiating" || (status === "accepted" && canAccessPriceNegotiation(bookingRef.current))) {
        refreshBookingFromApi();
      }
    };
    poll();
    const interval = setInterval(poll, 3500);
    return () => clearInterval(interval);
  }, [refreshBookingFromApi]);

  useEffect(() => {
    const channel = supabase
      .channel(`booking-detail-${initialBooking.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "bookings", filter: `id=eq.${initialBooking.id}` },
        () => { refreshBookingFromApi(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [initialBooking.id, refreshBookingFromApi]);

  const callStatus = async (status: BookingStatus) => {
    setUpdating(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/bookings/${booking.id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) return;
      const updated = await res.json();
      setBooking((prev) => ({ ...prev, ...updated }));
      onUpdated(booking.id, updated);
    } finally { setUpdating(false); }
  };

  const callCancelWithDeposit = async () => {
    setUpdating(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/bookings/${booking.id}/cancel-deposit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return;
      await res.json();
      setBooking((prev) => ({ ...prev, status: "cancelled", payment_status: "refunded" }));
      onUpdated(booking.id, { status: "cancelled", payment_status: "refunded" });
      onClose();
    } finally {
      setUpdating(false);
    }
  };

  const openCancelDepositStep = () => {
    setCancelMode("deposit");
    setLayoutMode("cancel");
    setStep("cancel");
  };

  const openCancelDisputeStep = () => {
    setCancelMode("dispute");
    setLayoutMode("cancel");
    setStep("cancel");
  };

  const proceedToDisputeFromCancel = () => {
    setLayoutMode("dispute");
    resetDisputePanel();
    setStep("dispute");
  };

  const callMarkCompleted = async () => {
    setUpdating(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/bookings/${booking.id}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.code === "HOURLY_SESSIONS_PENDING") {
          toast.error(t("bookings.hourlySessionsRequired"));
        } else if (err.code === "HOURLY_NO_APPROVED_HOURS") {
          toast.error(t("bookings.hourlyNoApprovedHours"));
        } else if (err.code === "HOURLY_BALANCE_DUE") {
          toast.error(
            t(
              isWorkBasedPricingMode(booking.pricing_mode)
                ? "bookings.fixedBalanceDueBeforeComplete"
                : "bookings.hourlyBalanceDueBeforeComplete",
            ),
          );
        } else if (err.message) {
          toast.error(err.message);
        }
        return;
      }
      const data = await res.json();
      setBooking((prev) => ({ ...prev, ...data }));
      onUpdated(booking.id, data);
    } finally { setUpdating(false); }
  };

  const callUndoMarkCompleted = async () => {
    setUpdating(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/bookings/${booking.id}/uncomplete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setBooking((prev) => ({ ...prev, ...data }));
      onUpdated(booking.id, data);
    } finally { setUpdating(false); }
  };

  const images = booking.image_urls?.length ? booking.image_urls : booking.image_url ? [booking.image_url] : [];

  const currentUserId = userRole === "worker" ? booking.worker_id : booking.client_id;
  const otherUserName = userRole === "worker" ? (booking.client_name ?? t("bookings.clientLabel")) : (booking.worker_name ?? t("bookings.providerLabel"));
  const otherUserId = userRole === "worker" ? booking.client_id : booking.worker_id;
  const depositConfig = booking.deposit_enabled
    ? {
        deposit_enabled: true,
        deposit_type: booking.deposit_type,
        deposit_value: booking.deposit_value,
      }
    : null;
  const bookingLocationEntries = getServiceLocationEntries(booking);
  const paymentNeed = needsBookingPayment(booking, depositConfig);
  const needsPayment = paymentNeed.needed;
  const checkoutKind = paymentNeed.kind;
  const activeCheckoutKind = step === "payment" && paymentCheckoutKind ? paymentCheckoutKind : checkoutKind;
  const paymentStepTitle =
    paymentFrozenTitle ??
    (activeCheckoutKind === "deposit"
      ? t("payment.payDepositLabel")
      : activeCheckoutKind === "balance"
        ? t("payment.payBalanceLabel")
        : t("payment.completePayment"));
  const balanceDueCents = computeHourlyBalanceDueCents(booking);
  const showBalanceDueStatusBadge =
    booking.status === "completed" && needsPayment && checkoutKind === "balance";
  const hasPendingFinalBalance = booking.status === "completed" && checkoutKind === "balance";
  const hasMarkedDone = userRole === "worker" ? booking.completed_by_worker : booking.completed_by_client;
  const otherHasMarkedDone = userRole === "worker" ? booking.completed_by_client : booking.completed_by_worker;
  const goToPaymentStep = useCallback(() => {
    const priceAtOpen = resolveCheckoutPrice(
      booking,
      booking.deposit_enabled
        ? {
            deposit_enabled: true,
            deposit_type: booking.deposit_type,
            deposit_value: booking.deposit_value,
          }
        : null,
    );
    const titleAtOpen =
      checkoutKind === "deposit"
        ? t("payment.payDepositLabel")
        : checkoutKind === "balance"
          ? t("payment.payBalanceLabel")
          : t("payment.completePayment");
    setPaymentCheckoutKind(checkoutKind);
    setPaymentFrozenPrice(priceAtOpen);
    setPaymentFrozenTitle(titleAtOpen);
    setPaymentLock(true);
    setPaymentPhase("billing");
    setLayoutMode("payment");
    setStep("payment");
  }, [booking, checkoutKind, setPaymentLock, t]);

  const handlePaymentHeaderBack = useCallback(() => {
    if (paymentPhase === "confirming") return;
    if (paymentPhase === "success") {
      setPaymentLock(false);
      setPaymentCheckoutKind(null);
      setPaymentFrozenPrice(null);
      setPaymentFrozenTitle(null);
      setPaymentShellMinHeight(null);
      setPaymentPhase("billing");
      setStep("detail");
      return;
    }
    if (paymentPhase === "card" && paymentPanelRef.current?.goBack()) return;
    setPaymentLock(false);
    setPaymentCheckoutKind(null);
    setPaymentFrozenPrice(null);
    setPaymentFrozenTitle(null);
    setPaymentShellMinHeight(null);
    setPaymentPhase("billing");
    setStep("detail");
  }, [paymentPhase, setPaymentLock]);
  const panelOrders = layoutMode === "dispute"
    ? { review: 0, detail: 1, dispute: 2, cancel: 3, payment: 4 }
    : layoutMode === "payment"
      ? { review: 0, detail: 1, payment: 2, cancel: 3, dispute: 4 }
      : layoutMode === "cancel"
        ? { dispute: 0, detail: 1, cancel: 2, review: 3, payment: 4 }
        : { dispute: 0, detail: 1, review: 2, cancel: 3, payment: 4 };
  const activeIndex = panelOrders[step];
  const translateClass = [
    "translate-x-0",
    "-translate-x-1/5",
    "-translate-x-2/5",
    "-translate-x-3/5",
    "-translate-x-4/5",
  ][activeIndex];
  const orderClasses = ["order-1", "order-2", "order-3", "order-4", "order-5"];
  const disputeIsValid = disputeDescription.trim().length >= 20;
  const disputeStatus = booking.dispute_status ?? (booking.has_dispute ? "open" : null);
  const disputeIsClosed = disputeStatus === "resolved" || disputeStatus === "rejected";
  const disputeFinancialOutcome = getBookingDisputeFinancialOutcome(booking);
  const displayStatusBadge = (() => {
    if (showBalanceDueStatusBadge) {
      return {
        label: userRole === "worker" ? t("bookings.waitingBalanceShort") : t("bookings.balanceDue"),
        className: userRole === "worker"
          ? "bg-gray-100 text-gray-600 border-gray-200"
          : "bg-amber-100 text-amber-800 border-amber-200",
      };
    }
    if (booking.status === "completed" && disputeIsClosed) {
      if (disputeFinancialOutcome.refundType === "full") {
        return { label: t("bookings.refundedFull"), className: "bg-green-100 text-green-800 border-green-200" };
      }
      if (disputeFinancialOutcome.refundType === "partial") {
        return { label: t("bookings.refundedPartial"), className: "bg-amber-100 text-amber-800 border-amber-200" };
      }
      return { label: t("bookings.notRefunded"), className: "bg-gray-100 text-gray-700 border-gray-200" };
    }

    return {
      label: t(`bookings.${booking.status}`),
      className: STATUS_BADGE[booking.status],
    };
  })();
  const displayPaymentBadge = (() => {
    if (booking.has_dispute && !disputeIsClosed) {
      return { label: t("bookings.disputeUnderReviewBadge"), className: "bg-amber-100 text-amber-800 border-amber-200" };
    }
    if (booking.has_dispute && disputeIsClosed) {
      return { label: t("bookings.disputeClosedBadge"), className: "bg-gray-100 text-gray-700 border-gray-200" };
    }
    const badge = resolvePaymentBadgeDisplay(booking, depositConfig, {
      viewerPaysBalance: userRole === "client",
    });
    if (!badge) return null;
    return { label: t(badge.labelKey), className: badge.className };
  })();

  const resetReviewPanel = () => {
    setReviewError("");
    setReviewSuccess(false);
  };

  const resetDisputePanel = () => {
    setDisputeError("");
    setDisputeSuccess(false);
  };

  const openReviewStep = () => {
    setLayoutMode("review");
    resetReviewPanel();
    setStep("review");
  };

  const openDisputeStep = () => {
    setLayoutMode("dispute");
    resetDisputePanel();
    setStep("dispute");
  };

  const handleReviewSubmit = async () => {
    if (reviewRating === 0) {
      setReviewError(t("bookings.reviewModal.selectRating"));
      return;
    }

    setReviewSubmitting(true);
    setReviewError("");
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/reviews`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          booking_id: booking.id,
          rating: reviewRating,
          comment: sanitizePlainText(reviewComment),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setReviewError(data.message ?? t("bookings.reviewModal.submitFailed"));
        return;
      }

      setReviewSuccess(true);
      setBooking((prev) => ({ ...prev, has_reviewed: true }));
      onUpdated(booking.id, { has_reviewed: true });
      setTimeout(() => setStep("detail"), 700);
    } catch {
      setReviewError(t("bookings.reviewModal.networkError"));
    } finally {
      setReviewSubmitting(false);
    }
  };

  const handleDisputePhotos = (files: FileList | null) => {
    if (!files) return;
    const valid = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, 4);
    setDisputePhotos((prev) => [...prev, ...valid].slice(0, 4));
    setDisputePreviews((prev) => [...prev, ...valid.map((file) => URL.createObjectURL(file))].slice(0, 4));
  };

  const removeDisputePhoto = (idx: number) => {
    URL.revokeObjectURL(disputePreviews[idx]);
    setDisputePhotos((prev) => prev.filter((_, i) => i !== idx));
    setDisputePreviews((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleDisputeSubmit = async () => {
    if (!disputeIsValid) {
      setDisputeError(t("bookings.openDisputeModal.descriptionTooShort"));
      return;
    }

    setDisputeSubmitting(true);
    setDisputeError("");
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/disputes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ booking_id: booking.id, description: disputeDescription.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDisputeError(data.message ?? t("bookings.openDisputeModal.openFailed"));
        return;
      }

      const dispute = await res.json();
      let attachments: DisputeAttachment[] = [];
      if (disputePhotos.length > 0) {
        setDisputeUploading(true);
        attachments = await uploadDisputeAttachments({ disputeId: dispute.id, files: disputePhotos, accessToken });
        setDisputeUploading(false);
      }

      const messageRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/disputes/${dispute.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ content: disputeDescription.trim(), attachments }),
      });
      if (!messageRes.ok) {
        const data = await messageRes.json().catch(() => ({}));
        setDisputeError(data.message ?? t("bookings.openDisputeModal.openFailed"));
        return;
      }

      setDisputeSuccess(true);
      const openedAt = new Date().toISOString();
      setBooking((prev) => ({
        ...prev,
        has_dispute: true,
        dispute_id: dispute.id,
        dispute_status: "open",
        dispute_resolution: null,
        dispute_created_at: openedAt,
      }));
      onUpdated(booking.id, {
        has_dispute: true,
        dispute_id: dispute.id,
        dispute_status: "open",
        dispute_resolution: null,
        dispute_created_at: openedAt,
      });
      setTimeout(() => setStep("detail"), 700);
    } catch (error) {
      setDisputeError(error instanceof Error ? error.message : t("bookings.openDisputeModal.networkError"));
    } finally {
      setDisputeSubmitting(false);
      setDisputeUploading(false);
    }
  };

  const modalBody = (
    <>
        {/* Header — changes based on step */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
          {step === "payment" ? (
            <>
              {paymentPhase !== "confirming" ? (
                <button
                  type="button"
                  onClick={handlePaymentHeaderBack}
                  aria-label={t("common.back")}
                  className="flex shrink-0 items-center justify-center text-gray-500 hover:text-gray-700 transition-colors cursor-pointer -ml-1 p-1"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              ) : (
                <span className="w-7 shrink-0" aria-hidden />
              )}
              <h2 className="flex-1 text-center text-base font-semibold text-gray-900 truncate px-2">
                {paymentStepTitle}
              </h2>
            </>
          ) : (
          <div className="min-w-0 flex-1">
            {embedded && step === "detail" && onBack ? (
              <>
                <button
                  type="button"
                  onClick={onBack}
                  className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {embeddedBackLabel ?? t("wallet.pendingModalTitle")}
                </button>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${displayStatusBadge.className}`}>
                    {displayStatusBadge.label}
                  </span>
                  {booking.is_one_time && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                      <Tag className="h-3 w-3" /> {t("bookings.oneTime")}
                    </span>
                  )}
                  {displayPaymentBadge && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${displayPaymentBadge.className}`}>
                      {displayPaymentBadge.label}
                    </span>
                  )}
                </div>
                <h2 className="mt-2 text-lg font-bold text-gray-900 leading-snug line-clamp-2">
                  <Link
                    href={`/serviceDetail/${booking.service_id}`}
                    onClick={requestClose}
                    className="hover:text-green-700 transition-colors"
                  >
                    {booking.title}
                  </Link>
                </h2>
              </>
            ) : step !== "detail" ? (
              <button
                type="button"
                onClick={() => setStep("detail")}
                className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
              >
                <ChevronLeft className="h-4 w-4" />
                {step === "cancel"
                  ? cancelMode === "deposit"
                    ? t("deposit.cancelWithDeposit")
                    : t("bookings.cancelActiveBooking")
                  : step === "review"
                    ? t("bookings.leaveReview")
                    : t("bookings.openDispute")}
              </button>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${displayStatusBadge.className}`}>
                    {displayStatusBadge.label}
                  </span>
                  {booking.is_one_time && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                      <Tag className="h-3 w-3" /> {t("bookings.oneTime")}
                    </span>
                  )}
                  {displayPaymentBadge && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${displayPaymentBadge.className}`}>
                      {displayPaymentBadge.label}
                    </span>
                  )}
                </div>
                <h2 className="mt-2 text-lg font-bold text-gray-900 leading-snug line-clamp-2">
                  <Link
                    href={`/serviceDetail/${booking.service_id}`}
                    onClick={requestClose}
                    className="hover:text-green-700 transition-colors"
                  >
                    {booking.title}
                  </Link>
                </h2>
              </>
            )}
          </div>
          )}
          <button
            type="button"
            onClick={requestClose}
            disabled={step === "payment"}
            aria-label={t("common.close")}
            className="cursor-pointer shrink-0 text-gray-400 hover:text-gray-600 transition-colors disabled:pointer-events-none disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Sliding panels container */}
        <div className={`flex flex-1 min-h-0 w-[500%] transition-transform duration-300 ease-in-out ${translateClass}`}>
          {/* Panel 1 — dispute step */}
          <div className={`flex flex-col overflow-hidden w-1/5 ${orderClasses[panelOrders.dispute]}`}>
            <div className="overflow-y-auto flex-1 px-5 py-5 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800 space-y-1.5">
                <p>{t("bookings.openDisputeModal.intro")}</p>
                <ul className="list-disc list-inside text-xs text-red-700 space-y-0.5">
                  <li>{t("bookings.openDisputeModal.ruleCompleted")}</li>
                  <li>{t("bookings.openDisputeModal.ruleInProgress")}</li>
                  <li>{t("bookings.openDisputeModal.ruleFees")}</li>
                  <li>{t("bookings.openDisputeModal.ruleCaseByCase")}</li>
                </ul>
              </div>

              {disputeError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{disputeError}</p>
              )}

              <div className="space-y-2">
                <Label className="text-base font-medium text-gray-900">
                  {t("bookings.openDisputeModal.describeLabel")} <span className="text-red-500">*</span>
                </Label>
                <Textarea
                  value={disputeDescription}
                  onChange={(e) => setDisputeDescription(e.target.value)}
                  placeholder={t("bookings.openDisputeModal.describePlaceholder")}
                  className="min-h-32 resize-none rounded-xl"
                />
                <p className={`text-xs text-right ${disputeDescription.length < 20 ? "text-gray-400" : "text-green-600"}`}>
                  {t("bookings.openDisputeModal.minimumCount", { count: disputeDescription.length })}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium text-gray-700">{t("bookings.openDisputeModal.photosLabel")}</Label>
                <div className="flex flex-wrap gap-2">
                  {disputePreviews.map((src, i) => (
                    <div key={i} className="relative">
                      <AppImage src={src} alt={t("bookings.openDisputeModal.photoAlt", { number: i + 1 })} width={64} height={64} className="h-16 w-16 object-cover rounded-xl border border-gray-200" />
                      <button
                        type="button"
                        aria-label={t("bookings.openDisputeModal.removePhoto")}
                        onClick={() => removeDisputePhoto(i)}
                        className="absolute -top-1 -right-1 bg-gray-800 text-white rounded-full h-4 w-4 flex items-center justify-center"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                  {disputePhotos.length < 4 && (
                    <button
                      type="button"
                      aria-label={t("bookings.openDisputeModal.addPhoto")}
                      onClick={() => disputeFileInputRef.current?.click()}
                      className="h-16 w-16 border-2 border-dashed border-gray-300 rounded-xl flex items-center justify-center text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
                    >
                      <ImagePlus className="h-5 w-5" />
                    </button>
                  )}
                </div>
                <input
                  ref={disputeFileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  aria-label={t("bookings.openDisputeModal.uploadPhotos")}
                  title={t("bookings.openDisputeModal.uploadPhotos")}
                  onChange={(e) => handleDisputePhotos(e.target.files)}
                />
              </div>

              {disputeUploading && (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("bookings.openDisputeModal.uploading")}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-3 shrink-0 bg-white">
              <Button variant="outline" onClick={() => setStep("detail")} disabled={disputeSubmitting}>{t("common.cancel")}</Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white min-w-36"
                onClick={handleDisputeSubmit}
                disabled={disputeSubmitting || !disputeIsValid}
              >
                {disputeSuccess ? (
                  <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4" /> {t("bookings.openDisputeModal.opened")}</span>
                ) : disputeSubmitting ? (
                  <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> {t("bookings.openDisputeModal.opening")}</span>
                ) : t("bookings.openDisputeModal.openButton")}
              </Button>
            </div>
          </div>{/* end panel 1 */}

          {/* Panel 2 — booking detail */}
          <div className={`flex flex-col overflow-hidden w-1/5 ${orderClasses[panelOrders.detail]}`}>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {/* Même principe que ServiceHero / images annonce : 16/9 (largeur du modal → hauteur proportionnelle) */}
          <div className="relative w-full shrink-0 overflow-hidden bg-gray-100">
            <AspectRatio ratio={16 / 9}>
              <BookingDetailHeroCarousel images={images} title={booking.title} />
            </AspectRatio>
          </div>

          <div className="px-5 py-4 space-y-4">
            {/* Modification banner */}
            {userRole === "client" && booking.last_modified_at && (() => {
              const modifiedLabels = getModifiedFieldLabels(booking, t, i18n.language);
              if (modifiedLabels.length === 0) return null;
              return (
                <div className={`${negotiationCardClass} space-y-2`}>
                  <p className="text-sm font-medium text-gray-800 leading-relaxed">
                    {t("bookings.recentlyModifiedLead")}{" "}
                    <span className="text-red-500">{t("bookings.recentlyModifiedEmphasis")}</span>
                  </p>
                  <p className="text-xs leading-relaxed">
                    <span className="text-gray-600">{t("bookings.providerUpdated")} </span>
                    {modifiedLabels.map((label, index) => (
                      <span key={label}>
                        {index > 0 && <span className="text-gray-600">, </span>}
                        <span className="font-medium text-red-500">{label}</span>
                      </span>
                    ))}
                  </p>
                  <p className="text-xs text-red-500 leading-relaxed">{t("bookings.reviewBeforePaying")}</p>
                </div>
              );
            })()}

            {/* Payment breakdown — top */}
            {(() => {
                const isHourlyModeEarly = normalizePricingMode(booking.pricing_mode) === "hourly";
                const hasApprovedHours =
                  isHourlyModeEarly && (Number(booking.approved_hours_total) || 0) > 0;
                const base =
                  booking.status === "completed" || hasApprovedHours
                    ? getEffectiveBookingPrice(booking)
                    : resolveBookingCheckoutBase(booking);
                const origBase = resolveBookingCheckoutBase({
                  ...booking,
                  custom_price: null,
                });
                const showOrigPriceStrike = shouldShowListingOriginalPriceStrike(booking, origBase);
                const fmt = (n: number) => n.toFixed(2);

                const billingProvince = booking.client_province ?? "QC";
                const taxRate =
                  booking.tax_rate != null && Number.isFinite(Number(booking.tax_rate)) && Number(booking.tax_rate) > 0
                    ? Number(booking.tax_rate)
                    : getTaxRate(billingProvince);
                const taxLabel        = getTaxLabel(billingProvince, i18n.language ?? "fr");
                const buyerCommission = base * 0.05;
                const taxes           = base * taxRate;
                const totalPaid       = base + buyerCommission + taxes;
                const platformCommission = workerCommissionFromGross(base);
                const workerReceives  = workerNetFromGross(base);
                const isHourlyMode    = normalizePricingMode(booking.pricing_mode) === "hourly";
                const hourlyRate      = isHourlyMode ? Number(booking.price) : null;
                const billingHours    = isHourlyMode ? resolveBillingHours(booking) : null;
                const hourlySubtext   =
                  isHourlyMode && hourlyRate != null && billingHours != null
                    ? formatHourlyRateSubtext(hourlyRate, billingHours, fmt, t)
                    : null;
                const priceRangeBounds = getBookingPriceRangeBounds(booking);
                const commissionRange = formatBookingFeeComponentRange(booking, taxRate, "commission");
                const taxesRange = formatBookingFeeComponentRange(booking, taxRate, "taxes");
                const servicePriceLine = formatBookingServiceBaseDisplay(t, booking);
                const totalLine = formatBookingCheckoutTotalDisplay(t, booking, taxRate);
                const fmtMoneyLine = (single: number, range?: { min: number; max: number } | null) =>
                  range
                    ? t("listingPrice.rangeCurrency", { min: fmt(range.min), max: fmt(range.max) })
                    : `${fmt(single)} $`;
                const workerReceivesRange = priceRangeBounds
                  ? { min: Math.round(priceRangeBounds.min * WORKER_PAYOUT_SHARE * 100) / 100, max: Math.round(priceRangeBounds.max * WORKER_PAYOUT_SHARE * 100) / 100 }
                  : null;
                const platformCommissionRange = priceRangeBounds
                  ? { min: Math.round(priceRangeBounds.min * WORKER_COMMISSION_RATE * 100) / 100, max: Math.round(priceRangeBounds.max * WORKER_COMMISSION_RATE * 100) / 100 }
                  : null;
                const splitPaymentSummary = buildClientPaymentSummary(booking);
                const splitFullReceipt = buildSplitDepositFullReceipt(booking);

                if (booking.status === "rejected") return null;

                if (isAwaitingPriceAgreement(booking)) {
                  const isQuoteMode = normalizePricingMode(booking.pricing_mode) === "quote";
                  return (
                    <Card className="gap-0 overflow-hidden py-0 shadow-none">
                      <div className="flex items-center gap-2 border-b border-gray-100 bg-white px-4 py-2">
                        <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                          {userRole === "worker" ? t("bookings.clientPaid") : t("bookings.paymentSummary")}
                        </span>
                      </div>
                      <CardContent className="space-y-1.5 px-4 py-3 text-sm">
                        <p className="font-semibold text-green-700">{totalLine}</p>
                        <p className="text-xs leading-relaxed text-gray-500">
                          {t(isQuoteMode ? "listingPrice.quoteTotalsHint" : "serviceDetail.rangeTotalsHint")}
                        </p>
                      </CardContent>
                    </Card>
                  );
                }

                const wasPaid = Boolean(
                  booking.payment_status && booking.payment_status !== "unpaid",
                );

                if (booking.status === "cancelled") {
                  if (!wasPaid) return null;

                  const depositDollars = (booking.deposit_amount_cents ?? 0) / 100;
                  const hasDepositCancellation =
                    booking.payment_status === "refunded" &&
                    booking.deposit_enabled &&
                    depositDollars > 0;
                  const refundBase = Math.max(0, base - depositDollars);
                  const totalTaxes = Math.round(base * taxRate * 100) / 100;
                  const refundedToClient = hasDepositCancellation
                    ? Math.round((refundBase + totalTaxes) * 100) / 100
                    : booking.payment_status === "refunded"
                      ? totalPaid
                      : null;
                  const workerDepositPayout = hasDepositCancellation
                    ? workerNetFromGross(depositDollars)
                    : null;
                  const platformDepositCommission = hasDepositCancellation
                    ? workerCommissionFromGross(depositDollars)
                    : null;

                  if (userRole === "worker") {
                    return (
                      <div className="space-y-3">
                        <Card className="gap-0 overflow-hidden py-0 shadow-none">
                          <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                            <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                              {t("bookings.paymentReceipt")}
                            </span>
                          </div>
                          <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                            <div className="flex justify-between text-gray-600">
                              <div>
                                <div>{t("serviceDetail.servicePrice")}</div>
                                {hourlySubtext && (
                                  <div className="text-xs text-gray-400">{hourlySubtext}</div>
                                )}
                              </div>
                              <span className="font-medium">{fmt(base)} $</span>
                            </div>
                            <div className="flex justify-between text-gray-500">
                              <span>{t("serviceDetail.buyerCommission")}</span>
                              <span>{fmt(buyerCommission)} $</span>
                            </div>
                            <div className="flex justify-between text-gray-500">
                              <span>{t("serviceDetail.taxes")} ({formatTaxRate(taxRate)}%)</span>
                              <span>{fmt(taxes)} $</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between font-bold text-base">
                              <span>{t("serviceDetail.total")}</span>
                              <span className="text-gray-900">{fmt(totalPaid)} $</span>
                            </div>
                          </CardContent>
                        </Card>
                        {workerDepositPayout !== null && platformDepositCommission !== null && (
                          <Card className="gap-0 overflow-hidden border-green-100 py-0 shadow-none">
                            <div className="flex items-center gap-2 bg-green-50 px-4 py-2 border-b border-green-100">
                              <TrendingUp className="h-3.5 w-3.5 text-green-600" />
                              <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">
                                {t("bookings.workerDepositPayoutLabel")}
                              </span>
                            </div>
                            <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                              <div className="flex justify-between text-gray-600">
                                <span>{t("bookings.depositRetainedGrossLabel")}</span>
                                <span className="font-medium">{fmt(depositDollars)} $</span>
                              </div>
                              <div className="flex justify-between text-red-500">
                                <span>{t("bookings.platformCommissionPromo")}</span>
                                <span>−{fmt(platformDepositCommission)} $</span>
                              </div>
                              <Separator />
                              <div className="flex justify-between font-bold text-base">
                                <span className="text-gray-900">{t("bookings.youWillReceive")}</span>
                                <span className="text-green-600">{fmt(workerDepositPayout)} $</span>
                              </div>
                            </CardContent>
                          </Card>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      {hasDepositCancellation && (
                        <Card className="gap-0 overflow-hidden border-red-200 py-0 shadow-none">
                          <div className="flex items-center gap-2 bg-red-50 px-4 py-2 border-b border-red-100">
                            <span className="text-xs font-semibold text-red-800 uppercase tracking-wide">
                              {t("bookings.cancellationReceiptTitle")}
                            </span>
                          </div>
                          <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                            <div className="flex justify-between text-gray-600">
                              <span>{t("bookings.totalPaid")}</span>
                              <span className="font-medium text-gray-900">{fmt(totalPaid)} $</span>
                            </div>
                            <div className="flex justify-between text-red-700">
                              <span>{t("bookings.depositRetainedLabel")}</span>
                              <span>-{fmt(depositDollars)} $</span>
                            </div>
                            <div className="flex justify-between text-red-700">
                              <span>{t("payment.buyerCommission")}</span>
                              <span>-{fmt(buyerCommission)} $</span>
                            </div>
                            {refundedToClient !== null && (
                              <>
                                <Separator className="my-1" />
                                <div className="flex justify-between text-green-700 font-semibold">
                                  <span>{t("bookings.amountRefundedLabel")}</span>
                                  <span>{fmt(refundedToClient)} $</span>
                                </div>
                              </>
                            )}
                          </CardContent>
                        </Card>
                      )}
                      <Card className="gap-0 overflow-hidden py-0 shadow-none">
                        <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                          <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            {t("bookings.paymentReceipt")}
                          </span>
                        </div>
                        <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                          <div className="flex justify-between text-gray-600">
                            <div>
                              <div>{t("serviceDetail.servicePrice")}</div>
                              {hourlySubtext && (
                                <div className="text-xs text-gray-400">{hourlySubtext}</div>
                              )}
                            </div>
                            <span className="font-medium">
                              {fmt(base)} $
                              {showOrigPriceStrike && (
                                <span className="text-xs text-gray-400 line-through ml-2">{fmt(origBase)} $</span>
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between text-gray-500">
                            <div>
                              <div>{t("serviceDetail.buyerCommission")}</div>
                              <div className="text-[11px] text-red-500">{t("payment.nonRefundable")}</div>
                            </div>
                            <span>{fmt(buyerCommission)} $</span>
                          </div>
                          <div className="flex justify-between text-gray-500">
                            <div>
                              <div>{t("serviceDetail.taxes")} ({formatTaxRate(taxRate)}%)</div>
                              <div className="text-[11px] text-gray-400">{taxLabel}</div>
                            </div>
                            <span>{fmt(taxes)} $</span>
                          </div>
                          <Separator />
                          <div className="flex justify-between font-bold text-base">
                            <span>{t("serviceDetail.total")}</span>
                            <span className="text-gray-900">{fmt(totalPaid)} $</span>
                          </div>
                        </CardContent>
                      </Card>
                      {booking.payment_status === "refunded" && !hasDepositCancellation && refundedToClient !== null && (
                        <Card className="gap-0 overflow-hidden border-gray-200 py-0 shadow-none">
                          <CardContent className="px-4 py-3">
                            <div className="flex justify-between text-sm font-semibold text-gray-700">
                              <span>{t("bookings.amountRefundedLabel")}</span>
                              <span>{fmt(refundedToClient)} $</span>
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  );
                }

                // Completed: worker sees client summary + payout, client sees total paid only
                if (booking.status === "completed") {
                  if (userRole === "worker") {
                    if (hasPendingFinalBalance) {
                      return (
                        <div className="space-y-3">
                          <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
                            {t("bookings.waitingForBalance")}
                          </div>
                          <Card className="gap-0 overflow-hidden py-0 shadow-none">
                            <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                              <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                {t("bookings.clientPaid")}
                              </span>
                            </div>
                            <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                              {splitPaymentSummary.variant === "split_deposit_paid" ? (
                                <>
                                  <div className="flex justify-between text-green-700 bg-green-50 -mx-1 px-2 py-1.5 rounded-lg">
                                    <span className="font-medium">{t("payment.depositPaidLine")}</span>
                                    <span className="font-semibold">{fmt(splitPaymentSummary.depositPaid)} $</span>
                                  </div>
                                  <HourlyDepositReceiptBreakdown
                                    depositPaid={splitPaymentSummary.depositPaid}
                                    serviceBase={splitPaymentSummary.serviceBase}
                                    hourlyRate={splitPaymentSummary.hourlyRate}
                                    hoursLabel={splitPaymentSummary.hoursLabel}
                                    hoursIsApproved={splitPaymentSummary.hoursIsApproved}
                                    hoursChanged={splitPaymentSummary.hoursChanged}
                                    estimatedTotalWithFees={splitPaymentSummary.estimatedTotalWithFees}
                                    remainingBase={splitPaymentSummary.remainingBase}
                                    remainingCommission={splitPaymentSummary.remainingCommission}
                                    remainingTaxes={splitPaymentSummary.remainingTaxes}
                                    remainingTotal={splitPaymentSummary.remainingTotal}
                                    taxRate={taxRate}
                                    taxLabel={taxLabel}
                                    pricingMode={booking.pricing_mode}
                                    fmt={fmt}
                                  />
                                </>
                              ) : (
                                <>
                                  <div className="flex justify-between text-gray-600">
                                    <span>{t("serviceDetail.total")}</span>
                                    <span className="font-medium">{fmt(totalPaid)} $</span>
                                  </div>
                                  <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3">
                                    <div className="flex justify-between text-sm font-semibold text-gray-900">
                                      <span>{t("bookings.remainingToPay")}</span>
                                      <span>{fmt(balanceDueCents / 100)} $</span>
                                    </div>
                                  </div>
                                </>
                              )}
                            </CardContent>
                          </Card>
                        </div>
                      );
                    }
                    return (
                      <div className="space-y-3">
                        {/* What the client paid */}
                        <Card className="gap-0 overflow-hidden py-0 shadow-none">
                          <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                            <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{t("bookings.clientPaid")}</span>
                          </div>
                          <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                            {splitFullReceipt ? (
                              <SplitDepositFullReceiptBreakdown
                                {...splitFullReceipt}
                                taxRate={taxRate}
                                taxLabel={taxLabel}
                                pricingMode={booking.pricing_mode}
                                hourlyRate={splitPaymentSummary.hourlyRate}
                                hoursLabel={splitPaymentSummary.hoursLabel}
                                fmt={fmt}
                              />
                            ) : (
                              <>
                            <div className="flex justify-between text-gray-600">
                              <div>
                                <div>{t("serviceDetail.servicePrice")}</div>
                                {hourlySubtext && (
                                  <div className="text-xs text-gray-400">{hourlySubtext}</div>
                                )}
                              </div>
                              <span className="font-medium">{fmt(base)} $</span>
                            </div>
                            <div className="flex justify-between text-gray-500">
                              <div>
                                <div>{t("serviceDetail.buyerCommission")}</div>
                                <div className="text-[11px] text-red-500">{t("payment.nonRefundable")}</div>
                              </div>
                              <span>{fmt(buyerCommission)} $</span>
                            </div>
                            <div className="flex justify-between text-gray-500">
                              <div>
                                <div>{t("serviceDetail.taxes")} ({formatTaxRate(taxRate)}%)</div>
                                <div className="text-[11px] text-gray-400">{taxLabel}</div>
                              </div>
                              <span>{fmt(taxes)} $</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between font-bold text-base">
                              <span>{t("serviceDetail.total")}</span>
                              <span className="text-gray-900">{fmt(totalPaid)} $</span>
                            </div>
                              </>
                            )}
                          </CardContent>
                        </Card>
                        {/* Worker payout */}
                        <Card className={`gap-0 overflow-hidden py-0 shadow-none ${disputeFinancialOutcome.hasFinancialAdjustment ? "border-amber-200" : "border-green-100"}`}>
                          <div className={`flex items-center gap-2 px-4 py-2 border-b ${disputeFinancialOutcome.hasFinancialAdjustment ? "bg-amber-50 border-amber-100" : "bg-green-50 border-green-100"}`}>
                            <TrendingUp className="h-3.5 w-3.5 text-green-600" />
                            <span className={`text-xs font-semibold uppercase tracking-wide ${disputeFinancialOutcome.hasFinancialAdjustment ? "text-amber-800" : "text-green-700"}`}>
                              {disputeFinancialOutcome.hasFinancialAdjustment ? t("bookings.workerPayoutAfterDecision") : t("bookings.workerPayout")}
                            </span>
                          </div>
                          <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                            <div className="flex justify-between text-gray-600">
                              <span>{t("serviceDetail.servicePrice")}</span>
                              <span className="font-medium">{fmt(base)} $</span>
                            </div>
                            <div className="flex justify-between text-red-500">
                              <span>{t("bookings.platformCommissionPromo")}</span>
                              <span>−{fmt(platformCommission)} $</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between font-bold text-base">
                              <span className="text-gray-900">{disputeFinancialOutcome.hasFinancialAdjustment ? t("bookings.finalPayoutLabel") : t("bookings.youWillReceive")}</span>
                              <span className="text-green-600">
                                {disputeFinancialOutcome.hasFinancialAdjustment && disputeFinancialOutcome.finalWorkerReceives !== null ? (
                                  <span className="inline-flex items-center gap-2">
                                    <span className="text-xs font-medium text-gray-400 line-through">{fmt(workerReceives)} $</span>
                                    <span>{fmt(disputeFinancialOutcome.finalWorkerReceives)} $</span>
                                  </span>
                                ) : (
                                  `${fmt(workerReceives)} $`
                                )}
                              </span>
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    );
                  }
                  // Client completed view
                  if (hasPendingFinalBalance) {
                    return (
                      <Card className="gap-0 overflow-hidden py-0 shadow-none">
                        <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                          <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            {t("bookings.paymentSummary")}
                          </span>
                        </div>
                        <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                          {splitPaymentSummary.variant === "split_deposit_paid" ? (
                            <>
                              <div className="flex justify-between text-green-700 bg-green-50 -mx-1 px-2 py-1.5 rounded-lg">
                                <span className="font-medium">{t("payment.depositPaidLine")}</span>
                                <span className="font-semibold">{fmt(splitPaymentSummary.depositPaid)} $</span>
                              </div>
                              <HourlyDepositReceiptBreakdown
                                depositPaid={splitPaymentSummary.depositPaid}
                                serviceBase={splitPaymentSummary.serviceBase}
                                hourlyRate={splitPaymentSummary.hourlyRate}
                                hoursLabel={splitPaymentSummary.hoursLabel}
                                hoursIsApproved={splitPaymentSummary.hoursIsApproved}
                                    hoursChanged={splitPaymentSummary.hoursChanged}
                                estimatedTotalWithFees={splitPaymentSummary.estimatedTotalWithFees}
                                remainingBase={splitPaymentSummary.remainingBase}
                                remainingCommission={splitPaymentSummary.remainingCommission}
                                remainingTaxes={splitPaymentSummary.remainingTaxes}
                                remainingTotal={splitPaymentSummary.remainingTotal}
                                taxRate={taxRate}
                                taxLabel={taxLabel}
                                pricingMode={booking.pricing_mode}
                                fmt={fmt}
                              />
                            </>
                          ) : (
                            <>
                              <div className="flex justify-between text-gray-600">
                                <span>{t("serviceDetail.total")}</span>
                                <span className="font-medium">{fmt(totalPaid)} $</span>
                              </div>
                              <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3">
                                <div className="flex justify-between text-sm font-semibold text-gray-900">
                                  <span>{t("bookings.remainingToPay")}</span>
                                  <span>{fmt(balanceDueCents / 100)} $</span>
                                </div>
                              </div>
                            </>
                          )}
                        </CardContent>
                      </Card>
                    );
                  }
                  return (
                    <div className="space-y-3">
                      <Card className="gap-0 overflow-hidden py-0 shadow-none">
                        <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                          <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{t("bookings.totalPaid")}</span>
                        </div>
                        <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                          {splitFullReceipt ? (
                            <SplitDepositFullReceiptBreakdown
                              {...splitFullReceipt}
                              taxRate={taxRate}
                              taxLabel={taxLabel}
                              pricingMode={booking.pricing_mode}
                              hourlyRate={splitPaymentSummary.hourlyRate}
                              hoursLabel={splitPaymentSummary.hoursLabel}
                              fmt={fmt}
                            />
                          ) : (
                            <>
                          <div className="flex justify-between text-gray-600">
                            <div>
                              <div>{t("serviceDetail.servicePrice")}</div>
                              {hourlySubtext && (
                                <div className="text-xs text-gray-400">{hourlySubtext}</div>
                              )}
                            </div>
                            <span className="font-medium">
                              {fmt(base)} $
                              {showOrigPriceStrike && (
                                <span className="text-xs text-gray-400 line-through ml-2">{fmt(origBase)} $</span>
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between text-gray-500">
                            <div>
                              <div>{t("serviceDetail.buyerCommission")}</div>
                              <div className="text-[11px] text-red-500">{t("payment.nonRefundable")}</div>
                            </div>
                            <span>{fmt(buyerCommission)} $</span>
                          </div>
                          <div className="flex justify-between text-gray-500">
                            <div>
                              <div>{t("serviceDetail.taxes")} ({formatTaxRate(taxRate)}%)</div>
                              <div className="text-[11px] text-gray-400">{taxLabel}</div>
                            </div>
                            <span>{fmt(taxes)} $</span>
                          </div>
                          <Separator />
                          <div className="flex justify-between font-bold text-base">
                            <span>{t("serviceDetail.total")}</span>
                            <span className="text-gray-900">{fmt(totalPaid)} $</span>
                          </div>
                            </>
                          )}
                        </CardContent>
                      </Card>
                      {disputeFinancialOutcome.hasFinancialAdjustment && disputeFinancialOutcome.finalClientPaid !== null && disputeFinancialOutcome.refundedAmount !== null && (
                        <Card className="gap-0 overflow-hidden border-amber-200 py-0 shadow-none">
                          <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 border-b border-amber-100">
                            <span className="text-xs font-semibold text-amber-800 uppercase tracking-wide">{t("bookings.finalOutcomeTitle")}</span>
                          </div>
                          <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                            <div className="flex justify-between text-gray-600">
                              <span>{t("bookings.originalTotalPaidLabel")}</span>
                              <span>{fmt(disputeFinancialOutcome.totalPaidOriginal)} $</span>
                            </div>
                            <div className="flex justify-between text-green-700">
                              <span>{t("bookings.refundAmountLabel")}</span>
                              <span>-{fmt(disputeFinancialOutcome.refundedAmount)} $</span>
                            </div>
                            <Separator />
                            <div className="flex justify-between font-bold text-base">
                              <span className="text-gray-900">{t("bookings.finalTotalPaidLabel")}</span>
                              <span className="text-gray-900">{fmt(disputeFinancialOutcome.finalClientPaid)} $</span>
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  );
                }

                // Worker view (pending/accepted/active): payment summary + projected earnings
                if (userRole === "worker") {
                  return (
                    <div className="space-y-3">
                      {/* Full payment breakdown — what the client paid */}
                      <Card className="gap-0 overflow-hidden py-0 shadow-none">
                        <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                          <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{t("bookings.clientPaid")}</span>
                        </div>
                        <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                          {splitFullReceipt ? (
                            <SplitDepositFullReceiptBreakdown
                              {...splitFullReceipt}
                              taxRate={taxRate}
                              taxLabel={taxLabel}
                              pricingMode={booking.pricing_mode}
                              hourlyRate={splitPaymentSummary.hourlyRate}
                              hoursLabel={splitPaymentSummary.hoursLabel}
                              fmt={fmt}
                            />
                          ) : splitPaymentSummary.variant === "split_deposit_paid" ? (
                            <>
                              <div className="flex justify-between text-green-700 bg-green-50 -mx-1 px-2 py-1.5 rounded-lg">
                                <span className="font-medium">{t("payment.depositPaidLine")}</span>
                                <span className="font-semibold">{fmt(splitPaymentSummary.depositPaid)} $</span>
                              </div>
                              <HourlyDepositReceiptBreakdown
                                depositPaid={splitPaymentSummary.depositPaid}
                                serviceBase={splitPaymentSummary.serviceBase}
                                hourlyRate={splitPaymentSummary.hourlyRate}
                                hoursLabel={splitPaymentSummary.hoursLabel}
                                hoursIsApproved={splitPaymentSummary.hoursIsApproved}
                                    hoursChanged={splitPaymentSummary.hoursChanged}
                                estimatedTotalWithFees={splitPaymentSummary.estimatedTotalWithFees}
                                remainingBase={splitPaymentSummary.remainingBase}
                                remainingCommission={splitPaymentSummary.remainingCommission}
                                remainingTaxes={splitPaymentSummary.remainingTaxes}
                                remainingTotal={splitPaymentSummary.remainingTotal}
                                taxRate={taxRate}
                                taxLabel={taxLabel}
                                pricingMode={booking.pricing_mode}
                                fmt={fmt}
                              />
                            </>
                          ) : (
                            <>
                          <div className="flex justify-between text-gray-600">
                            <div>
                              <div>{t("serviceDetail.servicePrice")}</div>
                              {hourlySubtext && (
                                <div className="text-xs text-gray-400">{hourlySubtext}</div>
                              )}
                            </div>
                            <span className="font-medium">
                              {servicePriceLine}
                              {showOrigPriceStrike && !priceRangeBounds && (
                                <span className="text-xs text-gray-400 line-through ml-2">{fmt(origBase)} $</span>
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between text-gray-500">
                            <div>
                              <div>{t("serviceDetail.buyerCommission")}</div>
                              <div className="text-[11px] text-red-500">{t("payment.nonRefundable")}</div>
                            </div>
                            <span>{fmtMoneyLine(buyerCommission, commissionRange)}</span>
                          </div>
                          <div className="flex justify-between text-gray-500">
                            <div>
                              <div>{t("serviceDetail.taxes")} ({formatTaxRate(taxRate)}%)</div>
                              <div className="text-[11px] text-gray-400">{taxLabel}</div>
                            </div>
                            <span>{fmtMoneyLine(taxes, taxesRange)}</span>
                          </div>
                          <Separator />
                          <div className="flex justify-between font-bold text-base">
                            <span>{t("serviceDetail.total")}</span>
                            <span className="text-gray-900">{totalLine}</span>
                          </div>
                          {priceRangeBounds && (
                            <p className="text-xs text-gray-500 pt-1">{t("serviceDetail.rangeTotalsHint")}</p>
                          )}
                            </>
                          )}
                        </CardContent>
                      </Card>
                      {/* Worker earnings */}
                      <Card className="gap-0 overflow-hidden border-green-100 py-0 shadow-none">
                        <div className="flex items-center gap-2 bg-green-50 px-4 py-2 border-b border-green-100">
                          <TrendingUp className="h-3.5 w-3.5 text-green-600" />
                          <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">{t("bookings.yourEarnings")}</span>
                        </div>
                        <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                          <div className="flex justify-between text-gray-600">
                            <div>
                              <div>{t("serviceDetail.servicePrice")}</div>
                              {hourlySubtext && (
                                <div className="text-xs text-gray-400">{hourlySubtext}</div>
                              )}
                            </div>
                            <span className="font-medium">{servicePriceLine}</span>
                          </div>
                          <div className="flex justify-between text-red-500">
                            <span>{t("bookings.platformCommissionPromo")}</span>
                            <span>−{fmtMoneyLine(platformCommission, platformCommissionRange)}</span>
                          </div>
                          <Separator />
                          <div className="flex justify-between font-bold text-base">
                            <span className="text-gray-900">{t("bookings.youWillReceive")}</span>
                            <span className="text-green-600">{fmtMoneyLine(workerReceives, workerReceivesRange)}</span>
                          </div>
                          <p className="text-[11px] text-gray-400">{t("bookings.payoutDelay")}</p>
                        </CardContent>
                      </Card>
                    </div>
                  );
                }

                // Client view (pending/accepted/active): payment summary
                return (
                  <Card className="gap-0 overflow-hidden py-0 shadow-none">
                    <div className="flex items-center gap-2 bg-white px-4 py-2 border-b border-gray-100">
                      <TrendingDown className="h-3.5 w-3.5 text-gray-500" />
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{t("bookings.paymentSummary")}</span>
                    </div>
                    <CardContent className="px-4 pt-3 pb-4 space-y-2 text-sm">
                      {splitFullReceipt ? (
                        <SplitDepositFullReceiptBreakdown
                          {...splitFullReceipt}
                          taxRate={taxRate}
                          taxLabel={taxLabel}
                          pricingMode={booking.pricing_mode}
                          hourlyRate={splitPaymentSummary.hourlyRate}
                          hoursLabel={splitPaymentSummary.hoursLabel}
                          fmt={fmt}
                        />
                      ) : splitPaymentSummary.variant === "split_deposit_paid" ? (
                        <>
                          <div className="flex justify-between text-green-700 bg-green-50 -mx-1 px-2 py-1.5 rounded-lg">
                            <span className="font-medium">{t("payment.depositPaidLine")}</span>
                            <span className="font-semibold">{fmt(splitPaymentSummary.depositPaid)} $</span>
                          </div>
                          <HourlyDepositReceiptBreakdown
                            depositPaid={splitPaymentSummary.depositPaid}
                            serviceBase={splitPaymentSummary.serviceBase}
                            hourlyRate={splitPaymentSummary.hourlyRate}
                            hoursLabel={splitPaymentSummary.hoursLabel}
                            hoursIsApproved={splitPaymentSummary.hoursIsApproved}
                                    hoursChanged={splitPaymentSummary.hoursChanged}
                            estimatedTotalWithFees={splitPaymentSummary.estimatedTotalWithFees}
                            remainingBase={splitPaymentSummary.remainingBase}
                            remainingCommission={splitPaymentSummary.remainingCommission}
                            remainingTaxes={splitPaymentSummary.remainingTaxes}
                            remainingTotal={splitPaymentSummary.remainingTotal}
                            taxRate={taxRate}
                            taxLabel={taxLabel}
                            pricingMode={booking.pricing_mode}
                            fmt={fmt}
                          />
                        </>
                      ) : (
                        <>
                      <div className="flex justify-between text-gray-600">
                        <div>
                          <div>{t("serviceDetail.servicePrice")}</div>
                          {hourlySubtext && (
                            <div className="text-xs text-gray-400">{hourlySubtext}</div>
                          )}
                        </div>
                        <span className="font-medium">
                          {servicePriceLine}
                          {showOrigPriceStrike && !priceRangeBounds && (
                            <span className="text-xs text-gray-400 line-through ml-2">{fmt(origBase)} $</span>
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <div>
                          <div>{t("serviceDetail.buyerCommission")}</div>
                          <div className="text-[11px] text-red-500">{t("payment.nonRefundable")}</div>
                        </div>
                        <span>{fmtMoneyLine(splitPaymentSummary.buyerCommission, commissionRange)}</span>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <div>
                          <div>{t("serviceDetail.taxes")} ({formatTaxRate(taxRate)}%)</div>
                          <div className="text-[11px] text-gray-400">{taxLabel}</div>
                        </div>
                        <span>{fmtMoneyLine(splitPaymentSummary.taxes, taxesRange)}</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between font-bold text-base">
                        <span>{t("serviceDetail.total")}</span>
                        <span className="text-green-600">{totalLine}</span>
                      </div>
                      {priceRangeBounds && (
                        <p className="text-xs text-gray-500 pt-1">{t("serviceDetail.rangeTotalsHint")}</p>
                      )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                );
              })()}

            {booking.deposit_enabled &&
              !isAwaitingPriceAgreement(booking) &&
              (!booking.payment_status || booking.payment_status === "unpaid") && (
              <div className="flex justify-between text-red-600 bg-red-50/80 px-3 py-1.5 rounded-lg text-sm">
                <span className="font-normal">{t("deposit.dueLine")}</span>
                {(() => {
                  const cents = booking.deposit_amount_cents;
                  if (cents && cents > 0) {
                    return (
                      <span className="font-normal whitespace-nowrap tabular-nums">
                        {(cents / 100).toFixed(2)} $
                      </span>
                    );
                  }
                  if (booking.deposit_type === "percent" && booking.deposit_value) {
                    return (
                      <span className="font-normal whitespace-nowrap tabular-nums">
                        {booking.deposit_value} %
                      </span>
                    );
                  }
                  if (booking.deposit_type === "fixed" && booking.deposit_value) {
                    return (
                      <span className="font-normal whitespace-nowrap tabular-nums">
                        {Number(booking.deposit_value).toFixed(2)} $
                      </span>
                    );
                  }
                  return null;
                })()}
              </div>
            )}

            {/* Service info */}
            {(booking.category || bookingLocationEntries.length > 0 || booking.service_location) && (
              <div className="space-y-2">
                {booking.category && (
                  <span className="inline-flex bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full text-xs">
                    {booking.category}
                  </span>
                )}
                {bookingLocationEntries.length > 0 ? (
                  <div className="space-y-1 text-sm text-gray-500">
                    {bookingLocationEntries.map((entry, index) => (
                      <div key={`${entry.label}-${index}`} className="flex items-start gap-1.5">
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="leading-snug">{entry.label}</span>
                      </div>
                    ))}
                  </div>
                ) : booking.service_location ? (
                  <div className="flex items-start gap-1.5 text-sm text-gray-500">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="leading-snug">{booking.service_location}</span>
                  </div>
                ) : null}
              </div>
            )}

            {serviceDescription && (
              <div className="text-sm text-gray-600 leading-relaxed bg-white rounded-lg px-4 py-3 border border-gray-100">
                {serviceDescription.length > 240 ? serviceDescription.slice(0, 240) + "…" : serviceDescription}
              </div>
            )}

            <div className="border-t border-gray-100" />

            {/* Other user */}
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10 shrink-0">
                <AvatarFallback className="text-sm bg-green-100 text-green-800">
                  {otherUserName.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <p className="min-w-0 text-sm leading-snug">
                <span className="text-gray-500">
                  {userRole === "worker"
                    ? t("bookings.requestFrom")
                    : booking.service_type === "looking"
                      ? t("bookings.from")
                      : t("bookings.serviceBy")}
                  {" "}
                </span>
                <Link
                  href={`/profile/${otherUserId}`}
                  className="font-semibold text-gray-900 hover:text-green-700 transition-colors"
                >
                  {otherUserName}
                </Link>
              </p>
            </div>

            {/* Client description */}
            {booking.client_description ? (
              <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-700">
                  <FileText className="h-3.5 w-3.5" />
                  {userRole === "worker" ? t("bookings.clientRequestDetails") : t("bookings.yourRequestDetails")}
                </div>
                <p className="text-sm text-blue-900 leading-relaxed whitespace-pre-line">{booking.client_description}</p>
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">{t("bookings.noRequestDescription")}</p>
            )}

            {/* Price negotiation (range / quote) */}
            {canAccessPriceNegotiation(booking) && (
              <PriceNegotiationSection
                booking={booking}
                userRole={userRole}
                accessToken={accessToken}
                onUpdated={(data) => {
                  setBooking((prev) => ({ ...prev, ...data }));
                  onUpdated(booking.id, data as Partial<BookingDetail>);
                }}
              />
            )}

            {/* Worker customize — quote: deposit/note only after price agreement */}
            {userRole === "worker" &&
              (normalizePricingMode(booking.pricing_mode) === "quote"
                ? booking.status === "accepted" && isPriceAgreementComplete(booking)
                : ["pending", "negotiating", "accepted"].includes(booking.status)) && (
              <WorkerCustomizeSection
                booking={booking}
                accessToken={accessToken}
                onSaved={(data) => {
                  setBooking((prev) => ({ ...prev, ...data }));
                  onUpdated(booking.id, data as Partial<BookingDetail>);
                }}
              />
            )}

            {/* Worker note → client */}
            {userRole === "client" && (booking.worker_note || booking.custom_price || booking.estimated_hours) && booking.status !== "negotiating" && (
              <div className="bg-green-50 border border-green-100 rounded-xl px-4 py-3 space-y-1">
                <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">{t("bookings.providerNote")}</p>
                {normalizePricingMode(booking.pricing_mode) === "hourly" && booking.estimated_hours != null && (
                  <p className="text-sm text-gray-700">
                    {t("post.estimatedHoursLabel")}:{" "}
                    <span className="font-semibold text-green-700">{Number(booking.estimated_hours)} h</span>
                  </p>
                )}
                {booking.custom_price && Number(booking.custom_price) !== Number(booking.price) && (
                  <p className="text-sm text-gray-700">{t("bookings.adjustedPrice")} <span className="font-semibold text-green-700">{Number(booking.custom_price).toFixed(2)} $</span></p>
                )}
                {booking.worker_note && <p className="text-sm text-gray-600 whitespace-pre-line">{booking.worker_note}</p>}
              </div>
            )}

            {["accepted", "active"].includes(booking.status) && (
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">{t("calendar.bookingSchedule")}</h3>
                <BookingCalendarPanel
                  bookingId={booking.id}
                  bookingTitle={booking.title}
                  serviceLocation={booking.service_location}
                  bookingStatus={booking.status}
                  userRole={userRole}
                  canEdit={["accepted", "active"].includes(booking.status)}
                  isHourly={normalizePricingMode(booking.pricing_mode) === "hourly"}
                />
              </div>
            )}

            {["accepted", "active"].includes(booking.status) &&
              normalizePricingMode(booking.pricing_mode) === "hourly" && (
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <WorkSessionsPanel
                  bookingId={booking.id}
                  isHourly
                  userRole={userRole}
                  canEdit={booking.status === "active"}
                  approvedHoursTotal={booking.approved_hours_total}
                  onUpdated={refreshBookingFromApi}
                />
              </div>
            )}

            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              {t("bookings.requestedOn")} {formatDate(booking.created_at, i18n.language ?? "fr")}
            </div>

            {booking.status === "accepted" && userRole === "worker" && (
              <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700 text-center">
                {t("bookings.waitingForPayment")}
              </div>
            )}
            {booking.status === "active" && booking.has_dispute && disputeStatus === "open" && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 space-y-1">
                <div className="font-semibold">
                  {t("bookings.disputeInProgress")}
                </div>
                <p>{t("bookings.disputePaused")}</p>
              </div>
            )}
            {booking.status === "active" && !booking.has_dispute && (
              <div className="space-y-1.5 text-xs text-green-700">
                <div className="text-center font-medium">{t("bookings.jobInProgress")}</div>
                <div className="flex justify-center gap-4">
                  <span className={`flex items-center gap-1 ${booking.completed_by_worker ? "text-green-600" : "text-gray-400"}`}>
                    <CheckCircle className="h-3.5 w-3.5" /> {t("bookings.providerLabel")} {booking.completed_by_worker ? "✓" : t("bookings.pending")}
                  </span>
                  <span className={`flex items-center gap-1 ${booking.completed_by_client ? "text-green-600" : "text-gray-400"}`}>
                    <CheckCircle className="h-3.5 w-3.5" /> {t("bookings.clientLabel")} {booking.completed_by_client ? "✓" : t("bookings.pending")}
                  </span>
                </div>
              </div>
            )}

            {booking.status === "completed" && !hasPendingFinalBalance && !booking.has_dispute && (() => {
              const DISPUTE_DAYS = 3;
              if (!booking.completed_at) return null;
              const completedMs = new Date(booking.completed_at).getTime();
              const deadlineMs = completedMs + DISPUTE_DAYS * 24 * 60 * 60 * 1000;
              const remainingMs = deadlineMs - Date.now();
              const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
              const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
              if (remainingMs <= 0) {
                if (booking.has_dispute) return null;
                return (
                  <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600 space-y-1">
                    <div className="font-semibold text-gray-700">
                      {t('bookings.disputeWindowTitle')}
                    </div>
                    <p>{t("bookings.disputeExpiredNotice")}</p>
                  </div>
                );
              }
              const remainingLabel = remainingDays > 1
                ? t('bookings.remainingDays', { count: remainingDays })
                : t('bookings.remainingHours', { count: remainingHours });
              return (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-500 space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold">
                    {t('bookings.disputeWindowTitle')}
                  </div>
                  <p>{t("bookings.disputeWindowNotice", { time: remainingLabel })}</p>
                </div>
              );
            })()}

            {booking.has_dispute && (
              <div className={`rounded-lg px-3 py-2 text-xs space-y-1 border ${
                disputeStatus === "resolved"
                  ? "bg-green-50 border-green-200 text-green-800"
                  : disputeStatus === "rejected"
                    ? "bg-white border-gray-200 text-gray-700"
                    : "bg-red-50 border-red-200 text-red-700"
              }`}>
                <div className="font-semibold">
                  {disputeStatus === "resolved"
                    ? t("bookings.disputeResolvedNotice")
                    : disputeStatus === "rejected"
                      ? t("bookings.disputeRejectedNotice")
                      : t("bookings.disputeInProgress")}
                </div>
                {disputeIsClosed ? (
                  <p>
                    {booking.payment_status === "refunded"
                      ? t("bookings.disputeRefundedNotice")
                      : t("bookings.disputeClosedNotice")}
                  </p>
                ) : (
                  <p>{t("bookings.disputePaused")}</p>
                )}
                {booking.dispute_resolution && (
                  <p>
                    <span className="font-semibold">{t("bookings.disputeDecisionLabel")}</span> {booking.dispute_resolution}
                  </p>
                )}
                {disputeFinancialOutcome.hasFinancialAdjustment && disputeFinancialOutcome.refundedAmount !== null && (
                  <p>
                    <span className="font-semibold">{t("bookings.finalAmountAfterDisputeLabel")}</span>{" "}
                    {userRole === "worker" && disputeFinancialOutcome.finalWorkerReceives !== null
                      ? `${disputeFinancialOutcome.finalWorkerReceives.toFixed(2)} $`
                      : userRole === "client" && disputeFinancialOutcome.finalClientPaid !== null
                        ? `${disputeFinancialOutcome.finalClientPaid.toFixed(2)} $`
                        : `${disputeFinancialOutcome.refundedAmount.toFixed(2)} $`}
                  </p>
                )}
              </div>
            )}

            {booking.has_dispute && (
              <DisputeThread bookingId={booking.id} currentUserId={currentUserId} accessToken={accessToken} />
            )}
          </div>
        </div>

        <BookingDetailFooter
          booking={booking}
          userRole={userRole}
          updating={updating}
          hasMarkedDone={hasMarkedDone}
          otherHasMarkedDone={otherHasMarkedDone}
          needsPayment={needsPayment}
          accessToken={accessToken}
          otherUserName={otherUserName}
          otherUserId={otherUserId}
          onCallStatus={callStatus}
          onMarkCompleted={callMarkCompleted}
          onUndoMarkCompleted={callUndoMarkCompleted}
          onOpenDispute={openDisputeStep}
          onOpenReview={openReviewStep}
          onMessage={onMessage}
          onClose={requestClose}
          onPayNow={goToPaymentStep}
          onOpenCancelDeposit={openCancelDepositStep}
          onOpenCancelDispute={openCancelDisputeStep}
        />
          </div>{/* end panel 2 */}

          {/* Panel 3 — review step */}
          <div className={`flex flex-col overflow-hidden w-1/5 ${orderClasses[panelOrders.review]}`}>
            <div className="overflow-y-auto flex-1 px-5 py-5 space-y-5">
              {reviewError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  {reviewError}
                </p>
              )}

              <div className="space-y-2">
                <Label className="text-base font-medium text-gray-900">
                  {t("bookings.reviewModal.ratingLabel")} <span className="text-red-500">*</span>
                </Label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label={t("bookings.reviewModal.starAria", { count: i })}
                      onMouseEnter={() => setReviewHovered(i)}
                      onMouseLeave={() => setReviewHovered(0)}
                      onClick={() => {
                        setReviewRating(i);
                        setReviewError("");
                      }}
                      className="cursor-pointer transition-transform hover:scale-110 focus:outline-none"
                    >
                      <Star
                        className={`h-8 w-8 transition-colors ${
                          i <= (reviewHovered || reviewRating)
                            ? "fill-yellow-400 text-yellow-400"
                            : "text-gray-300"
                        }`}
                      />
                    </button>
                  ))}
                </div>
                {reviewRating > 0 && (
                  <p className="text-sm text-gray-500">
                    {["", t("bookings.reviewModal.poor"), t("bookings.reviewModal.fair"), t("bookings.reviewModal.good"), t("bookings.reviewModal.veryGood"), t("bookings.reviewModal.excellent")][reviewRating]}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-base font-medium text-gray-900">{t("bookings.reviewModal.commentLabel")}</Label>
                <Textarea
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  placeholder={t("bookings.reviewModal.commentPlaceholder")}
                  className="min-h-28 resize-none rounded-xl"
                />
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-3 shrink-0 bg-white">
              <Button variant="outline" onClick={() => setStep("detail")} disabled={reviewSubmitting}>{t("common.cancel")}</Button>
              <Button
                className="bg-green-700 hover:bg-green-800 text-white min-w-32"
                onClick={handleReviewSubmit}
                disabled={reviewSubmitting || reviewRating === 0}
              >
                {reviewSuccess ? (
                  <span className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" /> {t("bookings.reviewModal.submitted")}
                  </span>
                ) : reviewSubmitting ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("bookings.reviewModal.submitting")}
                  </span>
                ) : t("bookings.reviewModal.submit")}
              </Button>
            </div>
          </div>{/* end panel 3 */}

          {/* Panel 4 — payment step */}
          <div className={`flex min-h-0 flex-col overflow-hidden w-1/5 ${orderClasses[panelOrders.payment]}`}>
            <PaymentInlinePanel
              ref={paymentPanelRef}
              bookingId={booking.id}
              bookingTitle={booking.title}
              price={
                paymentFrozenPrice ??
                resolveCheckoutPrice(
                  booking,
                  booking.deposit_enabled
                    ? {
                        deposit_enabled: true,
                        deposit_type: booking.deposit_type,
                        deposit_value: booking.deposit_value,
                      }
                    : null,
                )
              }
              accessToken={accessToken}
              clientProvince={booking.client_province ?? null}
              checkoutKind={activeCheckoutKind}
              fullServiceBase={
                activeCheckoutKind === "balance"
                  ? resolveBalanceFullServiceBase(booking)
                  : null
              }
              depositConfig={
                booking.deposit_enabled
                  ? {
                      deposit_enabled: true,
                      deposit_type: booking.deposit_type,
                      deposit_value: booking.deposit_value,
                    }
                  : null
              }
              depositAmountCents={booking.deposit_amount_cents}
              pricingMode={booking.pricing_mode}
              onPaymentSuccess={handleInlinePaymentSuccess}
              onPhaseChange={handlePaymentPhaseChange}
              successActions={
                <Button
                  className="h-12 w-full rounded-xl bg-green-700 text-white hover:bg-green-800"
                  onClick={handlePaymentHeaderBack}
                >
                  {t("common.close")}
                </Button>
              }
            />
          </div>{/* end panel 5 */}

          {/* Panel — cancel confirmation step */}
          <div className={`flex flex-col overflow-hidden w-1/5 ${orderClasses[panelOrders.cancel]}`}>
            <CancelConfirmPanel
              mode={cancelMode}
              updating={updating}
              onBack={() => setStep("detail")}
              onConfirmDeposit={callCancelWithDeposit}
              onProceedDispute={proceedToDisputeFromCancel}
            />
          </div>{/* end cancel panel */}

        </div>{/* end sliding panels */}
    </>
  );

  return embedded ? (
    <div className="relative bg-white w-full h-full min-h-0 flex flex-col overflow-hidden animate-in fade-in-0 duration-300">
      {modalBody}
    </div>
  ) : (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      {/* Always capture outside clicks — never pointer-events-none (that lets clicks hit the list behind). */}
      <div
        className="absolute inset-0 z-0"
        onClick={requestClose}
        onPointerDown={(e) => {
          if (closeLocked || step === "payment") {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        aria-hidden
      />
      <div
        ref={modalShellRef}
        className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
        style={paymentShellMinHeight ? { minHeight: paymentShellMinHeight } : undefined}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {modalBody}
      </div>
    </div>
  );
}
