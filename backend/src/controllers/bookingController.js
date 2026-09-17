import pool from "../config/db.js";
import { workerNetFromGross } from "../utils/commissionRates.js";
import { notifyBookingCreated, notifyBookingStatusUpdated, sendEmail } from "../services/emailService.js";
import { pushNewBooking, pushBookingStatus, pushPriceProposed, pushPriceConfirmRequest, pushPriceAgreed } from "../services/pushService.js";
import stripe from "../config/stripe.js";
import { createLocalizedNotification, getUserLang, shouldSendEmail } from "../services/notificationService.js";
import { validateInput, sanitizeText } from "../utils/validate.js";
import { processDepositCancellationRefund } from "../services/depositRefundService.js";
import { assertHourlyReadyForCompletion } from "../services/hourlyCompletionGuard.js";
import { processHourlyReconciliation } from "../services/hourlyReconciliationService.js";
import { refreshHourlyBalanceDue } from "../services/hourlyBalanceService.js";
import {
  ensureDepositsAndCalendarSchema,
  resolveBookingDepositMeta,
  resolveDepositBaseAmount,
  validateDepositAgainstPrice,
} from "../utils/depositSchema.js";
import { normalizePricingMode } from "../utils/servicePricing.js";
import { resolveBookingHourlyRate } from "../utils/hourlyPayment.js";
import {
  isNegotiablePricingMode,
  isPriceAgreementComplete,
  statusAfterAccept,
  validateNegotiatedPrice,
  validateNegotiatedRange,
  getPartyProposals,
  pricesMatch,
  canRenegotiatePrice,
} from "../utils/priceNegotiation.js";

function formatAgreedPriceLabel(booking) {
  return `${Number(booking.custom_price).toFixed(2)} $`;
}

function enrichBookingRow(row) {
  const deposit = resolveBookingDepositMeta(row);
  const {
    service_deposit_enabled,
    service_deposit_type,
    service_deposit_value,
    ...rest
  } = row;
  return { ...rest, ...deposit };
}

/** Optional booking-level deposit override from request body (worker quote flow). */
function parseBookingDepositOverride(body, existing) {
  const depositType = body.deposit_type ?? body.depositType;
  const depositValue = body.deposit_value ?? body.depositValue;
  if (depositType === undefined && depositValue === undefined) return null;

  if (
    depositType !== undefined &&
    depositType !== null &&
    !["fixed", "percent"].includes(depositType)
  ) {
    return { error: "Invalid deposit type" };
  }
  if (depositValue !== undefined) {
    const dv = Number(depositValue);
    if (!Number.isFinite(dv) || dv < 0) return { error: "Invalid deposit value" };
    const type = depositType ?? existing.deposit_type;
    if (type === "percent" && dv > 100) {
      return { error: "Deposit percent cannot exceed 100" };
    }
  }

  const finalDepositType =
    depositValue !== undefined && Number(depositValue) === 0
      ? null
      : depositType !== undefined
        ? depositType
        : existing.deposit_type;
  const finalDepositValue =
    depositValue !== undefined && Number(depositValue) === 0
      ? null
      : depositValue !== undefined
        ? Number(depositValue)
        : existing.deposit_value;
  const finalDepositEnabled = Boolean(finalDepositType && finalDepositValue > 0);

  return { finalDepositType, finalDepositValue, finalDepositEnabled };
}

function appendDepositSets(sets, params, depositOverride, startIndex) {
  if (!depositOverride) return startIndex;
  sets.push(
    `deposit_type = $${startIndex}`,
    `deposit_value = $${startIndex + 1}`,
    `deposit_enabled = $${startIndex + 2}`,
  );
  params.push(
    depositOverride.finalDepositType,
    depositOverride.finalDepositValue,
    depositOverride.finalDepositEnabled,
  );
  return startIndex + 3;
}

import {
  getTaxRateForProvince,
  isClientTaxLocationComplete,
  resolveClientTaxProvince,
} from "../utils/taxProvince.js";

function getEffectiveBookingPrice(booking) {
  const mode = normalizePricingMode(booking.pricing_mode ?? booking.service_pricing_mode);
  if (mode === "hourly") {
    const rate = resolveBookingHourlyRate(booking);
    const approved = Number(booking.approved_hours_total);
    const hours =
      Number.isFinite(approved) && approved > 0
        ? approved
        : Number(booking.estimated_hours ?? booking.service_estimated_hours ?? 1);
    return Math.round(rate * hours * 100) / 100;
  }
  return Number(booking.custom_price ?? booking.price ?? booking.service_price);
}

