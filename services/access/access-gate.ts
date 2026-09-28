/**
 * Client side of the private-access gate (Layer 1, before Google Sign-In).
 * See functions/src/access/access-gate.ts for the server half.
 *
 * The browser only ever holds an opaque, HMAC-signed, expiring token issued
 * by `verifyAccessPasswordCallable`. `granted` is set ONLY from a server
 * response — a stored token is re-validated by `checkAccessTokenCallable`
 * before it counts, so writing booleans or made-up tokens into storage from
 * DevTools grants nothing. The token lives in sessionStorage: it dies with
 * the tab, never outlives its server-side expiry, and is cleared on sign-out.
 *
 * The submitted password is passed straight to the callable and never
 * stored, logged, or kept in this module.
 */

import { create } from "zustand";

export const ACCESS_TOKEN_STORAGE_KEY = "flowfi.accessToken";

export type AccessStatus = "checking" | "locked" | "granted";

export type VerifyResult =
  | { kind: "granted" }
  | { kind: "denied" }
  | { kind: "rate_limited" }
  | { kind: "unavailable" };

export interface AccessTransport {
  verify: (password: string) => Promise<{ token: string; expiresAt: number }>;
  check: (token: string) => Promise<{ valid: boolean; expiresAt?: number }>;
}

interface AccessState {
  status: AccessStatus;
  expiresAt: number | null;
}

export const useAccessStore = create<AccessState>(() => ({ status: "checking", expiresAt: null }));

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function lock() {
  clearTimeout(expiryTimer);
  try {
    storage()?.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
  useAccessStore.setState({ status: "locked", expiresAt: null });
}

function grant(token: string, expiresAt: number) {
  try {
    storage()?.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage unavailable — access still holds for this page load.
  }
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(lock, Math.max(0, expiresAt - Date.now()));
  useAccessStore.setState({ status: "granted", expiresAt });
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code.replace(/^functions\//, "") : undefined;
}

async function defaultTransport(): Promise<AccessTransport> {
  const [{ httpsCallable }, { functions }] = await Promise.all([import("firebase/functions"), import("@/lib/firebase/client")]);
  const verifyFn = httpsCallable<{ password: string }, { token: string; expiresAt: number }>(functions, "verifyAccessPasswordCallable");
  const checkFn = httpsCallable<{ token: string }, { valid: boolean; expiresAt?: number }>(functions, "checkAccessTokenCallable");
  return {
    verify: async (password) => (await verifyFn({ password })).data,
    check: async (token) => (await checkFn({ token })).data,
  };
}

let transportOverride: AccessTransport | null = null;

/** Test seam only. */
export function setAccessTransportForTests(transport: AccessTransport | null) {
  transportOverride = transport;
}

async function transport(): Promise<AccessTransport> {
  return transportOverride ?? defaultTransport();
}

/** Submits the password for server-side verification. */
export async function submitAccessPassword(password: string): Promise<VerifyResult> {
  try {
    const { token, expiresAt } = await (await transport()).verify(password);
    if (typeof token !== "string" || typeof expiresAt !== "number" || expiresAt <= Date.now()) {
      lock();
      return { kind: "unavailable" };
    }
    grant(token, expiresAt);
    return { kind: "granted" };
  } catch (err) {
    lock();
    const code = errorCode(err);
    if (code === "permission-denied") return { kind: "denied" };
    if (code === "resource-exhausted") return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}

/**
 * Restores access from a previously issued token by asking the server whether
 * it's still valid. Anything else in storage is ignored. If the server can't
 * be reached, the gate stays locked (fail closed).
 */
export async function restoreAccess(): Promise<AccessStatus> {
  let token: string | null = null;
  try {
    token = storage()?.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? null;
  } catch {
    token = null;
  }
  if (!token) {
    lock();
    return "locked";
  }
  useAccessStore.setState({ status: "checking", expiresAt: null });
  try {
    const result = await (await transport()).check(token);
    if (result.valid && typeof result.expiresAt === "number" && result.expiresAt > Date.now()) {
      grant(token, result.expiresAt);
      return "granted";
    }
  } catch {
    // Fall through — fail closed.
  }
  lock();
  return "locked";
}

/** Called on sign-out so the next sign-in needs the access password again. */
export function clearAccess() {
  lock();
}

/** Throws unless the gate is currently open. Google Sign-In calls this first. */
export function assertAccessGranted() {
  const { status, expiresAt } = useAccessStore.getState();
  if (status !== "granted" || expiresAt === null || expiresAt <= Date.now()) {
    if (status === "granted") lock();
    throw Object.assign(new Error("Access verification required."), { code: "flowfi/access-required" });
  }
}
