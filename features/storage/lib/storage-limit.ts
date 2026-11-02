/**
 * The user's personal storage allocation. Kept in localStorage per signed-in user, like every other Settings
 * preference in this app (`use-user-preferences.ts`), under its own key so no existing preference shape changes.
 *
 * KNOWN LIMITATION: the limit is per browser/device. Usage itself is always read from Storage, so it is the same on
 * every device; only the chosen allocation is device-local. It is a personal guard-rail, not a security boundary.
 */

import { DEFAULT_STORAGE_LIMIT_BYTES, MAX_STORAGE_LIMIT_BYTES, MIN_STORAGE_LIMIT_BYTES } from "./storage-usage";

export const STORAGE_LIMIT_CHANGED_EVENT = "flowfi:storage-limit-changed";

export function storageLimitKey(uid: string): string {
  return `flowfi:storage-limit:${uid}`;
}

export function loadStorageLimit(uid: string | undefined): number {
  if (!uid || typeof window === "undefined") return DEFAULT_STORAGE_LIMIT_BYTES;
  try {
    const raw = window.localStorage.getItem(storageLimitKey(uid));
    const n = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(n) || n < MIN_STORAGE_LIMIT_BYTES || n > MAX_STORAGE_LIMIT_BYTES) return DEFAULT_STORAGE_LIMIT_BYTES;
    return Math.round(n);
  } catch {
    return DEFAULT_STORAGE_LIMIT_BYTES;
  }
}

export function saveStorageLimit(uid: string, bytes: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageLimitKey(uid), String(Math.round(bytes)));
    window.dispatchEvent(new CustomEvent(STORAGE_LIMIT_CHANGED_EVENT, { detail: uid }));
  } catch {
    /* storage unavailable (private mode) — the limit simply stays at the default */
  }
}