export const createBooking = async (req, res) => {
  try {
    await ensureDepositsAndCalendarSchema(pool);
    const { errors, data } = validateInput(req.body, {
      service_id:         { required: true, type: "uuid" },
      client_description: { type: "string", maxLen: 2000 },
    });

    if (errors) {
      return res.status(400).json({ message: errors[0] });
    }

    const { service_id, client_description } = data;

    const service = await pool.query(
      "SELECT s.*, u.email as worker_email, u.province as owner_province, CASE WHEN u.account_type = 'company' THEN u.company_name ELSE u.full_name END as worker_name FROM services s JOIN users u ON s.user_id = u.id WHERE s.id = $1",
      [service_id]
    );

    if (service.rows.length === 0) {
      return res.status(404).json({ message: "Service not found" });
    }

    const s = service.rows[0];

    if (!s.is_active) {
      return res.status(400).json({ message: "This listing is no longer available" });
    }

    if (s.is_public === false) {
      return res.status(400).json({ message: "This listing is private and not accepting new requests" });
    }

    // Can't apply to your own listing
    if (s.user_id === req.user.id) {
      return res.status(400).json({ message: "You can't request your own service" });
    }

    // For "looking" listings: poster is the client (pays), requester is the worker (gets paid)
    // For "offer" listings: poster is the worker (gets paid), requester is the client (pays)
    const isLooking = s.type === "looking";
    const worker_id = isLooking ? req.user.id : s.user_id;
    const client_id = isLooking ? s.user_id : req.user.id;

    // Prevent duplicate pending requests
    const duplicate = await pool.query(
      isLooking
        ? "SELECT id FROM bookings WHERE service_id = $1 AND worker_id = $2 AND status = 'pending'"
        : "SELECT id FROM bookings WHERE service_id = $1 AND client_id = $2 AND status = 'pending'",
      [service_id, req.user.id]
    );
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ message: "You already have a pending request for this listing" });
    }

    const applicant = await pool.query(
      "SELECT CASE WHEN account_type = 'company' THEN company_name ELSE full_name END AS display_name FROM users WHERE id = $1",
      [req.user.id]
    );
    const clientName = applicant.rows[0].display_name;

    if (!isLooking) {
      const taxLocationComplete = await isClientTaxLocationComplete(pool, client_id);
      if (!taxLocationComplete) {
        return res.status(400).json({
          message:
            req.lang === "en"
              ? "Complete your address (street, city, province, and postal code) in your profile before requesting a booking."
              : "Complétez votre adresse (rue, ville, province et code postal) dans votre profil avant de faire une demande de réservation.",
        });
      }
    }

    // Tax rate based on the client's (buyer's) billing province when available
    const clientProvince = await resolveClientTaxProvince(pool, client_id);
    const tax_rate = getTaxRateForProvince(clientProvince);

    const estimatedHours =
      req.body.estimated_hours != null || req.body.estimatedHours != null
        ? Number(req.body.estimated_hours ?? req.body.estimatedHours)
        : null;

    const result = await pool.query(
      `INSERT INTO bookings (service_id, client_id, worker_id, status, client_description, tax_rate, client_province, estimated_hours, pricing_mode)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        service_id,
        client_id,
        worker_id,
        client_description || null,
        tax_rate,
        clientProvince,
        Number.isFinite(estimatedHours) && estimatedHours > 0 ? estimatedHours : s.estimated_hours ?? null,
        s.pricing_mode ?? "fixed",
      ],
    );

    const booking = result.rows[0];

    // Ensure client has a wallet row
    await pool.query(
      "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [req.user.id]
    );

    // Always notify the listing poster (s.user_id), regardless of type
    shouldSendEmail(s.user_id, "listing").then(async (ok) => {
      if (ok) {
        const lang = await getUserLang(s.user_id);
        notifyBookingCreated(s.worker_email, s.worker_name, clientName, s.title, booking.id, s.image_url, s.image_urls, lang)
          .catch((err) => console.error("Booking email notification failed:", err.message));
      }
    }).catch((err) => console.error("shouldSendEmail error:", err.message));
    pushNewBooking(s.user_id, clientName, s.title).catch(() => {});
    createLocalizedNotification({
      userId: s.user_id,
      type: "booking_request",
      link: `/bookings?booking=${booking.id}`,
      en: { title: "New booking request", body: `${clientName} applied to your listing "${s.title}"` },
      fr: { title: "Nouvelle demande", body: `${clientName} a postulé pour votre annonce « ${s.title} »` },
    });

    res.status(201).json(
      enrichBookingRow({
        ...booking,
        pricing_mode: s.pricing_mode ?? booking.pricing_mode,
        service_deposit_enabled: s.deposit_enabled,
        service_deposit_type: s.deposit_type,
        service_deposit_value: s.deposit_value,
      }),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while creating booking" });
  }
};

export const getMyBookings = async (req, res) => {
  try {
    // "Envoyées" = bookings YOU initiated:
    //   offer listing  → you are the client (you booked someone's offer)
    //   looking listing → you are the worker (you applied to someone's search)
    const result = await pool.query(
      `SELECT b.*, s.title, s.price, s.image_url, s.image_urls, s.category,
              s.hide_exact_location,
              s.location, s.address, s.city, s.latitude, s.longitude, s.locations,
              d.dispute_id,
              d.dispute_status,
              d.dispute_resolution,
              d.dispute_created_at,
              d.dispute_refund_percentage,
              CASE
                WHEN s.hide_exact_location = true
                  THEN COALESCE(NULLIF(TRIM(s.city), ''), NULLIF(TRIM(s.location), ''), NULLIF(TRIM(s.address), ''))
                ELSE COALESCE(NULLIF(TRIM(s.address), ''), NULLIF(TRIM(s.location), ''), NULLIF(TRIM(s.city), ''))
              END AS service_location,
              s.is_one_time, s.type AS service_type,
              s.description AS service_description,
              s.deposit_enabled AS service_deposit_enabled,
              s.deposit_type AS service_deposit_type,
              s.deposit_value AS service_deposit_value,
              CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
              COALESCE(b.client_province, uc.province) AS client_province,
              uw.province AS worker_province,
              EXISTS(SELECT 1 FROM reviews WHERE booking_id = b.id AND reviewer_id = $1) AS has_reviewed,
              (d.dispute_id IS NOT NULL) AS has_dispute,
              b.payment_status, b.completed_by_worker, b.completed_by_client,
              b.worker_note, b.custom_price, b.last_modified_at, b.modified_fields,
              b.cancel_requested_by, b.cancel_reason, b.completed_at,
              b.deposit_amount_cents,
              b.paid_service_base_cents,
              b.balance_due_cents,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              COALESCE(b.estimated_hours, s.estimated_hours) AS estimated_hours,
              b.approved_hours_total,
              s.price_max
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users uw ON b.worker_id = uw.id
       JOIN users uc ON b.client_id = uc.id
       LEFT JOIN LATERAL (
         SELECT d1.id AS dispute_id, d1.status AS dispute_status, d1.resolution AS dispute_resolution, d1.created_at AS dispute_created_at, d1.refund_percentage AS dispute_refund_percentage
         FROM disputes d1
         WHERE d1.booking_id = b.id
         ORDER BY d1.created_at DESC
         LIMIT 1
       ) d ON true
       WHERE (b.client_id = $1 AND s.type = 'offer')
          OR (b.worker_id = $1 AND s.type = 'looking')
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows.map(enrichBookingRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while fetching bookings" });
  }
};

