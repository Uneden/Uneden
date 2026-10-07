import pool from "../config/db.js";
import { notifyNewReview } from "../services/emailService.js";
import { getUserLang } from "../services/notificationService.js";
import { isValidUUID, sanitizeText } from "../utils/validate.js";

export const createReview = async (req, res) => {
  try {
    const { booking_id } = req.body;
    const rating = Number(req.body.rating);
    const comment = sanitizeText(req.body.comment);

    if (!isValidUUID(booking_id)) {
      return res.status(404).json({ message: "Booking not found" });
    }
    // reviews.rating is an integer column: 4.5 used to pass this check and
    // fail the INSERT with a 500; a missing rating was stored as NULL.
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "The rating must be a whole number between 1 and 5" });
    }
    if (comment && comment.length > 2000) {
      return res.status(400).json({ message: "The comment must be at most 2000 characters" });
    }

    const booking = await pool.query("SELECT * FROM bookings WHERE id = $1", [booking_id]);
    if (booking.rows.length === 0) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const b = booking.rows[0];
    if (b.client_id !== req.user.id && b.worker_id !== req.user.id) {
      return res.status(403).json({ message: "You are not part of this booking" });
    }
    // Only work that actually happened can be reviewed (as in the UI).
    if (b.status !== "completed") {
      return res.status(400).json({ message: "Only completed bookings can be reviewed" });
    }

    const target_id = b.client_id === req.user.id ? b.worker_id : b.client_id;

    // reviews_one_per_booking_reviewer (unique index) settles a double submit.
    const result = await pool.query(
      `INSERT INTO reviews (booking_id, reviewer_id, target_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (booking_id, reviewer_id) DO NOTHING
       RETURNING *`,
      [booking_id, req.user.id, target_id, rating, comment || null]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ message: "You already reviewed this booking" });
    }

    res.status(201).json(result.rows[0]);

    // The review is saved: a failing email must not turn it into a 500.
    notifyReviewTarget(target_id, req.user.id, rating, comment).catch((err) =>
      console.error("Review email notification failed:", err.message),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while creating review" });
  }
};

async function notifyReviewTarget(targetId, reviewerId, rating, comment) {
  const users = await pool.query(
    `SELECT
      u1.email as target_email,
      CASE WHEN u1.account_type = 'company' THEN u1.company_name ELSE u1.full_name END as target_name,
      CASE WHEN u2.account_type = 'company' THEN u2.company_name ELSE u2.full_name END as reviewer_name
     FROM users u1, users u2
     WHERE u1.id = $1 AND u2.id = $2`,
    [targetId, reviewerId]
  );
  if (users.rows.length === 0) return;
  const { target_email, target_name, reviewer_name } = users.rows[0];
  const lang = await getUserLang(targetId);
  await notifyNewReview(target_email, target_name, reviewer_name, rating, comment, lang);
}

export const getUserReviews = async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT r.*,
              CASE WHEN u.account_type = 'company' THEN u.company_name ELSE u.full_name END AS reviewer_name
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.target_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error while fetching reviews" });
  }
};