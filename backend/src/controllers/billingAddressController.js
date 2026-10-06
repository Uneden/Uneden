import pool from "../config/db.js";
import { validateBillingAddressInput } from "../utils/billingAddress.js";
import { isValidUUID } from "../utils/validate.js";

const MAX_ADDRESSES = 2;

function getDefaultBillingName(user) {
  return user.account_type === "company"
    ? (user.company_name?.trim() || null)
    : (user.full_name?.trim() || null);
}

async function getOrBootstrapBillingAddresses(userId) {
  const existing = await pool.query(
    `SELECT id, label, full_name, address_line1, city, province, postal_code, is_default, created_at
     FROM billing_addresses
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at ASC`,
    [userId]
  );

  if (existing.rows.length > 0) {
    return existing.rows;
  }

  const profileResult = await pool.query(
    `SELECT account_type, full_name, company_name, address, city, province, postal_code
     FROM users
     WHERE id = $1`,
    [userId]
  );

  const profile = profileResult.rows[0];
  if (!profile) {
    return [];
  }

  const { error, data } = validateBillingAddressInput(
    {
      full_name: getDefaultBillingName(profile),
      address_line1: profile.address,
      city: profile.city,
      province: profile.province,
    },
    { partial: true },
  );
  // Incomplete or unusable profile address (unknown province, too long for the
  // columns): the buyer enters a billing address at checkout instead.
  if (error || !data.address_line1 || !data.city || !data.province) {
    return [];
  }
  const postal = validateBillingAddressInput({ postal_code: profile.postal_code }, { partial: true });

  const inserted = await pool.query(
    `INSERT INTO billing_addresses (user_id, label, full_name, address_line1, city, province, postal_code, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)
     RETURNING id, label, full_name, address_line1, city, province, postal_code, is_default, created_at`,
    [
      userId,
      "Domicile",
      data.full_name ?? null,
      data.address_line1,
      data.city,
      data.province,
      postal.data.postal_code ?? "",
    ]
  );

  return inserted.rows;
}

export const getBillingAddresses = async (req, res) => {
  try {
    const userId = req.user.id;
    const addresses = await getOrBootstrapBillingAddresses(userId);
    res.json(addresses);
  } catch (err) {
    console.error("getBillingAddresses error:", err);
    res.status(500).json({ message: "Failed to fetch billing addresses" });
  }
};

export const createBillingAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { is_default } = req.body;
    const { error, data } = validateBillingAddressInput(req.body);
    if (error) {
      return res.status(400).json({ message: error });
    }

    // Enforce max 2 addresses
    const count = await pool.query(
      "SELECT COUNT(*) FROM billing_addresses WHERE user_id = $1",
      [userId]
    );
    if (parseInt(count.rows[0].count) >= MAX_ADDRESSES) {
      return res.status(400).json({ message: "Maximum 2 billing addresses allowed" });
    }

    // If is_default, clear existing defaults
    if (is_default) {
      await pool.query(
        "UPDATE billing_addresses SET is_default = false WHERE user_id = $1",
        [userId]
      );
    }

    // If this is the first address, make it default automatically
    const shouldBeDefault = is_default || parseInt(count.rows[0].count) === 0;

    const result = await pool.query(
      `INSERT INTO billing_addresses (user_id, label, full_name, address_line1, city, province, postal_code, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, label, full_name, address_line1, city, province, postal_code, is_default, created_at`,
      [userId, data.label ?? "Domicile", data.full_name ?? null, data.address_line1, data.city, data.province, data.postal_code, shouldBeDefault]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("createBillingAddress error:", err);
    res.status(500).json({ message: "Failed to create billing address" });
  }
};

export const updateBillingAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { is_default } = req.body;
    if (!isValidUUID(id)) {
      return res.status(404).json({ message: "Address not found" });
    }
    const { error, data } = validateBillingAddressInput(req.body, { partial: true });
    if (error) {
      return res.status(400).json({ message: error });
    }

    // Verify ownership
    const existing = await pool.query(
      "SELECT id FROM billing_addresses WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ message: "Address not found" });
    }

    if (is_default) {
      await pool.query(
        "UPDATE billing_addresses SET is_default = false WHERE user_id = $1",
        [userId]
      );
    }

    const result = await pool.query(
      `UPDATE billing_addresses
       SET label = COALESCE($1, label),
           full_name = COALESCE($2, full_name),
           address_line1 = COALESCE($3, address_line1),
           city = COALESCE($4, city),
           province = COALESCE($5, province),
           postal_code = COALESCE($6, postal_code),
           is_default = COALESCE($7, is_default)
       WHERE id = $8 AND user_id = $9
       RETURNING id, label, full_name, address_line1, city, province, postal_code, is_default, created_at`,
      [data.label, data.full_name, data.address_line1, data.city, data.province, data.postal_code, is_default, id, userId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("updateBillingAddress error:", err);
    res.status(500).json({ message: "Failed to update billing address" });
  }
};

export const deleteBillingAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(404).json({ message: "Address not found" });
    }

    const result = await pool.query(
      "DELETE FROM billing_addresses WHERE id = $1 AND user_id = $2 RETURNING id, is_default",
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Address not found" });
    }

    // If deleted address was default, assign default to the remaining address
    // (Postgres has no ORDER BY/LIMIT on UPDATE: pick the row in a subquery).
    if (result.rows[0].is_default) {
      await pool.query(
        `UPDATE billing_addresses SET is_default = true
         WHERE id = (
           SELECT id FROM billing_addresses
           WHERE user_id = $1
           ORDER BY created_at ASC
           LIMIT 1
         )`,
        [userId]
      );
    }

    res.json({ message: "Address deleted" });
  } catch (err) {
    console.error("deleteBillingAddress error:", err);
    res.status(500).json({ message: "Failed to delete billing address" });
  }
};

export const setDefaultBillingAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(404).json({ message: "Address not found" });
    }

    // Single statement: an unknown id must not leave the user without a default.
    const result = await pool.query(
      `UPDATE billing_addresses SET is_default = (id = $1)
       WHERE user_id = $2
         AND EXISTS (SELECT 1 FROM billing_addresses WHERE id = $1 AND user_id = $2)
       RETURNING id, label, full_name, address_line1, city, province, postal_code, is_default`,
      [id, userId]
    );

    const selected = result.rows.find((row) => row.id === id);
    if (!selected) {
      return res.status(404).json({ message: "Address not found" });
    }

    res.json(selected);
  } catch (err) {
    console.error("setDefaultBillingAddress error:", err);
    res.status(500).json({ message: "Failed to set default" });
  }
};