export const getReceivedBookings = async (req, res) => {
  try {
    // "Reçues" = bookings someone sent TO you:
    //   offer listing  → you are the worker (someone booked your offer)
    //   looking listing → you are the client (someone applied to your search)
    const result = await pool.query(
      `SELECT b.*, s.title, s.price, s.image_url, s.image_urls, s.category,
              s.hide_exact_location,
              s.location, s.address, s.city, s.latitude, s.longitude, s.locations,
              d.dispute_id,
              d.dispute_status,
              d.dispute_resolution,
              d.dispute_created_at,
              d.dispute_refund_percentage,
              CASE
                WHEN s.hide_exact_location = true
                  THEN COALESCE(NULLIF(TRIM(s.city), ''), NULLIF(TRIM(s.location), ''), NULLIF(TRIM(s.address), ''))
                ELSE COALESCE(NULLIF(TRIM(s.address), ''), NULLIF(TRIM(s.location), ''), NULLIF(TRIM(s.city), ''))
              END AS service_location,
              s.is_one_time, s.type AS service_type,
              s.description AS service_description,
              s.deposit_enabled AS service_deposit_enabled,
              s.deposit_type AS service_deposit_type,
              s.deposit_value AS service_deposit_value,
              CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
              COALESCE(b.client_province, uc.province) AS client_province,
              uw.province AS worker_province,
              EXISTS(SELECT 1 FROM reviews WHERE booking_id = b.id AND reviewer_id = $1) AS has_reviewed,
              (d.dispute_id IS NOT NULL) AS has_dispute,
              b.payment_status, b.completed_by_worker, b.completed_by_client,
              b.worker_note, b.custom_price, b.last_modified_at, b.modified_fields,
              b.cancel_requested_by, b.cancel_reason, b.completed_at,
              b.deposit_amount_cents,
              b.paid_service_base_cents,
              b.balance_due_cents,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              COALESCE(b.estimated_hours, s.estimated_hours) AS estimated_hours,
              b.approved_hours_total,
              s.price_max
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users uc ON b.client_id = uc.id
       JOIN users uw ON b.worker_id = uw.id
       LEFT JOIN LATERAL (
         SELECT d1.id AS dispute_id, d1.status AS dispute_status, d1.resolution AS dispute_resolution, d1.created_at AS dispute_created_at, d1.refund_percentage AS dispute_refund_percentage
         FROM disputes d1
         WHERE d1.booking_id = b.id
         ORDER BY d1.created_at DESC
         LIMIT 1
       ) d ON true
       WHERE (b.worker_id = $1 AND s.type = 'offer')
          OR (b.client_id = $1 AND s.type = 'looking')
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows.map(enrichBookingRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["pending", "negotiating", "accepted", "active", "completed", "cancelled", "rejected"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid booking status" });
    }

    const booking = await pool.query(
      `SELECT b.*, s.title, s.is_one_time, s.type AS service_type,
              s.pricing_mode AS service_pricing_mode, s.estimated_hours AS service_estimated_hours,
              u.email as client_email,
              CASE WHEN u.account_type = 'company' THEN u.company_name ELSE u.full_name END AS client_name,
              wu.email as worker_email,
              CASE WHEN wu.account_type = 'company' THEN wu.company_name ELSE wu.full_name END AS worker_name
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users u ON b.client_id = u.id
       JOIN users wu ON b.worker_id = wu.id
       WHERE b.id = $1`,
      [id]
    );

    if (booking.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const b = booking.rows[0];

    // All status changes require the user to be a participant in the booking
    if (b.client_id !== req.user.id && b.worker_id !== req.user.id) {
      return res.status(403).json({ message: "You are not part of this booking" });
    }

    if (status === "accepted" || status === "rejected") {
      // For "offer" listings: worker (poster) accepts/rejects
      // For "looking" listings: client (poster) accepts/rejects the applicant
      const deciderIsWorker = b.service_type !== "looking";
      const deciderId = deciderIsWorker ? b.worker_id : b.client_id;
      if (deciderId !== req.user.id) {
        return res.status(403).json({ message: "Only the listing poster can accept or reject requests" });
      }
    }

    if (status === "cancelled") {
      if (!["pending", "negotiating", "accepted"].includes(b.status)) {
        return res.status(400).json({
          message: "In-progress or completed bookings cannot be cancelled directly. Open a dispute instead.",
        });
      }
    }

    if (status === "active" || status === "completed" || status === "pending") {
      return res.status(403).json({ message: "This status transition is not allowed via this endpoint" });
    }

    const nextStatus = status === "accepted"
      ? statusAfterAccept(b.service_pricing_mode ?? b.pricing_mode)
      : status;

    const result = await pool.query(
      nextStatus === "accepted" || nextStatus === "negotiating"
        ? `UPDATE bookings
           SET status = $1,
               pricing_mode = COALESCE(pricing_mode, $3),
               estimated_hours = COALESCE(estimated_hours, $4)
           WHERE id = $2 RETURNING *`
        : `UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *`,
      nextStatus === "accepted" || nextStatus === "negotiating"
        ? [nextStatus, id, b.service_pricing_mode ?? "fixed", b.service_estimated_hours ?? null]
        : [nextStatus, id],
    );

    if (status === "accepted" || status === "rejected") {
      // Notify the party who did NOT make the decision
      const notifyId = b.service_type === "looking" ? b.worker_id : b.client_id;
      const notifyEmail = b.service_type === "looking" ? b.worker_email : b.client_email;
      const notifyName = b.service_type === "looking" ? b.worker_name : b.client_name;
      shouldSendEmail(notifyId, "listing").then(async (ok) => {
        if (ok) {
          const lang = await getUserLang(notifyId);
          notifyBookingStatusUpdated(notifyEmail, notifyName, b.title, status, b.id, lang)
            .catch((err) => console.error("Status email notification failed:", err.message));
        }
      }).catch((err) => console.error("shouldSendEmail error:", err.message));
      pushBookingStatus(notifyId, nextStatus === "negotiating" ? "negotiating" : status, b.title).catch(() => {});
      createLocalizedNotification({
        userId: notifyId,
        type: status === "accepted" ? "booking_accepted" : "booking_rejected",
        link: `/bookings?booking=${id}`,
        en: {
          title: status === "accepted"
            ? (nextStatus === "negotiating" ? "Match confirmed — agree on price" : "Booking accepted")
            : "Booking rejected",
          body: status === "accepted"
            ? (nextStatus === "negotiating"
              ? `Your request for "${b.title}" was accepted. Agree on a price before payment.`
              : `Your request for "${b.title}" was accepted!`)
            : `Your request for "${b.title}" was declined.`,
        },
        fr: {
          title: status === "accepted"
            ? (nextStatus === "negotiating" ? "Accord trouvé — fixez le prix" : "Demande acceptée")
            : "Demande refusée",
          body: status === "accepted"
            ? (nextStatus === "negotiating"
              ? `Votre demande pour « ${b.title} » a été acceptée. Convenez d'un prix avant le paiement.`
              : `Votre demande pour « ${b.title} » a été acceptée !`)
            : `Votre demande pour « ${b.title} » a été refusée.`,
        },
      });
    }

    // One-time listing: when accepted, auto-reject all OTHER pending requests + deactivate listing
    if (status === "accepted" && b.is_one_time) {
      autoRejectOtherRequests(b.service_id, id).catch((err) =>
        console.error("Auto-reject failed for service", b.service_id, err.message)
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while updating booking" });
  }
};

// Mark completion by one party (worker or client)
export const markCompleted = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const booking = await pool.query(
      `SELECT b.*, s.title, s.price, s.is_one_time,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              s.pricing_mode AS service_pricing_mode, s.estimated_hours AS service_estimated_hours,
              CASE WHEN cw.account_type = 'company' THEN cw.company_name ELSE cw.full_name END AS worker_name,
              CASE WHEN cc.account_type = 'company' THEN cc.company_name ELSE cc.full_name END AS client_name,
              cw.id AS worker_user_id, cc.id AS client_user_id,
              cw.email AS worker_email, cc.email AS client_email,
              cc.province AS client_province
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users cw ON b.worker_id = cw.id
       JOIN users cc ON b.client_id = cc.id
       WHERE b.id = $1`,
      [id]
    );

    if (booking.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const b = booking.rows[0];

    if (b.status !== "active") {
      return res.status(400).json({ message: "Only active bookings can be marked as completed" });
    }

    if (b.client_id !== userId && b.worker_id !== userId) {
      return res.status(403).json({ message: "You are not part of this booking" });
    }

    const isWorker = b.worker_id === userId;
    const updateField = isWorker ? "completed_by_worker" : "completed_by_client";
    const otherAlreadyDone = isWorker ? b.completed_by_client : b.completed_by_worker;

    if (otherAlreadyDone) {
      try {
        await assertHourlyReadyForCompletion(id, b.pricing_mode ?? b.service_pricing_mode);
      } catch (guardErr) {
        if (guardErr.statusCode) {
          return res.status(guardErr.statusCode).json({
            message: guardErr.message,
            code: guardErr.code || "COMPLETION_BLOCKED",
          });
        }
        throw guardErr;
      }
    }

    // Set this party's completion flag
    await pool.query(
      `UPDATE bookings SET ${updateField} = true WHERE id = $1`,
      [id]
    );

    await refreshHourlyBalanceDue(id, { notifyClient: true }).catch(() => {});

    const [clientLang, workerLang] = await Promise.all([
      getUserLang(b.client_id),
      getUserLang(b.worker_id),
    ]);

    // Notify the other party that this person marked the job done
    if (isWorker) {
      sendEmail(b.client_email, "jobMarkedDone", [b.client_name, b.worker_name, b.title, id], clientLang);
    } else {
      sendEmail(b.worker_email, "jobMarkedDone", [b.worker_name, b.client_name, b.title, id], workerLang);
    }

    // Atomic UPDATE: only succeeds if BOTH flags are true AND status is still 'active'
    // This prevents double finalization if two requests arrive simultaneously
    const finalizeResult = await pool.query(
      `UPDATE bookings SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND status = 'active' AND completed_by_worker = true AND completed_by_client = true
       RETURNING *`,
      [id]
    );

    const updated = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
    const u = updated.rows[0];

    if (finalizeResult.rowCount > 0) {
      // Only entered by the one request that actually did the UPDATE
      // Only deactivate one-time listings — recurring listings stay active
      if (b.is_one_time) {
        await pool.query(
          "UPDATE services SET is_active = false WHERE id = $1",
          [u.service_id]
        );
      }

      // Hourly: refund overpayment before worker payout
      await processHourlyReconciliation(id).catch((err) =>
        console.error("Hourly reconciliation failed for booking", id, err.message),
      );

      // Reload booking with approved hours for payout
      const freshBooking = await pool.query(
        `SELECT b.*, s.title, s.pricing_mode AS service_pricing_mode, s.estimated_hours AS service_estimated_hours,
            s.price AS service_price,
            CASE WHEN cc.account_type = 'company' THEN cc.company_name ELSE cc.full_name END AS client_name
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN users cc ON cc.id = b.client_id
         WHERE b.id = $1`,
        [id],
      );
      const payoutBooking = freshBooking.rows[0] ?? b;

      // Credit worker wallet automatically
      finalizeCompletion(payoutBooking).catch((err) =>
        console.error("Finalize completion failed for booking", id, err.message)
      );

      // Both confirmed — send completion emails to both
      const effectivePrice = getEffectiveBookingPrice(payoutBooking);
      const taxRate = b.tax_rate ? Number(b.tax_rate) : getTaxRateForProvince(b.client_province);
      const totalPaid = (effectivePrice * (1 + 0.05 + taxRate)).toFixed(2);
      const workerReceives = workerNetFromGross(effectivePrice).toFixed(2);
      sendEmail(b.client_email, "jobCompleted", [b.client_name, b.title, b.worker_name, totalPaid, id, "client"], clientLang);
      sendEmail(b.worker_email, "jobCompleted", [b.worker_name, b.title, b.client_name, workerReceives, id, "worker"], workerLang);

      return res.json({ ...u, status: "completed" });
    }

    res.json(u);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while marking completion" });
  }
};

