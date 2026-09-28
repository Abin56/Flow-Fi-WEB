/**
 * Private-access gate (src/access/access-gate.ts). Pure unit tests — the
 * rate limiter is an in-memory stand-in with the same contract as
 * rate-limit.ts (which has its own emulator-backed suite). Uses a cheap
 * scrypt cost and a throwaway test-only password.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  hashAccessPassword,
  issueAccessToken,
  validateAccessToken,
  verifyAccessPassword,
  verifyPasswordAgainstHash,
  type VerifyAccessDeps,
} from "../src/access/access-gate";

const TEST_PASSWORD = "test-only-not-a-real-password";
const FAST = { N: 1024, r: 8, p: 1 };
const HASH = hashAccessPassword(TEST_PASSWORD, FAST);

function memoryLimiter(maxAttempts: number) {
  const counts = new Map<string, number>();
  return {
    checkRateLimit: vi.fn(async (key: string) => {
      const n = counts.get(key) ?? 0;
      if (n >= maxAttempts) return { allowed: false, retryAfter: new Date(Date.now() + 60_000) };
      counts.set(key, n + 1);
      return { allowed: true };
    }),
    resetRateLimit: vi.fn(async (key: string) => void counts.delete(key)),
  };
}

function deps(overrides: Partial<VerifyAccessDeps> = {}): VerifyAccessDeps {
  return { storedHash: HASH, ...memoryLimiter(5), ...overrides };
}

describe("password hash", () => {
  it("never contains the password and is salted (two hashes differ)", () => {
    expect(HASH).not.toContain(TEST_PASSWORD);
    expect(hashAccessPassword(TEST_PASSWORD, FAST)).not.toBe(HASH);
    expect(HASH.startsWith("scrypt$1024$8$1$")).toBe(true);
  });

  it("verifies only the exact password", () => {
    expect(verifyPasswordAgainstHash(TEST_PASSWORD, HASH)).toBe(true);
    expect(verifyPasswordAgainstHash(TEST_PASSWORD.slice(0, -1), HASH)).toBe(false);
    expect(verifyPasswordAgainstHash(TEST_PASSWORD + "x", HASH)).toBe(false);
  });

  it("throws (server misconfiguration) for a malformed stored hash", () => {
    expect(() => verifyPasswordAgainstHash(TEST_PASSWORD, "plaintext")).toThrow();
  });
});

describe("verifyAccessPassword", () => {
  it("denies a wrong password with a generic outcome and no token", async () => {
    const result = await verifyAccessPassword("wrong-password", "1.2.3.4", deps());
    expect(result).toEqual({ outcome: "denied" });
  });

  it("denies non-string, empty, and oversized input without hashing it", async () => {
    for (const bad of [undefined, 42, "", "x".repeat(257), { password: TEST_PASSWORD }]) {
      expect(await verifyAccessPassword(bad, "1.2.3.4", deps())).toEqual({ outcome: "denied" });
    }
  });

  it("grants a valid, unexpired token for the correct password", async () => {
    const now = Date.now();
    const result = await verifyAccessPassword(TEST_PASSWORD, "1.2.3.4", deps({ now }));
    expect(result.outcome).toBe("granted");
    if (result.outcome !== "granted") return;
    expect(result.expiresAt).toBe(now + ACCESS_TOKEN_TTL_MS);
    expect(validateAccessToken(result.token, HASH, now)).toBe(result.expiresAt);
  });

  it("never returns the password or its hash to the client", async () => {
    const result = await verifyAccessPassword(TEST_PASSWORD, "1.2.3.4", deps());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TEST_PASSWORD);
    for (const part of HASH.split("$").slice(4)) expect(serialized).not.toContain(part);
  });

  it("throttles repeated failures per IP — even the correct password is refused while locked out", async () => {
    const d = deps();
    for (let i = 0; i < 5; i++) {
      expect((await verifyAccessPassword(`wrong-${i}`, "9.9.9.9", d)).outcome).toBe("denied");
    }
    const locked = await verifyAccessPassword(TEST_PASSWORD, "9.9.9.9", d);
    expect(locked.outcome).toBe("rate_limited");
    // A different client is unaffected.
    expect((await verifyAccessPassword(TEST_PASSWORD, "8.8.8.8", d)).outcome).toBe("granted");
  });

  it("records the attempt before comparing and resets the counter on success", async () => {
    const d = deps();
    await verifyAccessPassword(TEST_PASSWORD, "1.2.3.4", d);
    expect(d.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(d.resetRateLimit).toHaveBeenCalledTimes(1);
    await verifyAccessPassword("wrong", "1.2.3.4", d);
    expect(d.resetRateLimit).toHaveBeenCalledTimes(1);
  });

  it("never uses the raw IP as the limiter key", async () => {
    const d = deps();
    await verifyAccessPassword("wrong", "203.0.113.7", d);
    const key = (d.checkRateLimit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(key).not.toContain("203.0.113.7");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("access token", () => {
  it("rejects client-invented values (booleans, strings, JSON)", () => {
    for (const forged of [true, "true", "granted", "v1.9999999999999.abc.def", JSON.stringify({ accessGranted: true })]) {
      expect(validateAccessToken(forged, HASH)).toBeNull();
    }
  });

  it("rejects a token whose expiry was edited to extend it", () => {
    const now = Date.now();
    const { token } = issueAccessToken(HASH, now);
    const [v, , nonce, sig] = token.split(".");
    expect(validateAccessToken(`${v}.${now + ACCESS_TOKEN_TTL_MS * 10}.${nonce}.${sig}`, HASH, now)).toBeNull();
  });

  it("expires after the TTL", () => {
    const now = Date.now();
    const { token } = issueAccessToken(HASH, now);
    expect(validateAccessToken(token, HASH, now + ACCESS_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(validateAccessToken(token, HASH, now + ACCESS_TOKEN_TTL_MS)).toBeNull();
  });

  it("is invalidated by rotating the password", () => {
    const { token } = issueAccessToken(HASH);
    const rotated = hashAccessPassword("another-test-only-password", FAST);
    expect(validateAccessToken(token, rotated)).toBeNull();
  });
});
