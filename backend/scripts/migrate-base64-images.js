/**
 * One-off: moves images stored as base64 data: URLs in the database (listing
 * photos, avatars, portfolios) to the listing-images Storage bucket and
 * replaces them with their public URL. Those rows were re-sent with every
 * listing page, notification poll and booking poll, which made up most of the
 * Supabase egress.
 *
 *   node scripts/migrate-base64-images.js           # dry run: report only
 *   node scripts/migrate-base64-images.js --apply   # upload + update rows
 *
 * Idempotent: files are named after a hash of their content and rows without
 * data: URLs are left alone, so it can be re-run. --apply first saves the
 * original values to a JSON file in the OS temp dir (contains user images:
 * keep it out of the repo, delete it once the migration is verified).
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const BUCKET = "listing-images";
// Same types the bucket accepts.
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const isDataUrl = (value) => typeof value === "string" && value.startsWith("data:");
const urlByDataUrl = new Map();
const stats = { files: 0, bytes: 0, base64Chars: 0, rows: 0, skipped: [] };

/** Public URL for a data: URL (uploading it with --apply); other values unchanged. */
async function toStorageUrl(value, userId, kind) {
  if (!isDataUrl(value)) return value;
  if (urlByDataUrl.has(value)) return urlByDataUrl.get(value);

  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  const ext = match && EXTENSIONS[match[1]];
  if (!ext) {
    stats.skipped.push(`${kind} of ${userId}: unsupported ${value.slice(0, 30)}…`);
    return value;
  }

  const bytes = Buffer.from(match[2], "base64");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const filePath = `${userId}/migrated-${kind}-${hash}.${ext}`;
  if (APPLY) {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, bytes, { contentType: match[1], upsert: true });
    if (error) throw new Error(`Upload ${filePath} failed: ${error.message}`);
  }

  const url = supabase.storage.from(BUCKET).getPublicUrl(filePath).data.publicUrl;
  urlByDataUrl.set(value, url);
  stats.files += 1;
  stats.bytes += bytes.length;
  stats.base64Chars += value.length;
  return url;
}

async function migratePortfolio(portfolio, userId) {
  if (!Array.isArray(portfolio)) return portfolio;
  return Promise.all(
    portfolio.map(async (item) =>
      item && isDataUrl(item.image)
        ? { ...item, image: await toStorageUrl(item.image, userId, "portfolio") }
        : item,
    ),
  );
}

async function main() {
  await db.connect();

  const services = (
    await db.query(
      `SELECT id, user_id, image_url, image_urls FROM services
       WHERE image_url LIKE 'data:%' OR array_to_string(image_urls, '|') LIKE '%data:%'`,
    )
  ).rows;
  const users = (
    await db.query(
      `SELECT id, avatar, portfolio FROM users
       WHERE avatar LIKE 'data:%' OR portfolio::text LIKE '%data:image%'`,
    )
  ).rows;
  const profiles = (
    await db.query(
      `SELECT id, avatar, avatar_url FROM profiles
       WHERE avatar LIKE 'data:%' OR avatar_url LIKE 'data:%'`,
    )
  ).rows;

  if (APPLY) {
    const backup = path.join(os.tmpdir(), `uneden-base64-backup-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify({ services, users, profiles }));
    console.log(`Original values saved to ${backup}`);
  }

  const updates = [];
  for (const s of services) {
    const imageUrl = await toStorageUrl(s.image_url, s.user_id, "listing");
    const imageUrls = await Promise.all((s.image_urls ?? []).map((u) => toStorageUrl(u, s.user_id, "listing")));
    updates.push(["UPDATE services SET image_url = $1, image_urls = $2 WHERE id = $3", [imageUrl, imageUrls, s.id]]);
  }
  for (const u of users) {
    const avatar = await toStorageUrl(u.avatar, u.id, "avatar");
    const portfolio = await migratePortfolio(u.portfolio, u.id);
    updates.push([
      "UPDATE users SET avatar = $1, portfolio = $2::jsonb WHERE id = $3",
      [avatar, portfolio == null ? null : JSON.stringify(portfolio), u.id],
    ]);
  }
  for (const p of profiles) {
    const avatar = await toStorageUrl(p.avatar, p.id, "avatar");
    const avatarUrl = await toStorageUrl(p.avatar_url, p.id, "avatar");
    updates.push(["UPDATE profiles SET avatar = $1, avatar_url = $2 WHERE id = $3", [avatar, avatarUrl, p.id]]);
  }
  stats.rows = updates.length;

  if (APPLY) {
    // All rows or none: a failure leaves the database as it was (uploaded
    // files are harmless and reused by the next run).
    await db.query("BEGIN");
    try {
      for (const [sql, params] of updates) await db.query(sql, params);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }

  console.log(
    `${APPLY ? "Migrated" : "Dry run — would migrate"}: ${services.length} listings, ${users.length} users, ` +
      `${profiles.length} profiles (${stats.rows} rows); ${stats.files} distinct images, ` +
      `${(stats.base64Chars / 1e6).toFixed(2)} MB of base64 removed from the database.`,
  );
  for (const line of stats.skipped) console.log(`Skipped ${line}`);
  if (!APPLY) console.log("Re-run with --apply to upload and update.");
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end().catch(() => {});
  process.exit(1);
});