// ─── Customize booking (worker edits price / note) ────────────────────────────
export const customizeBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { custom_price } = req.body;
    const custom_price_min = req.body.custom_price_min ?? req.body.customPriceMin;
    const custom_price_max = req.body.custom_price_max ?? req.body.customPriceMax;
    const worker_note = req.body.worker_note === undefined
      ? undefined
      : (sanitizeText(req.body.worker_note) || null);
    const estimatedHoursRaw = req.body.estimated_hours ?? req.body.estimatedHours;
    const depositType = req.body.deposit_type ?? undefined;
    const depositValue = req.body.deposit_value ?? undefined;

    const booking = await pool.query(
      `SELECT b.*, s.title, s.price AS service_price, s.price_min, s.price_max,
              s.estimated_hours AS service_estimated_hours,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              s.deposit_enabled AS service_deposit_enabled,
              s.deposit_type AS service_deposit_type,
              s.deposit_value AS service_deposit_value,
              CASE WHEN cc.account_type = 'company' THEN cc.company_name ELSE cc.full_name END AS client_name
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users cc ON b.client_id = cc.id
       WHERE b.id = $1`,
      [id]
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: "Booking not found" });
    const b = booking.rows[0];
    const pricingMode = normalizePricingMode(b.pricing_mode);
    const listingBounds = { price: b.service_price ?? b.price, price_max: b.price_max };

    if (b.worker_id !== req.user.id) return res.status(403).json({ message: "Only the provider can customize this request" });
    const allowedStatuses =
      pricingMode === "quote"
        ? ["accepted"]
        : ["pending", "negotiating", "accepted"];
    if (!allowedStatuses.includes(b.status)) {
      return res.status(400).json({ message: "Can only customize this request in the current booking stage" });
    }
    if (
      pricingMode === "quote" &&
      b.status === "accepted" &&
      (b.custom_price == null || Number(b.custom_price) < 0.01)
    ) {
      return res.status(400).json({ message: "Agree on a price before setting deposit and note" });
    }

    let finalCustomPrice = b.custom_price;
    let finalCustomMin = b.custom_price_min;
    let finalCustomMax = b.custom_price_max;

    if (pricingMode === "range" && (custom_price_min !== undefined || custom_price_max !== undefined)) {
      const listing = { price: listingBounds.price, price_max: listingBounds.price_max };
      const lo = Number(listingBounds.price);
      const hi = Number(listingBounds.price_max);
      const min = Number(custom_price_min ?? b.custom_price_min ?? lo);
      const max = Number(custom_price_max ?? b.custom_price_max ?? hi);
      const check = validateNegotiatedRange(min, max, listing);
      if (check.error) return res.status(400).json({ message: check.error });
      finalCustomMin = min;
      finalCustomMax = max;
      const rangeChanged =
        min !== Number(b.custom_price_min ?? NaN) || max !== Number(b.custom_price_max ?? NaN);
      if (rangeChanged) finalCustomPrice = null;
    } else if (custom_price !== undefined && pricingMode !== "range" && pricingMode !== "quote") {
      const parsed = Number(custom_price);
      if (isNaN(parsed) || parsed <= 0 || parsed > 100000) {
        return res.status(400).json({ message: "Invalid price" });
      }
      if (isNegotiablePricingMode(pricingMode)) {
        const check = validateNegotiatedPrice(parsed, listingBounds, pricingMode);
        if (check.error) return res.status(400).json({ message: check.error });
      }
      finalCustomPrice = parsed;
      finalCustomMin = null;
      finalCustomMax = null;
    }
    let estimatedHours = b.estimated_hours;
    if (estimatedHoursRaw !== undefined) {
      const parsed = Number(estimatedHoursRaw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
        return res.status(400).json({ message: "Invalid estimated hours" });
      }
      estimatedHours = parsed;
    }

    const currentEffectivePrice = Number(b.custom_price ?? b.service_price ?? b.price);
    const currentEffectiveMin = Number(b.custom_price_min ?? listingBounds.price);
    const currentEffectiveMax = Number(b.custom_price_max ?? listingBounds.price_max);
    const currentEstimatedHours = Number(b.estimated_hours ?? b.service_estimated_hours);

    // Validate deposit fields if provided
    if (depositType !== undefined && !["fixed", "percent"].includes(depositType)) {
      return res.status(400).json({ message: "Invalid deposit type" });
    }
    if (depositValue !== undefined) {
      const dv = Number(depositValue);
      if (!Number.isFinite(dv) || dv < 0) return res.status(400).json({ message: "Invalid deposit value" });
      if (depositType === "percent" && dv > 100) return res.status(400).json({ message: "Deposit percent cannot exceed 100" });
    }

    const finalDepositType =
      depositValue !== undefined && Number(depositValue) === 0
        ? null
        : depositType !== undefined
          ? depositType
          : b.deposit_type;
    const finalDepositValue =
      depositValue !== undefined && Number(depositValue) === 0
        ? null
        : depositValue !== undefined
          ? Number(depositValue)
          : b.deposit_value;
    const finalDepositEnabled = Boolean(finalDepositType && finalDepositValue > 0);
    const depositValidationBase = resolveDepositBaseAmount(
      {
        pricing_mode: pricingMode,
        price:
          pricingMode === "range"
            ? Number(finalCustomMin ?? listingBounds.price)
            : pricingMode === "quote"
              ? Number(finalCustomPrice ?? b.custom_price ?? b.service_price ?? b.price)
              : Number(finalCustomPrice ?? b.custom_price ?? b.service_price ?? b.price),
        price_max:
          pricingMode === "range"
            ? Number(finalCustomMax ?? listingBounds.price_max ?? listingBounds.price)
            : Number(b.price_max ?? listingBounds.price_max ?? null),
        estimated_hours:
          pricingMode === "hourly"
            ? Number(estimatedHours ?? b.service_estimated_hours ?? 1)
            : undefined,
      },
      null,
    );
    if (finalDepositEnabled) {
      const depositCheck = validateDepositAgainstPrice(
        depositValidationBase,
        finalDepositType,
        finalDepositValue,
      );
      if (depositCheck.error) {
        return res.status(400).json({ message: depositCheck.error });
      }
    }
    const currentDeposit = resolveBookingDepositMeta(b);
    const depositChanged =
      (finalDepositType ?? null) !== (currentDeposit.deposit_type ?? null) ||
      Number(finalDepositValue ?? 0) !== Number(currentDeposit.deposit_value ?? 0) ||
      Boolean(finalDepositEnabled) !== Boolean(currentDeposit.deposit_enabled);

    // Track which fields changed
    const modifiedFields = [];
    if (
      pricingMode === "range" &&
      (custom_price_min !== undefined || custom_price_max !== undefined) &&
      (
        Number(finalCustomMin) !== currentEffectiveMin ||
        Number(finalCustomMax) !== currentEffectiveMax
      )
    ) {
      modifiedFields.push("price_range");
    } else if (
      custom_price !== undefined &&
      Number(finalCustomPrice) !== currentEffectivePrice
    ) {
      modifiedFields.push("price");
    }
    if (
      estimatedHoursRaw !== undefined &&
      Number(estimatedHours) !== currentEstimatedHours
    ) {
      modifiedFields.push("estimated_hours");
    }
    if (worker_note !== undefined && worker_note !== (b.worker_note ?? null)) {
      modifiedFields.push("description");
    }
    if ((depositType !== undefined || depositValue !== undefined) && depositChanged) {
      modifiedFields.push("deposit");
    }

    const uniqueModifiedFields = [...new Set(modifiedFields)];

    const priceChanged =
      (pricingMode === "range" && (custom_price_min !== undefined || custom_price_max !== undefined) && (
        Number(finalCustomMin) !== currentEffectiveMin ||
        Number(finalCustomMax) !== currentEffectiveMax
      )) ||
      (custom_price !== undefined && Number(finalCustomPrice) !== currentEffectivePrice);

    const result = await pool.query(
      `UPDATE bookings
       SET worker_note = $1, custom_price = $2, custom_price_min = $3, custom_price_max = $4,
           estimated_hours = $5,
           last_modified_at = NOW(), modified_fields = $6,
           deposit_type = $7, deposit_value = $8, deposit_enabled = $9,
           price_confirmed_by_client_at = CASE WHEN $11 THEN NULL ELSE price_confirmed_by_client_at END,
           price_confirmed_by_worker_at = CASE WHEN $11 THEN NULL ELSE price_confirmed_by_worker_at END
       WHERE id = $10 RETURNING *`,
      [
        worker_note !== undefined ? worker_note : b.worker_note,
        finalCustomPrice,
        finalCustomMin,
        finalCustomMax,
        estimatedHours,
        uniqueModifiedFields.length > 0 ? uniqueModifiedFields : b.modified_fields,
        finalDepositType,
        finalDepositValue,
        finalDepositEnabled,
        id,
        priceChanged,
      ],
    );

    await refreshHourlyBalanceDue(id).catch(() => {});

    // Notify client if something actually changed
    if (uniqueModifiedFields.length > 0) {
      createLocalizedNotification({
        userId: b.client_id,
        type: "booking_request",
        link: "/bookings",
        en: { title: "Request details updated", body: `The request for "${b.title}" was modified in: ${uniqueModifiedFields.join(", ")}.` },
        fr: { title: "Détails de la demande mis à jour", body: `La demande pour « ${b.title} » a été modifiée : ${uniqueModifiedFields.join(", ")}.` },
      });
    }

    res.json(
      enrichBookingRow({
        ...result.rows[0],
        pricing_mode: pricingMode,
        service_deposit_enabled: b.service_deposit_enabled,
        service_deposit_type: b.service_deposit_type,
        service_deposit_value: b.service_deposit_value,
      }),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while customizing booking" });
  }
};

