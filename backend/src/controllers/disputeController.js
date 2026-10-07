import pool from "../config/db.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { notifyDisputeCreated, notifyDisputeOutcome } from "../services/emailService.js";
import { createLocalizedNotification, getUserLang, shouldSendEmail } from "../services/notificationService.js";
import { buildRefundSummary, processBookingRefund } from "../services/refundService.js";
import { logAdminAction } from "../services/auditService.js";
import { isValidUUID, sanitizeText } from "../utils/validate.js";

const DISPUTE_ATTACHMENTS_BUCKET = "dispute-attachments";
const MAX_DISPUTE_ATTACHMENTS = 4;

function sanitizeAttachmentName(fileName = "attachment") {
    return fileName
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "attachment";
}

function getAttachmentExtension(file) {
    const fromName = file.originalname?.split(".").pop()?.trim().toLowerCase();
    if (fromName) return fromName;

    const fromType = file.mimetype?.split("/").pop()?.trim().toLowerCase();
    if (fromType === "jpeg") return "jpg";
    return fromType || "bin";
}

function normalizeDisputeAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];

    return attachments
        .filter((attachment) => attachment && typeof attachment.url === "string" && typeof attachment.name === "string")
        .slice(0, MAX_DISPUTE_ATTACHMENTS)
        .map((attachment) => ({
            url: attachment.url.trim(),
            name: attachment.name.trim(),
        }))
        .filter((attachment) => attachment.url && attachment.name);
}

async function getDisputeWithParticipants(disputeId) {
    const dispute = await pool.query(
        `SELECT d.*, b.client_id, b.worker_id
         FROM disputes d
         JOIN bookings b ON d.booking_id = b.id
         WHERE d.id = $1`,
        [disputeId]
    );

    return dispute.rows[0] || null;
}

async function getDisputeAttachmentCount(disputeId) {
    const result = await pool.query(
        `SELECT COALESCE(SUM(jsonb_array_length(COALESCE(attachments, '[]'::jsonb))), 0) AS attachment_count
         FROM dispute_messages
         WHERE dispute_id = $1`,
        [disputeId]
    );

    return Number(result.rows[0]?.attachment_count || 0);
}

export const CreateDispute = async (req, res) => {
    try {
        const { booking_id } = req.body;
        const description = sanitizeText(req.body.description ?? "").trim();
        const raised_by = req.user.id;

        if (!isValidUUID(booking_id)) {
            return res.status(404).json({ message: "Booking not found" });
        }
        if (!description) {
            return res.status(400).json({ message: "Describe the problem to open a complaint" });
        }
        if (description.length > 5000) {
            return res.status(400).json({ message: "The description must be at most 5000 characters" });
        }

        const booking = await pool.query("SELECT * FROM bookings WHERE id = $1", [booking_id]);
        if (booking.rows.length === 0) {
            return res.status(404).json({message: "Booking not found" });
        }
        const b = booking.rows[0];
        if (b.client_id !== req.user.id && b.worker_id !== req.user.id) {
            return res.status(403).json({ message: "You are not part of this booking" });
        }

        // A complaint settles money that changed hands: an unpaid request has
        // nothing to refund or withhold (cancel or reject it instead).
        const paid = ["paid", "deposit_paid", "transferred"].includes(b.payment_status);
        if (!paid || !["active", "completed"].includes(b.status)) {
            return res.status(400).json({ message: "A complaint can only be opened on a paid booking in progress or completed." });
        }

        // Dispute only allowed within 3 days of completion
        if (b.status === "completed" && b.completed_at) {
            const daysSinceCompletion = (Date.now() - new Date(b.completed_at).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceCompletion > 3) {
                return res.status(400).json({ message: "The 3-day dispute window has expired for this booking." });
            }
        }

        // disputes_one_per_booking (unique index) settles a double submit.
        const result = await pool.query(
            `INSERT INTO disputes (booking_id, raised_by, description, status)
             VALUES ($1, $2, $3, 'open')
             ON CONFLICT (booking_id) DO NOTHING
             RETURNING *`,
            [booking_id, raised_by, description]
        );
        if (result.rows.length === 0) {
            return res.status(409).json({ message: "A dispute already exists for this booking" });
        }

        res.status(201).json(result.rows[0]);

        // The dispute is saved: failing notifications must not turn it into a 500.
        notifyDisputeParties(b, raised_by, description).catch((err) =>
            console.error("Dispute notifications failed:", err.message),
        );
    } catch (err){
        console.error(err);
        res.status(500).json({ message: "Server error while creating dispute" });
    }
}

