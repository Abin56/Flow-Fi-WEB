/**
 * Smart Capture draft recovery — tab-scoped (`sessionStorage`), and
 * deliberately *without* financial content.
 *
 * Privacy assessment: the pasted statement text, the screenshot, and every
 * row's date/amount/description are NOT stored. What is stored is only the
 * user's review decisions (include, confirmed, Action, category name, which
 * rows were already imported), the selected account id, the crop rectangle,
 * and a one-way fingerprint of the source text. sessionStorage is scoped to
 * this origin and this tab and is wiped when the tab closes.
 *
 * Recovery therefore asks the user to paste the same text (or read the same
 * screenshot) again; when its fingerprint matches, the decisions are
 * re-applied. Rows the user had hand-edited come back un-confirmed, because
 * their edited values were never stored and must be re-checked.
 */

import type { CaptureField } from "./parse-pasted-statement";
import type { Rect } from "./image-crop";
import type { CaptureAction, ReviewRow } from "./capture-review";

const STORAGE_KEY = "flowfi.smartCapture.draft.v1";

export interface RowDecision {
  include: boolean;
  confirmed: boolean;
  confirmedFields: CaptureField[];
  edited: boolean;
  action: CaptureAction | null;
  category: string | null;
  committedTransactionId: string | null;
}

export interface CaptureDraft {
  v: 1;
  savedAt: number;
  fingerprint: string;
  source: "text" | "ocr";
  stage: "review" | "approve";
  accountId: string | null;
  crop: Rect | null;
  rowCount: number;
  decisions: Record<string, RowDecision>;
}

/** One-way fingerprint of the source text (whitespace-insensitive) — identifies "the same paste" without storing it. */
export function sourceFingerprint(text: string): string {
  const input = text.replace(/\s+/g, " ").trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619);
    h2 = Math.imul(h2 ^ ch, 2246822519);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}:${input.length}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function buildDraft(params: { sourceText: string; source: "text" | "ocr"; stage: "review" | "approve"; accountId: string | null; crop: Rect | null; rows: ReviewRow[] }): CaptureDraft {
  const decisions: Record<string, RowDecision> = {};
  for (const r of params.rows) {
    decisions[r.id] = {
      include: r.include,
      confirmed: r.confirmed,
      confirmedFields: r.confirmedFields,
      edited: r.edited,
      action: r.action,
      category: r.category,
      committedTransactionId: r.committedTransactionId,
    };
  }
  return {
    v: 1,
    savedAt: Date.now(),
    fingerprint: sourceFingerprint(params.sourceText),
    source: params.source,
    stage: params.stage,
    accountId: params.accountId,
    crop: params.crop,
    rowCount: params.rows.length,
    decisions,
  };
}

export function saveDraft(draft: CaptureDraft): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage full/blocked — recovery is a convenience, never required.
  }
}

export function loadDraft(): CaptureDraft | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as CaptureDraft;
    return draft?.v === 1 && typeof draft.fingerprint === "string" && draft.decisions ? draft : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Re-applies saved decisions when `sourceText` is the same source the draft was made from; otherwise null. */
export function restoreDecisions(draft: CaptureDraft, sourceText: string, rows: ReviewRow[]): { rows: ReviewRow[]; restored: number; needsRecheck: number } | null {
  if (draft.fingerprint !== sourceFingerprint(sourceText) || draft.rowCount !== rows.length) return null;
  let restored = 0;
  let needsRecheck = 0;
  const next = rows.map((row) => {
    const d = draft.decisions[row.id];
    if (!d) return row;
    restored++;
    // Hand-edited values weren't stored — the row is back to what was read, so its confirmation can't carry over.
    if (d.edited && !d.committedTransactionId) needsRecheck++;
    const keepConfirm = !d.edited || d.committedTransactionId != null;
    return {
      ...row,
      include: d.include,
      // An edited row's Action may have followed an edited direction — fall back to the one derived from the re-read row.
      action: keepConfirm ? (d.action ?? row.action) : row.action,
      category: d.category,
      committedTransactionId: d.committedTransactionId,
      confirmed: keepConfirm ? d.confirmed : false,
      confirmedFields: keepConfirm ? d.confirmedFields : [],
    };
  });
  return { rows: next, restored, needsRecheck };
}