// ─── Price negotiation (range / quote) ───────────────────────────────────────
export const negotiateBookingPrice = async (req, res) => {
  try {
    await ensureDepositsAndCalendarSchema(pool);
    const { id } = req.params;

    const booking = await pool.query(
      `SELECT b.*, s.title, s.price, s.price_min, s.price_max,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
              CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users uc ON b.client_id = uc.id
       JOIN users uw ON b.worker_id = uw.id
       WHERE b.id = $1`,
      [id],
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: "Booking not found" });
    const b = booking.rows[0];
    const pricingMode = normalizePricingMode(b.pricing_mode);

    if (b.client_id !== req.user.id && b.worker_id !== req.user.id) {
      return res.status(403).json({ message: "You are not part of this booking" });
    }
    if (!canRenegotiatePrice(b)) {
      return res.status(400).json({ message: "Price can only be proposed before payment" });
    }
    if (!isNegotiablePricingMode(pricingMode)) {
      return res.status(400).json({ message: "This booking does not require price negotiation" });
    }

    let notifyAmountLabel;

    const parsed = Number(req.body.custom_price ?? req.body.customPrice);
    if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 1_000_000) {
      return res.status(400).json({ message: "Invalid price" });
    }
    const check = validateNegotiatedPrice(parsed, b, pricingMode);
    if (check.error) return res.status(400).json({ message: check.error });
    const isClient = b.client_id === req.user.id;
    const isWorker = b.worker_id === req.user.id;
    let depositOverride = null;
    if (isWorker && pricingMode === "quote") {
      const parsedDeposit = parseBookingDepositOverride(req.body, b);
      if (parsedDeposit?.error) return res.status(400).json({ message: parsedDeposit.error });
      if (parsedDeposit?.finalDepositEnabled) {
        const depositCheck = validateDepositAgainstPrice(
          parsed,
          parsedDeposit.finalDepositType,
          parsedDeposit.finalDepositValue,
        );
        if (depositCheck.error) return res.status(400).json({ message: depositCheck.error });
      }
      depositOverride = parsedDeposit;
    }

    const sets = [
      `client_proposed_price = CASE WHEN $3 THEN $1 ELSE client_proposed_price END`,
      `worker_proposed_price = CASE WHEN NOT $3 THEN $1 ELSE worker_proposed_price END`,
      `custom_price = NULL`,
      `status = 'negotiating'`,
      `last_modified_at = NOW()`,
      `price_confirmed_by_client_at = NULL`,
      `price_confirmed_by_worker_at = NULL`,
      `price_selected_by_client = NULL`,
      `price_selected_by_worker = NULL`,
      `price_selected_source_by_client = NULL`,
      `price_selected_source_by_worker = NULL`,
    ];
    const updateParams = [parsed, id, isClient];
    appendDepositSets(sets, updateParams, depositOverride, 4);
    notifyAmountLabel = `${parsed.toFixed(2)} $`;

    const result = await pool.query(
      `UPDATE bookings SET ${sets.join(", ")} WHERE id = $2 RETURNING *`,
      updateParams,
    );

    const notifyId = b.client_id === req.user.id ? b.worker_id : b.client_id;
    const proposerName = b.client_id === req.user.id ? b.client_name : b.worker_name;
    createLocalizedNotification({
      userId: notifyId,
      type: "booking_request",
      link: "/bookings",
      en: {
        title: "New price proposed",
        body: `A price of ${notifyAmountLabel} was proposed for "${b.title}". Review and confirm if you agree.`,
      },
      fr: {
        title: "Nouveau prix proposé",
        body: `Un prix de ${notifyAmountLabel} a été proposé pour « ${b.title} ». Vérifiez et confirmez si vous êtes d'accord.`,
      },
    });

    pushPriceProposed(notifyId, {
      proposerName,
      amount: notifyAmountLabel,
      serviceTitle: b.title,
    }).catch(() => {});

    res.json(enrichBookingRow({ ...result.rows[0], pricing_mode: pricingMode }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while proposing price" });
  }
};

