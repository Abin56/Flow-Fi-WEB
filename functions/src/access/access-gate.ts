/**
 * FlowFi private-access gate — Layer 1, in front of Google/Firebase Auth.
 *
 * The access password is NEVER stored anywhere in plain text. The only
 * persisted representation is a salted scrypt hash, held in Secret Manager
 * as the Cloud Functions v2 secret `FLOWFI_ACCESS_PASSWORD_HASH` (format:
 * `scrypt$N$r$p$<salt b64>$<hash b64>`, produced by
 * `functions/scripts/hash-access-password.mjs`). Firestore never sees it.
 *
 * A correct password yields a short-lived, HMAC-signed access token. The
 * HMAC key is derived from that same secret, so rotating the password
 * immediately invalidates every outstanding token. The browser can hold the
 * token but can't forge or extend it — only these functions can validate it.
 *
 * Plain, directly testable module — no `firebase-functions` imports, same
 * convention as src/ingestion/*. Never logs the submitted password.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** How long a successful verification stays valid. */
export const ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** Per-client-IP brute-force limit: this many attempts per window, then locked out until the window ends. */
export const ACCESS_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 };
export const ACCESS_RATE_LIMIT_NAMESPACE = "accessGate";

/** Anything longer is rejected before hashing so a huge payload can't be used to burn scrypt CPU. */
export const MAX_PASSWORD_LENGTH = 256;

const TOKEN_VERSION = "v1";
const HASH_PREFIX = "scrypt";
const DEFAULT_SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** Produces the secret value to store. Used by the hashing script and tests — never at request time. */
export function hashAccessPassword(password: string, params = DEFAULT_SCRYPT): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { ...params, maxmem: 128 * params.N * params.r * 2 });
  return [HASH_PREFIX, params.N, params.r, params.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

function parseHash(stored: string): ParsedHash {
  const parts = stored.trim().split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) {
    throw new Error("FLOWFI_ACCESS_PASSWORD_HASH is not a valid scrypt hash string.");
  }
  const [, n, r, p, salt, hash] = parts;
  const parsed = { N: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(salt!, "base64"), hash: Buffer.from(hash!, "base64") };
  if (![parsed.N, parsed.r, parsed.p].every((v) => Number.isInteger(v) && v > 0) || parsed.salt.length < 16 || parsed.hash.length < 16) {
    throw new Error("FLOWFI_ACCESS_PASSWORD_HASH has invalid parameters.");
  }
  return parsed;
}

/** Constant-time comparison of a candidate against the stored hash. Throws only if the stored hash itself is malformed (a server misconfiguration, not a wrong password). */
export function verifyPasswordAgainstHash(candidate: string, storedHash: string): boolean {
  const { N, r, p, salt, hash } = parseHash(storedHash);
  const derived = scryptSync(candidate, salt, hash.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return timingSafeEqual(derived, hash);
}

function signingKey(storedHash: string): Buffer {
  return createHash("sha256").update("flowfi-access-token-key:v1\0").update(storedHash.trim()).digest();
}

function sign(payload: string, storedHash: string): string {
  return createHmac("sha256", signingKey(storedHash)).update(payload).digest("base64url");
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: number;
}

export function issueAccessToken(storedHash: string, now = Date.now()): IssuedAccessToken {
  const expiresAt = now + ACCESS_TOKEN_TTL_MS;
  const payload = `${TOKEN_VERSION}.${expiresAt}.${randomBytes(12).toString("base64url")}`;
  return { token: `${payload}.${sign(payload, storedHash)}`, expiresAt };
}

/** Returns the token's expiry if it's genuine and unexpired, otherwise null. */
export function validateAccessToken(token: unknown, storedHash: string, now = Date.now()): number | null {
  if (typeof token !== "string" || token.length > 256) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(payload, storedHash));
  const actual = Buffer.from(parts[3]!);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ACCESS_TOKEN_TTL_MS) return null;
  return expiresAt;
}

/** Rate-limit key for a client IP — hashed so raw IPs aren't persisted. */
export function rateLimitKeyForIp(ip: string | undefined): string {
  return createHash("sha256").update(`flowfi-access-ip:${ip || "unknown"}`).digest("hex");
}

export type VerifyAccessOutcome =
  | { outcome: "granted"; token: string; expiresAt: number }
  | { outcome: "denied" }
  | { outcome: "rate_limited"; retryAfter: string };

export interface VerifyAccessDeps {
  storedHash: string;
  /** Records the attempt and says whether it's allowed — `checkAndRecordAttempt` bound to the access namespace in production. */
  checkRateLimit: (key: string) => Promise<{ allowed: boolean; retryAfter?: Date }>;
  resetRateLimit: (key: string) => Promise<void>;
  now?: number;
}

/**
 * The whole verification flow. The rate limit is checked and recorded BEFORE
 * the password is compared, so a locked-out client learns nothing. Every
 * wrong/malformed submission gets the same generic `denied`.
 */
export async function verifyAccessPassword(
  password: unknown,
  ip: string | undefined,
  deps: VerifyAccessDeps,
): Promise<VerifyAccessOutcome> {
  const key = rateLimitKeyForIp(ip);
  const limit = await deps.checkRateLimit(key);
  if (!limit.allowed) {
    return { outcome: "rate_limited", retryAfter: (limit.retryAfter ?? new Date()).toISOString() };
  }

  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return { outcome: "denied" };
  }

  if (!verifyPasswordAgainstHash(password, deps.storedHash)) {
    return { outcome: "denied" };
  }

  await deps.resetRateLimit(key);
  const { token, expiresAt } = issueAccessToken(deps.storedHash, deps.now);
  return { outcome: "granted", token, expiresAt };
}
