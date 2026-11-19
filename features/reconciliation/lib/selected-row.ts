/**
 * The row in focus in the review, remembered for THIS browser tab so coming back to an unfinished review (e.g. after a
 * trip to Smart Capture) lands on the same row. View state only — it never touches decisions, drafts or FlowFi data, and
 * a missing/blocked/stale value just means the review opens on its own default.
 */

const KEY = "flowfi.recon.selectedRow";

/** One review = one capture on one account; a different capture or account never inherits the old selection. */
export function selectionKey(fingerprint: string, accountId: string): string {
  return `${fingerprint}:${accountId}`;
}

export function readSelectedRow(key: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): string | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { k?: unknown; id?: unknown };
    return parsed.k === key && typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

export function writeSelectedRow(key: string, rowId: string, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ k: key, id: rowId }));
  } catch {
    /* storage unavailable — the selection just isn't remembered */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