export const confirmBookingPrice = async (req, res) => {
  try {
    await ensureDepositsAndCalendarSchema(pool);
    const { id } = req.params;
    const userId = req.user.id;

    const booking = await pool.query(
      `SELECT b.*, s.title, s.price, s.price_min, s.price_max,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
              CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users uc ON b.client_id = uc.id
       JOIN users uw ON b.worker_id = uw.id
       WHERE b.id = $1`,
      [id],
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: "Booking not found" });
    const b = booking.rows[0];

    if (b.client_id !== userId && b.worker_id !== userId) {
      return res.status(403).json({ message: "You are not part of this booking" });
    }
    if (!canRenegotiatePrice(b) || b.status !== "negotiating") {
      return res.status(400).json({ message: "Price confirmation is only available during negotiation" });
    }

    const pricingMode = normalizePricingMode(b.pricing_mode);
    const proposals = getPartyProposals(b);
    const allowed = [proposals.client, proposals.worker].filter((p) => p != null);
    const selectedPrice = Number(req.body.selected_price ?? req.body.selectedPrice);
    const requestedSelectedSource = req.body.selected_source ?? req.body.selectedSource ?? null;
    const normalizedSelectedSource =
      requestedSelectedSource === "client" || requestedSelectedSource === "worker"
        ? requestedSelectedSource
        : null;

    if (allowed.length === 0) {
      if (b.custom_price != null && Number(b.custom_price) >= 0.01) {
        allowed.push(Number(b.custom_price));
      } else {
        return res.status(400).json({ message: "A price must be proposed before confirmation" });
      }
    }

    if (!Number.isFinite(selectedPrice) || selectedPrice < 0.01) {
      return res.status(400).json({ message: "Select a proposed price to confirm" });
    }
    if (!allowed.some((p) => pricesMatch(p, selectedPrice))) {
      return res.status(400).json({ message: "You must select one of the active proposals" });
    }

    const clientMatches = proposals.client != null && pricesMatch(proposals.client, selectedPrice);
    const workerMatches = proposals.worker != null && pricesMatch(proposals.worker, selectedPrice);
    let selectedSource = normalizedSelectedSource;
    if (!selectedSource) {
      if (clientMatches && !workerMatches) selectedSource = "client";
      else if (workerMatches && !clientMatches) selectedSource = "worker";
      else if (clientMatches && workerMatches) {
        return res.status(400).json({ message: "Select which proposal you want to confirm" });
      }
    }
    if (!selectedSource) {
      return res.status(400).json({ message: "The selected proposal is no longer available" });
    }
    if (selectedSource === "client" && !clientMatches) {
      return res.status(400).json({ message: "The selected client proposal does not match the chosen amount" });
    }
    if (selectedSource === "worker" && !workerMatches) {
      return res.status(400).json({ message: "The selected provider proposal does not match the chosen amount" });
    }

    const check = validateNegotiatedPrice(selectedPrice, b, pricingMode);
    if (check.error) return res.status(400).json({ message: check.error });

    const agreedLabel = `${selectedPrice.toFixed(2)} $`;

    const isClient = b.client_id === userId;
    const isWorker = b.worker_id === userId;
    let depositOverride = null;
    if (isWorker && pricingMode === "quote") {
      const parsedDeposit = parseBookingDepositOverride(req.body, b);
      if (parsedDeposit?.error) return res.status(400).json({ message: parsedDeposit.error });
      if (parsedDeposit?.finalDepositEnabled) {
        const depositCheck = validateDepositAgainstPrice(
          selectedPrice,
          parsedDeposit.finalDepositType,
          parsedDeposit.finalDepositValue,
        );
        if (depositCheck.error) return res.status(400).json({ message: depositCheck.error });
      }
      depositOverride = parsedDeposit;
    }
    const confirmCol = isClient ? "price_confirmed_by_client_at" : "price_confirmed_by_worker_at";
    const selectCol = isClient ? "price_selected_by_client" : "price_selected_by_worker";
    const selectSourceCol = isClient ? "price_selected_source_by_client" : "price_selected_source_by_worker";

    const confirmSets = [`${confirmCol} = NOW()`, `${selectCol} = $2`, `${selectSourceCol} = $3`];
    const confirmParams = [id, selectedPrice, selectedSource];
    appendDepositSets(confirmSets, confirmParams, depositOverride, 4);

    let result = await pool.query(
      `UPDATE bookings SET ${confirmSets.join(", ")} WHERE id = $1 RETURNING *`,
      confirmParams,
    );
    const updated = result.rows[0];

    if (isPriceAgreementComplete(updated)) {
      const agreedAmount = Number(updated.price_selected_by_client);
      result = await pool.query(
        `UPDATE bookings SET status = 'accepted', custom_price = $2 WHERE id = $1 RETURNING *`,
        [id, agreedAmount],
      );
      const finalRow = result.rows[0];

      createLocalizedNotification({
        userId: b.client_id,
        type: "booking_request",
        link: `/bookings?booking=${id}`,
        en: {
          title: "Price agreed — proceed to payment",
          body: `You agreed on ${agreedLabel} for "${b.title}". Complete payment to start the job.`,
        },
        fr: {
          title: "Prix convenu — procédez au paiement",
          body: `Vous avez convenu de ${agreedLabel} pour « ${b.title} ». Effectuez le paiement pour démarrer le mandat.`,
        },
      });
      createLocalizedNotification({
        userId: b.worker_id,
        type: "booking_request",
        link: `/bookings?booking=${id}`,
        en: {
          title: "Price agreed — awaiting payment",
          body: `The client agreed on ${agreedLabel} for "${b.title}". Waiting for payment.`,
        },
        fr: {
          title: "Prix convenu — en attente du paiement",
          body: `Le client a convenu de ${agreedLabel} pour « ${b.title} ». En attente du paiement.`,
        },
      });

      pushPriceAgreed(b.client_id, {
        amount: agreedLabel,
        serviceTitle: b.title,
        awaitingPayment: true,
      }).catch(() => {});
      pushPriceAgreed(b.worker_id, {
        amount: agreedLabel,
        serviceTitle: b.title,
        awaitingPayment: false,
      }).catch(() => {});

      return res.json(enrichBookingRow({ ...finalRow, pricing_mode: pricingMode }));
    }

    const notifyId = isClient ? b.worker_id : b.client_id;
    const confirmerName = isClient ? b.client_name : b.worker_name;
    createLocalizedNotification({
      userId: notifyId,
      type: "booking_request",
      link: `/bookings?booking=${id}`,
      en: {
        title: "Price confirmation received",
        body: `The other party confirmed the price for "${b.title}". Confirm on your side to finalize.`,
      },
      fr: {
        title: "Confirmation de prix reçue",
        body: `L'autre partie a confirmé le prix pour « ${b.title} ». Confirmez de votre côté pour finaliser.`,
      },
    });

    pushPriceConfirmRequest(notifyId, {
      confirmerName,
      amount: agreedLabel,
      serviceTitle: b.title,
    }).catch(() => {});

    res.json(enrichBookingRow({ ...updated, pricing_mode: pricingMode }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while confirming price" });
  }
};

// ─── Direct cancellation for active bookings is deprecated in favor of disputes ─
export const requestCancellation = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const booking = await pool.query(
      `SELECT b.*, s.title FROM bookings b JOIN services s ON b.service_id = s.id WHERE b.id = $1`,
      [id]
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: "Booking not found" });
    const b = booking.rows[0];

    if (b.client_id !== userId && b.worker_id !== userId) {
      return res.status(403).json({ message: "You are not part of this booking" });
    }

    if (b.status === "active") {
      return res.status(400).json({
        message: "In-progress bookings can no longer be cancelled directly. Open a dispute instead.",
      });
    }

    return res.status(400).json({ message: "Direct cancellation requests are no longer supported for this booking." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while processing cancellation" });
  }
};

