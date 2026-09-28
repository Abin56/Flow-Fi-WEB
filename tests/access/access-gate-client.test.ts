/**
 * Client half of the private-access gate (services/access/access-gate.ts)
 * and its coupling to Google Sign-In (services/auth/auth-service.ts).
 * Firebase is mocked; the server half is covered by
 * functions/tests/access-gate.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInWithPopup = vi.fn(async () => ({ user: { uid: "u1" } }));
const firebaseSignOut = vi.fn(async () => {});

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {},
  onAuthStateChanged: vi.fn(),
  signInWithPopup: (...args: unknown[]) => signInWithPopup(...(args as [])),
  signOut: (...args: unknown[]) => firebaseSignOut(...(args as [])),
}));
vi.mock("@/lib/firebase/client", () => ({ auth: {}, functions: {} }));

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const sessionStorage = new MemoryStorage();
const localStorage = new MemoryStorage();
vi.stubGlobal("window", { sessionStorage, localStorage });

const access = await import("@/services/access/access-gate");
const authService = await import("@/services/auth/auth-service");

const TEST_PASSWORD = "test-only-password";
const VALID_TOKEN = "v1.server-issued.token.sig";

function httpsError(code: string) {
  return Object.assign(new Error(code), { code: `functions/${code}` });
}

function transport(overrides: Partial<import("@/services/access/access-gate").AccessTransport> = {}) {
  const t = {
    verify: vi.fn(async (password: string) => {
      if (password === TEST_PASSWORD) return { token: VALID_TOKEN, expiresAt: Date.now() + 60_000 };
      throw httpsError("permission-denied");
    }),
    check: vi.fn(async (token: string) =>
      token === VALID_TOKEN ? { valid: true, expiresAt: Date.now() + 60_000 } : { valid: false },
    ),
    ...overrides,
  };
  access.setAccessTransportForTests(t);
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  access.clearAccess();
  signInWithPopup.mockClear();
  firebaseSignOut.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  access.setAccessTransportForTests(null);
});

describe("access gate — client", () => {
  it("1. without verification, Google Sign-In refuses to start", async () => {
    transport();
    expect(await access.restoreAccess()).toBe("locked");
    expect(() => authService.signInWithGoogle()).toThrow("Access verification required.");
    expect(signInWithPopup).not.toHaveBeenCalled();
  });

  it("2. wrong password is denied and stays locked", async () => {
    transport();
    expect(await access.submitAccessPassword("wrong")).toEqual({ kind: "denied" });
    expect(access.useAccessStore.getState().status).toBe("locked");
    expect(sessionStorage.getItem(access.ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("3 & 10. correct password grants access and existing Google Sign-In then runs", async () => {
    transport();
    expect(await access.submitAccessPassword(TEST_PASSWORD)).toEqual({ kind: "granted" });
    expect(access.useAccessStore.getState().status).toBe("granted");
    await authService.signInWithGoogle();
    expect(signInWithPopup).toHaveBeenCalledTimes(1);
  });

  it("4. only the opaque server token is kept — never the password", async () => {
    transport();
    await access.submitAccessPassword(TEST_PASSWORD);
    const stored = JSON.stringify({ s: [...(sessionStorage as unknown as { map: Map<string, string> }).map], state: access.useAccessStore.getState() });
    expect(stored).not.toContain(TEST_PASSWORD);
    expect(sessionStorage.getItem(access.ACCESS_TOKEN_STORAGE_KEY)).toBe(VALID_TOKEN);
  });

  it("5. hand-written storage values (booleans, fake tokens) do not grant access", async () => {
    const t = transport();
    localStorage.setItem("accessGranted", "true");
    sessionStorage.setItem("accessGranted", "true");
    expect(await access.restoreAccess()).toBe("locked");

    sessionStorage.setItem(access.ACCESS_TOKEN_STORAGE_KEY, "true");
    expect(await access.restoreAccess()).toBe("locked");
    expect(t.check).toHaveBeenCalledWith("true");
    expect(sessionStorage.getItem(access.ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
    expect(() => authService.signInWithGoogle()).toThrow();
  });

  it("5b. a genuine stored token is honoured only after the server confirms it", async () => {
    const t = transport();
    sessionStorage.setItem(access.ACCESS_TOKEN_STORAGE_KEY, VALID_TOKEN);
    expect(await access.restoreAccess()).toBe("granted");
    expect(t.check).toHaveBeenCalledWith(VALID_TOKEN);
  });

  it("6. access expires and Google Sign-In is refused again", async () => {
    transport();
    await access.submitAccessPassword(TEST_PASSWORD);
    vi.advanceTimersByTime(60_001);
    expect(access.useAccessStore.getState().status).toBe("locked");
    expect(() => authService.signInWithGoogle()).toThrow();
  });

  it("6b. a server-rejected (expired) stored token requires verification again", async () => {
    transport({ check: vi.fn(async () => ({ valid: false })) });
    sessionStorage.setItem(access.ACCESS_TOKEN_STORAGE_KEY, VALID_TOKEN);
    expect(await access.restoreAccess()).toBe("locked");
  });

  it("7. throttling is surfaced distinctly", async () => {
    transport({ verify: vi.fn(async () => Promise.reject(httpsError("resource-exhausted"))) });
    expect(await access.submitAccessPassword(TEST_PASSWORD)).toEqual({ kind: "rate_limited" });
  });

  it("8. network/server errors are not reported as a wrong password", async () => {
    for (const code of ["unavailable", "internal", "deadline-exceeded"]) {
      transport({ verify: vi.fn(async () => Promise.reject(httpsError(code))) });
      expect(await access.submitAccessPassword(TEST_PASSWORD)).toEqual({ kind: "unavailable" });
    }
    transport({ verify: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) });
    expect(await access.submitAccessPassword(TEST_PASSWORD)).toEqual({ kind: "unavailable" });
  });

  it("8b. restore fails closed when the server is unreachable", async () => {
    transport({ check: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) });
    sessionStorage.setItem(access.ACCESS_TOKEN_STORAGE_KEY, VALID_TOKEN);
    expect(await access.restoreAccess()).toBe("locked");
  });

  it("11. signing out clears access, so the next sign-in needs the password again", async () => {
    transport();
    await access.submitAccessPassword(TEST_PASSWORD);
    await authService.signOut();
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(access.ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
    expect(access.useAccessStore.getState().status).toBe("locked");
    expect(() => authService.signInWithGoogle()).toThrow();
  });
});