async function notifyDisputeParties(b, raisedBy, description) {
    const users = await pool.query(
        `SELECT
            u1.email as client_email,
            CASE WHEN u1.account_type = 'company' THEN u1.company_name ELSE u1.full_name END as client_name,
            u2.email as worker_email,
            CASE WHEN u2.account_type = 'company' THEN u2.company_name ELSE u2.full_name END as worker_name
        FROM users u1, users u2
        WHERE u1.id = $1 AND u2.id = $2`,
        [b.client_id, b.worker_id]
    );
    if (users.rows.length === 0) return;

    const { client_email, client_name, worker_email, worker_name } = users.rows[0];
    const [clientLang, workerLang] = await Promise.all([
      getUserLang(b.client_id),
      getUserLang(b.worker_id),
    ]);
    if (await shouldSendEmail(b.client_id, "complaint"))
      await notifyDisputeCreated(client_email, client_name, b.id, description, clientLang);
    if (await shouldSendEmail(b.worker_id, "complaint"))
      await notifyDisputeCreated(worker_email, worker_name, b.id, description, workerLang);

    // Notify the other party in-app
    const otherPartyId = raisedBy === b.client_id ? b.worker_id : b.client_id;
    const raisedByName = raisedBy === b.client_id ? client_name : worker_name;
    createLocalizedNotification({
      userId: otherPartyId,
      type: "dispute",
      link: "/bookings",
      en: { title: "Complaint opened", body: `${raisedByName} opened a complaint about a booking.` },
      fr: { title: "Plainte ouverte", body: `${raisedByName} a ouvert une plainte concernant une réservation.` },
    });
}

export const GetDisputes = async (req, res) => {
    try{
        const { id } = req.params;

        const result = await pool.query(
            `SELECT d.* FROM disputes d
             JOIN bookings b ON b.id = d.booking_id
             WHERE d.id = $1 AND (b.client_id = $2 OR b.worker_id = $2)`,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Dispute not found" });
        }

        res.status(200).json(result.rows[0]);

    } catch(err){
        console.error(err);
        res.status(500).json({ message: "Server error while fetching dispute" });
    }
}

export const UpdateDispute = async (req, res) => {
    return res.status(403).json({ message: "Only admins can update dispute status" });
}

// ─── Dispute thread ───────────────────────────────────────────────────────────