// ─── Decline cancellation request ─────────────────────────────────────────────
export const declineCancellation = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const booking = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
    if (booking.rows.length === 0) return res.status(404).json({ message: "Booking not found" });
    const b = booking.rows[0];

    if (b.client_id !== userId && b.worker_id !== userId) {
      return res.status(403).json({ message: "You are not part of this booking" });
    }
    if (!b.cancel_requested_by || b.cancel_requested_by === userId) {
      return res.status(400).json({ message: "No pending cancellation to decline" });
    }

    const result = await pool.query(
      `UPDATE bookings SET cancel_requested_by = NULL, cancel_reason = NULL WHERE id = $1 RETURNING *`,
      [id]
    );
    // Notify requester that it was declined
    createLocalizedNotification({
      userId: b.cancel_requested_by,
      type: "booking_rejected",
      link: "/bookings",
      en: { title: "Cancellation declined", body: `The other party declined your cancellation request.` },
      fr: { title: "Annulation refusée", body: `L'autre partie a refusé votre demande d'annulation.` },
    });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while declining cancellation" });
  }
};

export const getBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    // Dynamic import avoids circular dependency with paymentCompletionService.
    const { repairDoubledDepositPaidBase } = await import("../services/paymentCompletionService.js");
    await repairDoubledDepositPaidBase(id).catch(() => {});
    const result = await pool.query(
      `SELECT b.*, s.title, s.price, s.image_url, s.image_urls, s.category,
              s.hide_exact_location,
              s.location, s.address, s.city, s.latitude, s.longitude, s.locations,
              d.dispute_id,
              d.dispute_status,
              d.dispute_resolution,
              d.dispute_created_at,
              d.dispute_refund_percentage,
              CASE
                WHEN s.hide_exact_location = true
                  THEN COALESCE(NULLIF(TRIM(s.city), ''), NULLIF(TRIM(s.location), ''), NULLIF(TRIM(s.address), ''))
                ELSE COALESCE(NULLIF(TRIM(s.address), ''), NULLIF(TRIM(s.location), ''), NULLIF(TRIM(s.city), ''))
              END AS service_location,
              s.is_one_time, s.type AS service_type,
              s.description AS service_description,
              s.deposit_enabled AS service_deposit_enabled,
              s.deposit_type AS service_deposit_type,
              s.deposit_value AS service_deposit_value,
              CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
              COALESCE(b.client_province, uc.province) AS client_province,
              uw.province AS worker_province,
              EXISTS(SELECT 1 FROM reviews WHERE booking_id = b.id AND reviewer_id = $2) AS has_reviewed,
              (d.dispute_id IS NOT NULL) AS has_dispute,
              b.payment_status, b.completed_by_worker, b.completed_by_client,
              b.worker_note, b.custom_price, b.last_modified_at, b.modified_fields,
              b.cancel_requested_by, b.cancel_reason, b.completed_at,
              b.deposit_amount_cents,
              b.paid_service_base_cents,
              b.balance_due_cents,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              COALESCE(b.estimated_hours, s.estimated_hours) AS estimated_hours,
              b.approved_hours_total,
              s.price_max
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users uw ON b.worker_id = uw.id
       JOIN users uc ON b.client_id = uc.id
       LEFT JOIN LATERAL (
         SELECT d1.id AS dispute_id, d1.status AS dispute_status, d1.resolution AS dispute_resolution, d1.created_at AS dispute_created_at, d1.refund_percentage AS dispute_refund_percentage
         FROM disputes d1
         WHERE d1.booking_id = b.id
         ORDER BY d1.created_at DESC
         LIMIT 1
       ) d ON true
       WHERE b.id = $1 AND (b.client_id = $2 OR b.worker_id = $2)`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }
    res.json(enrichBookingRow(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const cancelWithDeposit = async (req, res) => {
  try {
    await ensureDepositsAndCalendarSchema(pool);
    const { id } = req.params;
    const result = await processDepositCancellationRefund({
      bookingId: id,
      cancelledByUserId: req.user.id,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error while cancelling booking" });
  }
};

export const getAdminBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT b.*, s.title, s.price, s.image_url, s.image_urls, s.category,
              d.dispute_id,
              d.dispute_status,
              d.dispute_resolution,
              d.dispute_created_at,
              d.dispute_refund_percentage,
              COALESCE(NULLIF(TRIM(s.address), ''), NULLIF(TRIM(s.location), ''), NULLIF(TRIM(s.city), '')) AS service_location,
              s.is_one_time, s.type AS service_type,
              s.description AS service_description,
              s.deposit_enabled AS service_deposit_enabled,
              s.deposit_type AS service_deposit_type,
              s.deposit_value AS service_deposit_value,
              CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
              CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
              uc.email AS client_email,
              uw.email AS worker_email,
              uc.province AS client_province,
              uw.province AS worker_province,
              uc.avatar AS client_avatar_url,
              uw.avatar AS worker_avatar_url,
              FALSE AS has_reviewed,
              (d.dispute_id IS NOT NULL) AS has_dispute,
              b.payment_status, b.completed_by_worker, b.completed_by_client,
              b.worker_note, b.custom_price, b.last_modified_at, b.modified_fields,
              b.cancel_requested_by, b.cancel_reason, b.completed_at,
              b.deposit_amount_cents,
              b.paid_service_base_cents,
              b.balance_due_cents,
              COALESCE(b.pricing_mode, s.pricing_mode) AS pricing_mode,
              COALESCE(b.estimated_hours, s.estimated_hours) AS estimated_hours,
              b.approved_hours_total,
              s.price_max
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users uw ON b.worker_id = uw.id
       JOIN users uc ON b.client_id = uc.id
       LEFT JOIN LATERAL (
         SELECT d1.id AS dispute_id, d1.status AS dispute_status, d1.resolution AS dispute_resolution, d1.created_at AS dispute_created_at, d1.refund_percentage AS dispute_refund_percentage
         FROM disputes d1
         WHERE d1.booking_id = b.id
         ORDER BY d1.created_at DESC
         LIMIT 1
       ) d ON true
       WHERE b.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("getAdminBookingById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Undo mark completed (only if other party hasn't confirmed yet) ───────────
export const undoMarkCompleted = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const booking = await pool.query(
      `SELECT b.*, s.title,
              cw.email AS worker_email, CASE WHEN cw.account_type = 'company' THEN cw.company_name ELSE cw.full_name END AS worker_name,
              cc.email AS client_email, CASE WHEN cc.account_type = 'company' THEN cc.company_name ELSE cc.full_name END AS client_name
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users cw ON b.worker_id = cw.id
       JOIN users cc ON b.client_id = cc.id
       WHERE b.id = $1`,
      [id]
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: "Booking not found" });
    const b = booking.rows[0];

    if (b.status !== "active") return res.status(400).json({ message: "Booking is not active" });
    if (b.client_id !== userId && b.worker_id !== userId) return res.status(403).json({ message: "Not authorized" });

    const isWorker = b.worker_id === userId;
    const myFlag  = isWorker ? b.completed_by_worker : b.completed_by_client;
    const otherFlag = isWorker ? b.completed_by_client : b.completed_by_worker;

    if (!myFlag) return res.status(400).json({ message: "You haven't marked this done yet" });
    if (otherFlag) return res.status(400).json({ message: "The other party already confirmed — cannot undo" });

    const updateField = isWorker ? "completed_by_worker" : "completed_by_client";
    const result = await pool.query(
      `UPDATE bookings SET ${updateField} = false WHERE id = $1 RETURNING *`,
      [id]
    );

    // Notify the other party
    const markerName  = isWorker ? b.worker_name : b.client_name;
    const otherUserId = isWorker ? b.client_id   : b.worker_id;
    const otherEmail  = isWorker ? b.client_email : b.worker_email;
    const otherName   = isWorker ? b.client_name  : b.worker_name;

    createLocalizedNotification({
      userId: otherUserId,
      type: "booking_request",
      link: "/bookings",
      en: { title: "Confirmation cancelled", body: `${markerName} cancelled their completion confirmation for "${b.title}". The work is still in progress.` },
      fr: { title: "Confirmation annulée", body: `${markerName} a annulé sa confirmation de fin de travail pour « ${b.title} ». Le travail est toujours en cours.` },
    }).catch(() => {});

    getUserLang(otherUserId).then((lang) =>
      sendEmail(otherEmail, "jobMarkUndone", [otherName, markerName, b.title, id], lang)
    ).catch((err) => console.error("[undoMarkCompleted] Email failed:", err.message));

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function autoRejectOtherRequests(serviceId, acceptedBookingId) {
  // Get all other pending bookings for this service
  const others = await pool.query(
    `SELECT b.id, b.client_id, b.worker_id, s.title, s.type AS service_type
     FROM bookings b
     JOIN services s ON b.service_id = s.id
     WHERE b.service_id = $1 AND b.status = 'pending' AND b.id != $2`,
    [serviceId, acceptedBookingId]
  );

  if (others.rows.length > 0) {
    await pool.query(
      "UPDATE bookings SET status = 'rejected' WHERE service_id = $1 AND status = 'pending' AND id != $2",
      [serviceId, acceptedBookingId]
    );
    // Notify each rejected applicant (worker_id for "looking", client_id for "offer")
    for (const b of others.rows) {
      const notifyId = b.service_type === "looking" ? b.worker_id : b.client_id;
      createLocalizedNotification({
        userId: notifyId,
        type: "booking_rejected",
        link: "/bookings",
        en: { title: "Request no longer available", body: `Your request for "${b.title}" was closed — the listing has been filled.` },
        fr: { title: "Demande non disponible", body: `Votre demande pour « ${b.title} » a été fermée — l'annonce est remplie.` },
      });
    }
  }

  // Deactivate the listing so it no longer appears publicly
  await pool.query(
    "UPDATE services SET is_active = false WHERE id = $1",
    [serviceId]
  );
}

export async function finalizeCompletion(booking) {
  if (booking.payment_status !== "paid") {
    return false;
  }
  const listingTitle = (booking.title || "").trim();
  const effectivePrice = getEffectiveBookingPrice(booking);
  // Worker receives net share (platform keeps WORKER_COMMISSION_RATE)
  const workerReceives = workerNetFromGross(effectivePrice);

  // Ensure worker wallet exists
  await pool.query(
    "INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [booking.worker_id]
  );

  // Guard both the transaction insert AND the wallet update against duplicates
  const existingCredit = await pool.query(
    "SELECT id FROM transactions WHERE booking_id = $1 AND type = 'credit'",
    [booking.id]
  );
  if (existingCredit.rows.length === 0) {
    await pool.query(
      `INSERT INTO transactions (user_id, booking_id, type, amount, description, other_user_name, listing_title)
       VALUES ($1, $2, 'credit', $3, 'Payment received for completed work', $4, $5)`,
      [booking.worker_id, booking.id, workerReceives, booking.client_name, listingTitle || null]
    );
    // Only credit wallet if transaction didn't already exist
    await pool.query(
      `UPDATE wallets
       SET balance = balance + $1, total_earned = total_earned + $1, updated_at = NOW()
       WHERE user_id = $2`,
      [workerReceives, booking.worker_id]
    );
  }

  if (existingCredit.rows.length > 0) {
    return false;
  }

  // Notify worker: payment received
  createLocalizedNotification({
    userId: booking.worker_id,
    type: "payment",
    link: "/wallet",
    en: {
      title: "Payment received",
      body: listingTitle
        ? `You received $${workerReceives.toFixed(2)} for "${listingTitle}"`
        : `You received $${workerReceives.toFixed(2)} for completed work`,
    },
    fr: {
      title: "Paiement reçu",
      body: listingTitle
        ? `Vous avez reçu ${workerReceives.toFixed(2)} $ pour « ${listingTitle} »`
        : `Vous avez reçu ${workerReceives.toFixed(2)} $ pour un travail complété`,
    },
  });

  // Notify both: listing completed
  const receiptLink = `/bookings?booking=${booking.id}`;
  createLocalizedNotification({
    userId: booking.worker_id,
    type: "booking_completed",
    link: receiptLink,
    en: {
      title: "Listing completed",
      body: listingTitle
        ? `"${listingTitle}" has been marked as completed.`
        : "Your booking has been marked as completed.",
    },
    fr: {
      title: "Travail terminé",
      body: listingTitle
        ? `« ${listingTitle} » a été marqué comme terminé.`
        : "Votre réservation a été marquée comme terminée.",
    },
  });
  createLocalizedNotification({
    userId: booking.client_id,
    type: "booking_completed",
    link: receiptLink,
    en: {
      title: "Listing completed",
      body: listingTitle
        ? `"${listingTitle}" has been marked as completed.`
        : "Your booking has been marked as completed.",
    },
    fr: {
      title: "Travail terminé",
      body: listingTitle
        ? `« ${listingTitle} » a été marqué comme terminé.`
        : "Votre réservation a été marquée comme terminée.",
    },
  });

  return true;
}

