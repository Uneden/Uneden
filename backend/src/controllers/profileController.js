import pool from "../config/db.js";
import { resetStripeConnectAccount } from "../services/stripeConnectService.js";
import { sanitizeText } from "../utils/validate.js";
import { normalizeProvinceCode } from "../utils/taxProvince.js";
import { normalizePostalCode, pickValidBillingFields } from "../utils/billingAddress.js";
import { createClient } from '@supabase/supabase-js';
import { sendWelcomeEmailOnce } from "../services/userWelcomeService.js";
import { invalidateSuspendedCache } from "../middleware/authMiddleware.js";
import { logAdminAction } from "../services/auditService.js";


const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function syncDefaultBillingAddress(client, {
    userId,
    fullName,
    address,
    city,
    province,
    postalCode = "",
    createIfMissing = false,
}) {
    // Only values billing_addresses accepts: an unknown province or an over-long
    // city must not roll back the whole profile save.
    const billing = pickValidBillingFields({
        full_name: fullName,
        address_line1: address,
        city,
        province,
        postal_code: postalCode,
    });

    const updateResult = await client.query(
        `UPDATE billing_addresses
         SET
            full_name = COALESCE($1, full_name),
            address_line1 = COALESCE($2, address_line1),
            city = COALESCE($3, city),
            province = COALESCE($4, province),
            postal_code = COALESCE($5, postal_code)
         WHERE user_id = $6 AND is_default = true`,
        [
            billing.full_name ?? null,
            billing.address_line1 ?? null,
            billing.city ?? null,
            billing.province ?? null,
            billing.postal_code ?? null,
            userId,
        ]
    );

    if (!createIfMissing || updateResult.rowCount > 0) {
        return;
    }

    if (!billing.address_line1 || !billing.city || !billing.province || !billing.postal_code) {
        return;
    }

    await client.query(
        `INSERT INTO billing_addresses (user_id, label, full_name, address_line1, city, province, postal_code, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [userId, "Domicile", billing.full_name ?? null, billing.address_line1, billing.city, billing.province, billing.postal_code]
    );
}

export const initializeAccount = async (req, res) => {
    try {
        const { account_type, skip_profile_form: skipProfileForm } = req.body;
        if (!["person", "company"].includes(account_type)) {
            return res.status(400).json({ message: "Invalid account type" });
        }

        const userId = req.user.id;
        const existing = await pool.query(
            "SELECT account_type FROM users WHERE id = $1",
            [userId],
        );
        const previousType = existing.rows[0]?.account_type;
        const typeChanged = Boolean(previousType && previousType !== account_type);

        const meta = req.authUser?.user_metadata || {};
        const firstName = (meta.first_name || "").trim();
        const lastName = (meta.last_name || "").trim();
        const fullName =
            (meta.full_name || "").trim() ||
            [firstName, lastName].filter(Boolean).join(" ").trim() ||
            req.user.email;
        const profileCompleted = skipProfileForm === true;

        const userMetadata = {
            ...meta,
            account_type,
            first_name: firstName,
            last_name: lastName,
            full_name: fullName,
            onboarding_intro_completed: true,
            profile_completed: profileCompleted,
            ...(typeChanged
                ? {
                    phone: "",
                    address: "",
                    city: "",
                    province: "",
                    postal_code: "",
                    bio: "",
                    profession: "",
                    industry: "",
                    company_name: "",
                    team_size: "",
                }
                : {}),
        };

        const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(
            userId,
            { user_metadata: userMetadata }
        );

        if (metaError) {
            console.error("Error updating user metadata:", metaError);
            return res.status(500).json({
                message: "Failed to update user metadata",
                error: metaError.message,
            });
        }

        const result = typeChanged
            ? await pool.query(
                `UPDATE users
                 SET account_type = $1,
                     full_name = $2,
                     profile_completed = $3,
                     phone = NULL,
                     address = NULL,
                     city = NULL,
                     province = NULL,
                     postal_code = NULL,
                     bio = NULL,
                     profession = NULL,
                     industry = NULL,
                     company_name = NULL,
                     team_size = NULL,
                     skills = '[]',
                     languages = '[]',
                     experiences = '[]',
                     portfolio = '[]',
                     updated_at = NOW()
                 WHERE id = $4
                 RETURNING *`,
                [account_type, fullName, profileCompleted, userId],
            )
            : await pool.query(
                `UPDATE users
                 SET account_type = $1,
                     full_name = $2,
                     profile_completed = $3,
                     updated_at = NOW()
                 WHERE id = $4
                 RETURNING *`,
                [account_type, fullName, profileCompleted, userId],
            );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        if (typeChanged) {
            await resetStripeConnectAccount(userId).catch((err) => {
                console.warn("[Stripe] reset on account type change failed:", err?.message);
            });
        }

        sendWelcomeEmailOnce(userId).catch((err) => {
            console.error("Welcome email failed:", err.message);
        });

        res.json({
            message: "Account initialized",
            user: result.rows[0],
        });
    } catch (err) {
        console.error("Error initializing account:", err);
        res.status(500).json({
            message: "Server error while initializing account",
            error: err.message,
        });
    }
};

export const completeProfile = async (req, res) => {
    let client;
    try {
        const {
            account_type,
            full_name: bodyFullName,
            phone,
            address,
            city,
            province,
            postal_code,
            bio,
            avatar,

            // Person data
            profession,
            skills,
            languages,
            experiences,

            // Company data
            company_name,
            industry,
            team_size,

            portfolio
        } = req.body;

        const userId = req.user.id;
        const meta = req.authUser?.user_metadata || {};
        const fullName =
            (bodyFullName || "").trim() ||
            (meta.full_name || "").trim() ||
            [meta.first_name, meta.last_name].filter(Boolean).join(" ").trim() ||
            req.user.full_name;

        // Sanitize text inputs
        if (bio && bio.length > 2500) return res.status(400).json({ message: "Bio must be at most 2500 characters" });
        if (profession && profession.length > 200) return res.status(400).json({ message: "Profession must be at most 200 characters" });
        if (company_name && company_name.length > 200) return res.status(400).json({ message: "Company name must be at most 200 characters" });
        const sanitizedBio = sanitizeText(bio);
        const sanitizedProfession = sanitizeText(profession);
        const sanitizedCompanyName = sanitizeText(company_name);
        const normalizedPostalCode = normalizePostalCode(postal_code);


        //Préparer les métadonnées pour auth.users
        const metaData = account_type === 'person' 
            ? {
                account_type: 'person',
                full_name: fullName,
                profession: sanitizedProfession,
                bio: sanitizedBio,
                city: city,
                province: province,
                postal_code: normalizedPostalCode,
                phone: phone,
                address: address,
                avatar_url: avatar,
                profile_completed: true,
            }
            : {
                account_type: 'company',
                company_name: sanitizedCompanyName,
                full_name: fullName, // Nom du représentant
                industry: industry,
                bio: sanitizedBio,
                city: city,
                province: province,
                postal_code: normalizedPostalCode,
                phone: phone,
                address: address,
                team_size: team_size,
                avatar_url: avatar,
                profile_completed: true,
            };

        const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(
            userId,
            { user_metadata: metaData }
        );

        if (metaError) {
            console.error('Error updating user metadata:', metaError);
            return res.status(500).json({ 
                message: 'Failed to update user metadata',
                error: metaError.message 
            });
        }

        client = await pool.connect();
        await client.query("BEGIN");

        const result = await client.query(
            `UPDATE users
            SET
                account_type = $1,
                full_name = COALESCE(NULLIF($2, ''), full_name),
                phone = $3,
                address = $4,
                city = $5,
                province = $6,
                postal_code = $7,
                bio = $8,
                avatar = $9,
                profession = $10,
                skills = $11,
                languages = $12,
                experiences = $13,
                company_name = $14,
                industry = $15,
                team_size = $16,
                portfolio = $17,
                profile_completed = true,
                updated_at = NOW()
            WHERE id = $18
            RETURNING *`,
            [
                account_type,
                fullName,
                phone,
                address,
                city,
                province,
                normalizedPostalCode,
                sanitizedBio,
                avatar,
                sanitizedProfession,
                JSON.stringify(skills || []),
                JSON.stringify(languages || []),
                JSON.stringify(experiences || []),
                sanitizedCompanyName,
                industry,
                team_size,
                JSON.stringify(portfolio || []),
                userId
            ]
        );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "User not found" });
        }

        const defaultBillingName = account_type === 'company'
            ? (sanitizedCompanyName?.trim() || null)
            : (fullName?.trim() || null);

        await syncDefaultBillingAddress(client, {
            userId,
            fullName: defaultBillingName,
            address,
            city,
            province,
            postalCode: normalizedPostalCode || "",
            createIfMissing: true,
        });

        await client.query("COMMIT");

        const u = result.rows[0];

        res.json({
            message: "Profile completed successfully",
            user: u
        });
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Rollback failed:", rollbackError);
            }
        }
        console.error("Error completing profile:", err);
        res.status(500).json({ 
            message: "Server error while completing profile",
            error: err.message 
        });
    } finally {
        client?.release();
    }
};

export const GetMyProfile = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM users WHERE id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Profile not found" });
        }

        const user = result.rows[0];
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error while fetching profile" });
    }
};

/** Persist step-1 fields during onboarding without marking profile_completed. */
export const saveOnboardingBasicInfo = async (req, res) => {
    try {
        const {
            account_type,
            full_name,
            phone,
            address,
            city,
            province,
            postal_code,
            company_name,
        } = req.body;

        const normalizedPostalCode = normalizePostalCode(postal_code);
        const normalizedProvince = normalizeProvinceCode(province);

        await pool.query(
            `UPDATE users SET
                account_type = COALESCE(NULLIF($1, ''), account_type),
                full_name = COALESCE(NULLIF($2, ''), full_name),
                phone = COALESCE(NULLIF($3, ''), phone),
                address = COALESCE(NULLIF($4, ''), address),
                city = COALESCE(NULLIF($5, ''), city),
                province = COALESCE(NULLIF($6, ''), province),
                postal_code = COALESCE($7, postal_code),
                company_name = COALESCE(NULLIF($8, ''), company_name),
                updated_at = NOW()
            WHERE id = $9`,
            [
                account_type || null,
                full_name || null,
                phone || null,
                address || null,
                city || null,
                normalizedProvince || province || null,
                normalizedPostalCode,
                company_name || null,
                req.user.id,
            ],
        );

        res.json({ ok: true });
    } catch (err) {
        console.error("saveOnboardingBasicInfo error:", err);
        res.status(500).json({ message: "Failed to save basic profile info" });
    }
};

export const UpdateMyProfile = async (req, res) => {
    let client;
    try {
        const {
            full_name,
            email,
            phone,
            avatar,
            bio,
            address,
            city,
            province,
            postal_code,
            skills,
            languages,
            portfolio,
            profession,
            company_name,
            industry,
            team_size,
            account_type
        } = req.body;

        // Validation des champs requis
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        // Vérifier que le nom approprié est fourni selon le type
        if (account_type === "company") {
            if (!company_name || company_name.trim() === "") {
                return res.status(400).json({ message: "Company name is required" });
            }
        } else {
            if (!full_name || full_name.trim() === "") {
                return res.status(400).json({ message: "Full name is required" });
            }
        }

        // Convertir les tableaux en JSON seulement s'ils sont des tableaux
        const skillsJson = Array.isArray(skills) ? JSON.stringify(skills) : skills;
        const languagesJson = Array.isArray(languages) ? JSON.stringify(languages) : languages;
        const portfolioJson = Array.isArray(portfolio) ? JSON.stringify(portfolio) : portfolio;
        const normalizedPostalCode = normalizePostalCode(postal_code);

        client = await pool.connect();
        await client.query("BEGIN");

        // Mise à jour avec tous les champs
        const result = await client.query(
            `UPDATE users
            SET
                full_name = $1,
                email = $2,
                phone = $3,
                avatar = $4,
                bio = $5,
                address = $6,
                city = $7,
                province = $8,
                postal_code = $9,
                skills = $10,
                languages = $11,
                portfolio = $12,
                profession = $13,
                company_name = $14,
                industry = $15,
                team_size = $16,
                updated_at = NOW()
            WHERE id = $17
            RETURNING *`,
            [
                full_name || null,
                email,
                phone || null,
                avatar || null,
                bio || null,
                address || null,
                city || null,
                province || null,
                normalizedPostalCode,
                skillsJson || '[]',
                languagesJson || '[]',
                portfolioJson || '[]',
                profession || null,
                company_name || null,
                industry || null,
                team_size || null,
                req.user.id
            ]
        );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Profile not found" });
        }

        const defaultBillingName = account_type === "company"
            ? (company_name?.trim() || null)
            : (full_name?.trim() || null);

        await syncDefaultBillingAddress(client, {
            userId: req.user.id,
            fullName: defaultBillingName,
            address,
            city,
            province,
            postalCode: normalizedPostalCode || "",
            createIfMissing: true,
        });

        await client.query("COMMIT");

        res.json({
            message: "Profile updated successfully",
            user: result.rows[0]
        });

    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Rollback failed:", rollbackError);
            }
        }
        console.error("Error updating profile:", err);
        res.status(500).json({ 
            message: "Server error while updating profile",
            error: err.message 
        });
    } finally {
        client?.release();
    }
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getUserProfile = async (req, res) => {
    try {
        const { id } = req.params;

        if (!UUID_REGEX.test(id)) {
            return res.status(404).json({ message: "User not found" });
        }

        const userResult = await pool.query(
            `SELECT 
            id, full_name, email, account_type, bio, avatar, 
            profession, skills, languages, portfolio,
            company_name, industry, team_size,
            created_at 
            FROM users 
            WHERE id = $1`,
            [id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "Profile not found" });
        }
        
        const user = userResult.rows[0];

        // Viewer was blocked by this profile owner — treat as not found (no profile or listings visibility)
        const viewerId = req.user?.id;
        if (viewerId && viewerId !== id) {
            const { data: blockedRow } = await supabaseAdmin
                .from("blocked_users")
                .select("id")
                .eq("blocker_id", id)
                .eq("blocked_user_id", viewerId)
                .maybeSingle();
            if (blockedRow) {
                return res.status(404).json({ message: "Profile not found" });
            }
        }

        const serviceUser = await pool.query(
            `SELECT COUNT(*) AS total_services FROM services WHERE user_id = $1`,
            [id]
        );

        const completedBookings = await pool.query(
            `SELECT COUNT(*) as count FROM bookings WHERE worker_id = $1 AND status = 'completed'`,
            [id]
        );

        const avgRating = await pool.query(
            `SELECT AVG(rating) as avg_rating, COUNT(*) as review_count FROM reviews WHERE target_id = $1`,
            [id]
        );

        res.json({
            ...user,
            stats: {
                total_services: parseInt(serviceUser.rows[0].total_services, 10),
                completed_bookings: parseInt(completedBookings.rows[0].count, 10),
                average_rating: avgRating.rows[0].avg_rating ? parseFloat(parseFloat(avgRating.rows[0].avg_rating).toFixed(1)) : null,
                total_reviews: parseInt(avgRating.rows[0].review_count, 10)
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error while fetching profile" });
    }
};

export const getSettings = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT settings FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0].settings || {});
  } catch (err) {
    console.error("Error fetching settings:", err);
    res.status(500).json({ message: "Server error while fetching settings" });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const { notifications, language, region } = req.body;

    const current = await pool.query(
      `SELECT settings FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // Merger les settings existants avec les nouveaux
    const existingSettings = current.rows[0].settings || {};

    const updatedSettings = {
    ...existingSettings,
    ...(notifications && { notifications: { ...existingSettings.notifications, ...notifications } }),
    ...(language && { language }),
    ...(region && { region }),
    };

    const result = await pool.query(
      `UPDATE users SET settings = $1, updated_at = NOW() WHERE id = $2 RETURNING settings`,
      [JSON.stringify(updatedSettings), req.user.id]
    );

    res.json(result.rows[0].settings);
  } catch (err) {
    console.error("Error updating settings:", err);
    res.status(500).json({ message: "Server error while updating settings" });
  }
};
export const searchProfiles = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    const pattern = `%${q}%`;
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, company_name, account_type, avatar_url')
      .or(`full_name.ilike.${pattern},company_name.ilike.${pattern}`)
      .neq('id', req.user.id)
      .limit(20);

    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) return res.json([]);

    const ids = rows.map((p) => p.id).filter(Boolean);
    if (ids.length === 0) return res.json([]);
    const [{ data: iBlocked }, { data: blockedMe }] = await Promise.all([
      supabaseAdmin.from("blocked_users").select("blocked_user_id").eq("blocker_id", req.user.id).in("blocked_user_id", ids),
      supabaseAdmin.from("blocked_users").select("blocker_id").eq("blocked_user_id", req.user.id).in("blocker_id", ids),
    ]);
    const exclude = new Set([
      ...(iBlocked || []).map((r) => r.blocked_user_id),
      ...(blockedMe || []).map((r) => r.blocker_id),
    ]);
    const filtered = rows.filter((p) => !exclude.has(p.id));
    res.json(filtered);
  } catch (err) {
    console.error('Error searching profiles:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const { q } = req.query;
    let query = `
      SELECT id, full_name, company_name, account_type, email, province, is_suspended, created_at,
             (SELECT COUNT(*) FROM bookings b WHERE b.client_id = u.id OR b.worker_id = u.id) AS booking_count
      FROM users u
    `;
    const params = [];
    if (q) {
      query += ` WHERE full_name ILIKE $1 OR company_name ILIKE $1 OR email ILIKE $1`;
      params.push(`%${q}%`);
    }
    query += ` ORDER BY created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("getAllUsers error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const suspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { suspend } = req.body; // true = suspend, false = reactivate

    // Fetch target user info for the audit log before updating
    const targetResult = await pool.query(
      "SELECT email, full_name, company_name FROM users WHERE id = $1",
      [id]
    );
    const targetUser = targetResult.rows[0];

    await pool.query(
      "UPDATE users SET is_suspended = $1 WHERE id = $2",
      [!!suspend, id]
    );

    invalidateSuspendedCache(id);

    await logAdminAction({
      adminId:    req.user.id,
      adminEmail: req.user.email,
      action:     suspend ? "user.suspend" : "user.reactivate",
      targetType: "user",
      targetId:   id,
      details: {
        target_email:    targetUser?.email,
        target_name:     targetUser?.company_name || targetUser?.full_name,
      },
      ipAddress: req.ip,
    });

    res.json({ success: true, suspended: !!suspend });
  } catch (err) {
    console.error("suspendUser error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
