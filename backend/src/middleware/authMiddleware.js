import jwt from "jsonwebtoken";
import { verifySupabaseJwt } from "../lib/supabaseJwt.js";
import pool from "../config/db.js";

// Simple in-memory cache for suspended status (TTL: 2 minutes)
// Avoids hitting the DB on every single request for the same user
const suspendedCache = new Map(); // userId → { suspended: bool, expiresAt: timestamp }
const CACHE_TTL_MS = 2 * 60 * 1000;

function getCachedSuspended(userId) {
  const entry = suspendedCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    suspendedCache.delete(userId);
    return null;
  }
  return entry.suspended;
}

function setCachedSuspended(userId, suspended) {
  suspendedCache.set(userId, { suspended, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Call this when a user is suspended/reactivated to clear their cache entry */
export function invalidateSuspendedCache(userId) {
  suspendedCache.delete(userId);
}

export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Not authorized, no token" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Not authorized, no token" });
    }

    // HS256: verified locally with the shared secret. ES256: public key from JWKS (cached).
    let payload;
    try {
      payload = await verifySupabaseJwt(token);
    } catch {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = payload.sub;
    const email  = payload.email;
    if (!userId) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    // Check suspended status via direct DB (pool) — not Supabase REST API
    let suspended = getCachedSuspended(userId);
    if (suspended === null) {
      const result = await pool.query(
        "SELECT is_suspended FROM users WHERE id = $1",
        [userId]
      );
      if (result.rows.length === 0) {
        return res.status(403).json({ message: "Account not found." });
      }
      suspended = result.rows[0].is_suspended;
      setCachedSuspended(userId, suspended);
    }

    if (suspended) {
      return res.status(403).json({ message: "Your account has been suspended. Please contact support@uneden.ca." });
    }

    req.user = {
      id: userId,
      email,
      full_name:
        payload.user_metadata?.full_name ||
        [payload.user_metadata?.first_name, payload.user_metadata?.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        email,
    };
    // Keep authUser for adminOnly — reconstruct minimal shape from JWT payload
    req.authUser = {
      id: userId,
      email,
      user_metadata: payload.user_metadata || {},
      app_metadata:  payload.app_metadata  || {},
    };
    // Expose top-level JWT claims (e.g. aal for MFA check in adminOnly)
    req._jwtPayload = payload;

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(401).json({ message: "Authentication failed" });
  }
};

/** Sets req.user when a valid Bearer token is present; otherwise leaves req.user undefined and continues (no 401). */
export const optionalProtect = async (req, res, next) => {
  delete req.user;
  delete req.authUser;
  delete req._jwtPayload;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next();
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      return next();
    }
    let payload;
    try {
      payload = await verifySupabaseJwt(token);
    } catch {
      return next();
    }
    const userId = payload.sub;
    const email = payload.email;
    if (!userId) {
      return next();
    }
    let suspended = getCachedSuspended(userId);
    if (suspended === null) {
      const result = await pool.query(
        "SELECT is_suspended FROM users WHERE id = $1",
        [userId]
      );
      if (result.rows.length === 0) {
        return next();
      }
      suspended = result.rows[0].is_suspended;
      setCachedSuspended(userId, suspended);
    }
    if (suspended) {
      return next();
    }
    req.user = {
      id: userId,
      email,
      full_name:
        payload.user_metadata?.full_name ||
        [payload.user_metadata?.first_name, payload.user_metadata?.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        email,
    };
    req.authUser = {
      id: userId,
      email,
      user_metadata: payload.user_metadata || {},
      app_metadata: payload.app_metadata || {},
    };
    req._jwtPayload = payload;
    next();
  } catch (err) {
    console.error("optionalProtect error:", err);
    next();
  }
};

/**
 * True if the user is allowed to use admin/support tooling (identity only — no second factor).
 */
export function hasAdminIdentity(req) {
  const user = req.authUser;
  const email = req.user?.email?.toLowerCase();

  const emailList = [
    ...(process.env.ADMIN_EMAILS || "").split(","),
    ...(process.env.SUPPORT_EMAILS || "").split(","),
  ]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const am = user?.app_metadata || {};
  const metaRole = String(am.role || "").toLowerCase();
  const roles = Array.isArray(am.roles) ? am.roles : [];
  const hasAdminRole =
    metaRole === "admin" || roles.map((r) => String(r).toLowerCase()).includes("admin");
  const allowedByEmail = email && emailList.includes(email);

  return Boolean(hasAdminRole || allowedByEmail);
}

/**
 * Second factor for admin API: Supabase AAL2 (legacy TOTP) OR email OTP step-up JWT.
 */
export function verifyAdminStepUp(req) {
  const aal = req.authUser?.app_metadata?.aal ?? req._jwtPayload?.aal ?? null;
  if (aal === "aal2") return { ok: true, via: "aal2" };

  const raw = req.headers["x-uneden-admin-stepup"];
  if (!raw || typeof raw !== "string") return { ok: false };

  try {
    const secret = process.env.ADMIN_STEPUP_SECRET || process.env.SUPABASE_JWT_SECRET;
    const payload = jwt.verify(raw, secret);
    if (payload.purpose !== "admin_stepup") return { ok: false };
    if (payload.sub !== req.user.id) return { ok: false };
    const pe = String(payload.email || "").toLowerCase();
    const ue = String(req.user.email || "").toLowerCase();
    if (pe && ue && pe !== ue) return { ok: false };
    return { ok: true, via: "email_otp" };
  } catch {
    return { ok: false };
  }
}

/** Admin/support identity only (for routes that must run before step-up, e.g. sending the email code). */
export const adminIdentityOnly = (req, res, next) => {
  try {
    if (!hasAdminIdentity(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }
    return next();
  } catch (err) {
    console.error("adminIdentityOnly error:", err);
    return res.status(403).json({ message: "Admin access required" });
  }
};

export const adminOnly = (req, res, next) => {
  try {
    if (!hasAdminIdentity(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }

    const step = verifyAdminStepUp(req);
    if (!step.ok) {
      return res.status(403).json({
        message: "Vérification par e-mail requise pour l'admin.",
        admin_stepup_required: true,
      });
    }

    return next();
  } catch (err) {
    console.error("Admin check error:", err);
    return res.status(403).json({ message: "Admin access required" });
  }
};