export const GetDisputeByBooking = async (req, res) => {
    try {
        const { bookingId } = req.params;
        const userId = req.user.id;

        // Verify user is part of this booking
        const booking = await pool.query(
            `SELECT client_id, worker_id FROM bookings WHERE id = $1`,
            [bookingId]
        );
        if (booking.rows.length === 0) return res.status(404).json({ message: "Booking not found" });
        const b = booking.rows[0];
        if (b.client_id !== userId && b.worker_id !== userId) {
            return res.status(403).json({ message: "Not authorized" });
        }

        const dispute = await pool.query(
            `SELECT * FROM disputes WHERE booking_id = $1 LIMIT 1`,
            [bookingId]
        );
        if (dispute.rows.length === 0) return res.status(404).json({ message: "No dispute found" });
        const d = dispute.rows[0];

        const messages = await pool.query(
            `SELECT dm.*, COALESCE(dm.attachments, '[]'::jsonb) AS attachments,
                CASE WHEN u.account_type = 'company' THEN u.company_name ELSE u.full_name END AS sender_name,
                u.account_type AS sender_account_type
             FROM dispute_messages dm
             JOIN users u ON dm.user_id = u.id
             WHERE dm.dispute_id = $1
             ORDER BY dm.created_at ASC`,
            [d.id]
        );

        res.json({ dispute: d, messages: messages.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
};

export const UploadDisputeAttachments = async (req, res) => {
    const uploadedPaths = [];

    try {
        const { disputeId } = req.params;
        const userId = req.user.id;
        const files = Array.isArray(req.files) ? req.files : [];

        if (files.length === 0) {
            return res.status(400).json({ message: "No files uploaded" });
        }

        const dispute = await getDisputeWithParticipants(disputeId);
        if (!dispute) {
            return res.status(404).json({ message: "Dispute not found" });
        }
        if (dispute.client_id !== userId && dispute.worker_id !== userId) {
            return res.status(403).json({ message: "Not authorized" });
        }
        if (dispute.status !== "open") {
            return res.status(400).json({ message: "This dispute is closed. No more files can be uploaded." });
        }

        const existingAttachmentCount = await getDisputeAttachmentCount(disputeId);
        const remainingAttachmentSlots = MAX_DISPUTE_ATTACHMENTS - existingAttachmentCount;
        if (remainingAttachmentSlots <= 0) {
            return res.status(400).json({ message: `This dispute already has the maximum of ${MAX_DISPUTE_ATTACHMENTS} photos.` });
        }
        if (files.length > remainingAttachmentSlots) {
            return res.status(400).json({
                message: `You can only add ${remainingAttachmentSlots} more photo${remainingAttachmentSlots > 1 ? "s" : ""} to this dispute.`,
            });
        }

        const attachments = [];

        for (const [index, file] of files.entries()) {
            const extension = getAttachmentExtension(file);
            const baseName = sanitizeAttachmentName(file.originalname?.replace(/\.[^.]+$/, "") || `attachment-${index + 1}`);
            const path = `${disputeId}/${userId}/${Date.now()}-${index}-${baseName}.${extension}`;

            const { error } = await supabaseAdmin.storage
                .from(DISPUTE_ATTACHMENTS_BUCKET)
                .upload(path, file.buffer, {
                    contentType: file.mimetype,
                    upsert: false,
                });

            if (error) {
                throw error;
            }

            uploadedPaths.push(path);
            const { data } = supabaseAdmin.storage.from(DISPUTE_ATTACHMENTS_BUCKET).getPublicUrl(path);
            attachments.push({
                url: data.publicUrl,
                name: file.originalname,
            });
        }

        return res.status(201).json({ attachments });
    } catch (err) {
        if (uploadedPaths.length > 0) {
            await supabaseAdmin.storage.from(DISPUTE_ATTACHMENTS_BUCKET).remove(uploadedPaths).catch(() => {});
        }

        console.error(err);
        return res.status(500).json({ message: "Server error while uploading dispute attachments" });
    }
};

export const PostDisputeMessage = async (req, res) => {
    try {
        const { disputeId } = req.params;
        const { content, attachments } = req.body;
        const userId = req.user.id;
        const normalizedAttachments = normalizeDisputeAttachments(attachments);

        if (!content?.trim() && normalizedAttachments.length === 0) {
            return res.status(400).json({ message: "Message cannot be empty" });
        }

        // Verify dispute exists and user is part of it
        const d = await getDisputeWithParticipants(disputeId);
        if (!d) return res.status(404).json({ message: "Dispute not found" });
        if (d.client_id !== userId && d.worker_id !== userId) {
            return res.status(403).json({ message: "Not authorized" });
        }
        if (d.status !== 'open') {
            return res.status(400).json({ message: "This dispute is closed. No more messages can be sent." });
        }
        const existingAttachmentCount = await getDisputeAttachmentCount(disputeId);
        if (existingAttachmentCount + normalizedAttachments.length > MAX_DISPUTE_ATTACHMENTS) {
            const remainingAttachmentSlots = Math.max(0, MAX_DISPUTE_ATTACHMENTS - existingAttachmentCount);
            return res.status(400).json({
                message: remainingAttachmentSlots > 0
                    ? `You can only add ${remainingAttachmentSlots} more photo${remainingAttachmentSlots > 1 ? "s" : ""} to this dispute.`
                    : `This dispute already has the maximum of ${MAX_DISPUTE_ATTACHMENTS} photos.`,
            });
        }

        const result = await pool.query(
            `INSERT INTO dispute_messages (dispute_id, user_id, content, attachments)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [disputeId, userId, content?.trim() || '', JSON.stringify(normalizedAttachments)]
        );

        const msg = result.rows[0];

        // Enrich with sender name
        const user = await pool.query(
            `SELECT CASE WHEN account_type = 'company' THEN company_name ELSE full_name END AS sender_name, account_type AS sender_account_type FROM users WHERE id = $1`,
            [userId]
        );
        res.status(201).json({ ...msg, ...user.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
};

// ─── Admin endpoints ──────────────────────────────────────────────────────────

export const AdminGetAllDisputes = async (_req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                d.id, d.status, d.description, d.resolution, d.created_at,
                d.booking_id,
                b.service_id,
                b.status AS booking_status,
                b.payment_status,
                s.title AS service_title,
                COALESCE(b.custom_price, s.price) AS service_price,
                CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
                uc.email AS client_email,
                CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
                uw.email AS worker_email,
                CASE WHEN ur.account_type = 'company' THEN ur.company_name ELSE ur.full_name END AS raised_by_name,
                d.raised_by,
                (SELECT COUNT(*) FROM dispute_messages dm WHERE dm.dispute_id = d.id) AS message_count
             FROM disputes d
             JOIN bookings b ON d.booking_id = b.id
             JOIN services s ON b.service_id = s.id
             JOIN users uc ON b.client_id = uc.id
             JOIN users uw ON b.worker_id = uw.id
             JOIN users ur ON d.raised_by = ur.id
             ORDER BY d.created_at DESC`
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error fetching disputes" });
    }
};

export const AdminGetDisputeDetail = async (req, res) => {
    try {
        const { id } = req.params;

        const disputeResult = await pool.query(
            `SELECT
                d.id, d.status, d.description, d.resolution, d.created_at,
                d.booking_id, d.raised_by, d.refund_percentage,
                b.status AS booking_status,
                b.payment_status,
                b.completed_at,
                b.tax_rate,
                b.created_at AS booking_created_at,
                b.service_id,
                COALESCE(b.custom_price, s.price) AS booking_price,
                s.title AS service_title,
                s.price AS service_price,
                s.image_url AS service_image_url,
                CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
                uc.email AS client_email,
                uc.id AS client_id,
                CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
                uw.email AS worker_email,
                uw.id AS worker_id,
                CASE WHEN ur.account_type = 'company' THEN ur.company_name ELSE ur.full_name END AS raised_by_name,
                p.id AS payment_id,
                p.amount AS payment_amount,
                p.platform_fee,
                p.status AS payment_record_status,
                p.currency,
                p.created_at AS payment_created_at
             FROM disputes d
             JOIN bookings b ON d.booking_id = b.id
             JOIN services s ON b.service_id = s.id
             JOIN users uc ON b.client_id = uc.id
             JOIN users uw ON b.worker_id = uw.id
             JOIN users ur ON d.raised_by = ur.id
             LEFT JOIN LATERAL (
                SELECT *
                FROM payments p2
                WHERE p2.booking_id = b.id
                ORDER BY p2.created_at DESC
                LIMIT 1
             ) p ON true
             WHERE d.id = $1`,
            [id]
        );

        if (disputeResult.rows.length === 0) {
            return res.status(404).json({ message: "Dispute not found" });
        }

        const detail = disputeResult.rows[0];
        const messages = await pool.query(
                `SELECT dm.*, COALESCE(dm.attachments, '[]'::jsonb) AS attachments,
                    CASE WHEN u.account_type = 'company' THEN u.company_name ELSE u.full_name END AS sender_name,
                    u.email AS sender_email
             FROM dispute_messages dm
             JOIN users u ON u.id = dm.user_id
             WHERE dm.dispute_id = $1
             ORDER BY dm.created_at ASC`,
            [id]
        );

        res.status(200).json({
            dispute: {
                id: detail.id,
                status: detail.status,
                description: detail.description,
                resolution: detail.resolution,
                refund_percentage: detail.refund_percentage ? Number(detail.refund_percentage) : null,
                created_at: detail.created_at,
                booking_id: detail.booking_id,
                raised_by: detail.raised_by,
                raised_by_name: detail.raised_by_name,
            },
            booking: {
                id: detail.booking_id,
                service_id: detail.service_id,
                status: detail.booking_status,
                payment_status: detail.payment_status,
                completed_at: detail.completed_at,
                created_at: detail.booking_created_at,
                service_title: detail.service_title,
                service_price: detail.service_price,
                booking_price: detail.booking_price,
                service_image_url: detail.service_image_url,
            },
            parties: {
                client: {
                    id: detail.client_id,
                    name: detail.client_name,
                    email: detail.client_email,
                },
                worker: {
                    id: detail.worker_id,
                    name: detail.worker_name,
                    email: detail.worker_email,
                },
            },
            payment: detail.payment_id ? {
                id: detail.payment_id,
                amount: detail.payment_amount,
                platform_fee: detail.platform_fee,
                status: detail.payment_record_status,
                currency: detail.currency,
                created_at: detail.payment_created_at,
            } : null,
            refund_summary: detail.payment_id && ["paid", "transferred"].includes(detail.payment_record_status)
                ? buildRefundSummary(
                    { amount: detail.payment_amount, platform_fee: detail.platform_fee },
                    detail.booking_price
                )
                : null,
            messages: messages.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error fetching dispute details" });
    }
};

export const AdminUpdateDispute = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, refund_percentage } = req.body;
        const resolution = sanitizeText(req.body.resolution);

        const allowed = ["open", "resolved", "rejected"];
        if (!allowed.includes(status)) {
            return res.status(400).json({ message: "Invalid dispute status" });
        }

        const normalizedResolution = resolution?.trim() || null;
        if (status !== "open" && !normalizedResolution) {
            return res.status(400).json({ message: "Resolution notes are required when closing a dispute" });
        }

        // Validate refund percentage when resolving
        const parsedPct = refund_percentage !== undefined && refund_percentage !== null
            ? Number(refund_percentage)
            : null;
        if (status === "resolved" && parsedPct !== null) {
            if (!Number.isFinite(parsedPct) || parsedPct < 50 || parsedPct > 100) {
                return res.status(400).json({ message: "Refund percentage must be between 50 and 100" });
            }
        }

        const dispute = await pool.query(
            `SELECT d.*, b.client_id, b.worker_id, b.payment_status,
                    CASE WHEN uc.account_type = 'company' THEN uc.company_name ELSE uc.full_name END AS client_name,
                    uc.email AS client_email,
                    CASE WHEN uw.account_type = 'company' THEN uw.company_name ELSE uw.full_name END AS worker_name,
                    uw.email AS worker_email,
                    s.title AS service_title
             FROM disputes d
             JOIN bookings b ON d.booking_id = b.id
             JOIN users uc ON b.client_id = uc.id
             JOIN users uw ON b.worker_id = uw.id
             JOIN services s ON b.service_id = s.id
             WHERE d.id = $1`,
            [id]
        );
        if (dispute.rows.length === 0) {
            return res.status(404).json({ message: "Dispute not found" });
        }

        const currentDispute = dispute.rows[0];

        let refundResult = null;
        if (status === "resolved" && parsedPct !== null) {
            refundResult = await processBookingRefund({
                bookingId: currentDispute.booking_id,
                refundPercentage: parsedPct,
                cancelBooking: false,
            });

            const totalRefundDollars = (refundResult.total_client_refund_cents / 100).toFixed(2);
            createLocalizedNotification({
                userId: currentDispute.client_id,
                type: "payment",
                link: "/wallet",
                en: { title: "Refund processed", body: `A refund of $${totalRefundDollars} has been processed after your dispute.` },
                fr: { title: "Remboursement effectué", body: `Un remboursement de ${totalRefundDollars} $ a été traité après votre litige.` },
            });
        }

        const result = await pool.query(
            `UPDATE disputes SET status = $1, resolution = $2, refund_percentage = $3 WHERE id = $4 RETURNING *`,
            [status, normalizedResolution, status === "resolved" ? parsedPct : null, id]
        );

        if (status !== "open") {
            const refundedAmount = refundResult ? (refundResult.total_client_refund_cents / 100).toFixed(2) : null;

            createLocalizedNotification({
                userId: currentDispute.client_id,
                type: "dispute",
                link: "/bookings",
                en: { title: status === "resolved" ? "Dispute resolved" : "Dispute rejected", body: normalizedResolution || "A decision has been added to your dispute." },
                fr: { title: status === "resolved" ? "Litige résolu" : "Litige rejeté", body: normalizedResolution || "Une décision a été ajoutée à votre litige." },
            });
            createLocalizedNotification({
                userId: currentDispute.worker_id,
                type: "dispute",
                link: "/bookings",
                en: { title: status === "resolved" ? "Dispute resolved" : "Dispute rejected", body: normalizedResolution || "A decision has been added to your dispute." },
                fr: { title: status === "resolved" ? "Litige résolu" : "Litige rejeté", body: normalizedResolution || "Une décision a été ajoutée à votre litige." },
            });

            const [clientLang, workerLang] = await Promise.all([
              getUserLang(currentDispute.client_id),
              getUserLang(currentDispute.worker_id),
            ]);

            if (await shouldSendEmail(currentDispute.client_id, "complaint")) {
                await notifyDisputeOutcome(
                    currentDispute.client_email,
                    currentDispute.client_name,
                    currentDispute.booking_id,
                    status,
                    normalizedResolution,
                    refundedAmount,
                    clientLang,
                );
            }

            if (await shouldSendEmail(currentDispute.worker_id, "complaint")) {
                await notifyDisputeOutcome(
                    currentDispute.worker_email,
                    currentDispute.worker_name,
                    currentDispute.booking_id,
                    status,
                    normalizedResolution,
                    refundedAmount,
                    workerLang,
                );
            }
        }

        // Audit log
        await logAdminAction({
            adminId:    req.user.id,
            adminEmail: req.user.email,
            action:     `dispute.${status}`,
            targetType: "dispute",
            targetId:   id,
            details: {
                booking_id:        currentDispute.booking_id,
                service_title:     currentDispute.service_title,
                resolution,
                refund_percentage: status === "resolved" ? parsedPct : undefined,
                refund_cents:      refundResult?.total_client_refund_cents ?? undefined,
            },
            ipAddress: req.ip,
        });

        res.status(200).json({ ...result.rows[0], refund: refundResult });
    } catch (err) {
        console.error(err);
        if (err.statusCode) {
            return res.status(err.statusCode).json(err.payload);
        }
        res.status(500).json({ message: "Server error updating dispute" });
    }
};