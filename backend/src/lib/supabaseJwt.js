import jwt from "jsonwebtoken";
import { createPublicKey } from "node:crypto";

/**
 * Verifies a Supabase access token.
 *
 * - HS256: legacy shared secret (SUPABASE_JWT_SECRET) — what production uses today.
 * - ES256 / RS256: asymmetric signing keys, resolved from the project's JWKS
 *   endpoint. Local Supabase (`supabase start`) signs this way by default, and
 *   production will too once its JWT signing keys are rotated.
 *
 * Returns the verified payload; throws on any failure.
 */

const JWKS_TTL_MS = 10 * 60 * 1000;
const ASYMMETRIC_ALGS = ["ES256", "RS256"];

let jwksCache = { keys: null, fetchedAt: 0 };

async function getJwks(force = false) {
  const fresh = jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache.keys;

  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { keys: keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

export async function verifySupabaseJwt(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header) throw new Error("Malformed token");
  const { alg, kid } = decoded.header;

  if (alg === "HS256") {
    return jwt.verify(token, process.env.SUPABASE_JWT_SECRET, { algorithms: ["HS256"] });
  }

  if (!ASYMMETRIC_ALGS.includes(alg)) throw new Error(`Unsupported alg ${alg}`);

  // Unknown kid → refetch once, in case the keys were just rotated.
  let jwk = (await getJwks()).find((k) => k.kid === kid);
  if (!jwk) jwk = (await getJwks(true)).find((k) => k.kid === kid);
  if (!jwk) throw new Error("Unknown signing key");

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  return jwt.verify(token, publicKey, { algorithms: [alg] });
}
