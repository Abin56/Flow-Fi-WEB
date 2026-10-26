/**
 * Reconciliation draft recovery (D1) — this tab's `sessionStorage`, bound to the signed-in user, expiring 12 hours
 * after the review started.
 *
 * Stored: the captured rows' working values (date, description, amount, Charge/Credit, reference, include, the
 * review flags) and the user's decisions — enough to survive a refresh or in-app navigation without pasting again.
 *
 * NEVER stored: the screenshot, the raw pasted/OCR text, the source lines, OCR word boxes or the low-confidence
 * words. Issue messages are not stored either (some quote raw OCR words) — only their codes, re-labelled on
 * restore. Smart Capture's direct-import session ids are kept only as opaque hashes.
 *
 * Privacy limits (shown to the user): plain data in this browser tab, readable by this site's own scripts; it lasts
 * until the tab closes, Discard, or 12 hours — whichever is first. Duplicating the tab copies it. It is not wiped on
 * sign-out, but a draft belonging to a different user is deleted on load and never shown.
 */

import type { CaptureField, CaptureIssue, CaptureIssueCode, CaptureRowKind } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { ReconRow, RowDecision } from "./types";

export const DRAFT_KEY_PREFIX = "flowfi.reconcile.v1.";
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;

interface StoredIssue {
  code: CaptureIssueCode;
  blocking: boolean;
  strict?: boolean;
  confirmOnly?: boolean;
  field?: CaptureField;
}

interface StoredRow {
  id: string;
  date: string | null;
  description: string;
  amount: number | null;
  direction: "debit" | "credit" | null;
  kind: CaptureRowKind;
  referenceNumber: string | null;
  amountCandidates: number[];
  confidence: "high" | "medium" | "low";
  source: "text" | "ocr";
  include: boolean;
  confirmed: boolean;
  edited: boolean;
  editedFields: CaptureField[];
  confirmedFields: CaptureField[];
  needsReconfirm: boolean;
  captureExcluded?: boolean;
  captureBaseline?: string;
  issues: StoredIssue[];
}

export interface ReconciliationDraft {
  v: 1;
  uid: string;
  createdAt: number;
  savedAt: number;
  expiresAt: number;
  fingerprint: string;
  source: "text" | "ocr";
  accountId: string | null;
  /** accountId → Smart Capture's direct-import session id for this capture (opaque hash). */
  priorSessionIds: Record<string, string>;
  rows: StoredRow[];
  decisions: Record<string, RowDecision>;
}

export interface DraftState {
  fingerprint: string;
  source: "text" | "ocr";
  accountId: string | null;
  priorSessionIds: Record<string, string>;
  rows: ReconRow[];
  decisions: Record<string, RowDecision>;
  createdAt: number;
}

/** Generic, content-free labels for restored issues. */
const ISSUE_LABEL: Record<CaptureIssueCode, string> = {
  no_amount: "Enter a positive amount.",
  multiple_amounts: "Several amounts were read on this row — check the amount.",
  direction_unclear: "Choose charge or credit.",
  no_date: "Enter a date.",
  year_assumed: "The year was assumed — check the date.",
  amount_without_decimals: "The amount was read without a decimal point — check it.",
  ocr_unverified: "Check this row against the statement.",
  low_confidence_date: "Date read with low confidence — correct or confirm it.",
  low_confidence_amount: "Amount read with low confidence — correct or confirm it.",
  low_confidence_direction: "Charge/Credit read with low confidence — check it.",
  direction_inferred: "Charge/Credit was inferred — check it.",
  partial_line: "This row may be cut off — check it.",
  merged_lines: "Built from more than one line — check it isn't two transactions.",
  decimal_missing: "The decimal point may be missing — pick the right amount.",
  possible_repeat: "Same date, merchant and amount as another row — check each is a separate transaction.",
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function keyFor(uid: string): string {
  return `${DRAFT_KEY_PREFIX}${uid}`;
}

function toStoredRow(row: ReconRow): StoredRow {
  return {
    id: row.id,
    date: row.date ? row.date.toISOString() : null,
    description: row.description,
    amount: row.amount,
    direction: row.direction,
    kind: row.kind,
    referenceNumber: row.referenceNumber,
    amountCandidates: row.amountCandidates,
    confidence: row.confidence,
    source: row.source,
    include: row.include,
    confirmed: row.confirmed,
    edited: row.edited,
    editedFields: row.editedFields,
    confirmedFields: row.confirmedFields,
    needsReconfirm: row.needsReconfirm,
    ...(row.captureExcluded ? { captureExcluded: true } : {}),
    ...(row.captureBaseline ? { captureBaseline: row.captureBaseline } : {}),
    issues: row.issues.map((i) => ({ code: i.code, blocking: i.blocking, ...(i.strict ? { strict: true } : {}), ...(i.confirmOnly ? { confirmOnly: true } : {}), ...(i.field ? { field: i.field } : {}) })),
  };
}

function fromStoredRow(s: StoredRow, index: number): ReconRow {
  const issues: CaptureIssue[] = s.issues.map((i) => ({ ...i, message: ISSUE_LABEL[i.code] ?? "Check this row." }));
  return {
    id: s.id,
    lineStart: index,
    lineEnd: index,
    sourceText: "",
    date: s.date ? new Date(s.date) : null,
    description: s.description,
    amount: s.amount,
    direction: s.direction,
    kind: s.kind,
    referenceNumber: s.referenceNumber,
    amountCandidates: s.amountCandidates,
    extraColumns: [],
    issues,
    notes: [],
    confidence: s.confidence,
    suggestedInclude: s.include,
    source: s.source,
    include: s.include,
    confirmed: s.confirmed,
    edited: s.edited,
    editedFields: s.editedFields,
    confirmedFields: s.confirmedFields,
    bulkConfirmed: false,
    action: null,
    category: null,
    committedTransactionId: null,
    needsReconfirm: s.needsReconfirm,
    captureExcluded: s.captureExcluded === true,
    ...(typeof s.captureBaseline === "string" ? { captureBaseline: s.captureBaseline } : {}),
  };
}

export function buildReconciliationDraft(uid: string, state: DraftState, now = Date.now()): ReconciliationDraft {
  return {
    v: 1,
    uid,
    createdAt: state.createdAt,
    savedAt: now,
    // Fixed from when the review started — saving again never extends it.
    expiresAt: state.createdAt + DRAFT_TTL_MS,
    fingerprint: state.fingerprint,
    source: state.source,
    accountId: state.accountId,
    priorSessionIds: state.priorSessionIds,
    rows: state.rows.map(toStoredRow),
    decisions: state.decisions,
  };
}

export function saveReconciliationDraft(draft: ReconciliationDraft): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(keyFor(draft.uid), JSON.stringify(draft));
    return true;
  } catch {
    // Quota full / storage blocked — recovery is a convenience; the review itself keeps working.
    return false;
  }
}

export type DraftLoadResult = { status: "none" } | { status: "expired" } | { status: "corrupt" } | { status: "restored"; state: DraftState; expiresAt: number };

function isValidDraft(value: unknown): value is ReconciliationDraft {
  const d = value as ReconciliationDraft | null;
  return (
    d != null &&
    d.v === 1 &&
    typeof d.uid === "string" &&
    typeof d.fingerprint === "string" &&
    typeof d.createdAt === "number" &&
    typeof d.expiresAt === "number" &&
    Array.isArray(d.rows) &&
    d.rows.every((r) => r != null && typeof r.id === "string" && Array.isArray(r.issues)) &&
    d.decisions != null &&
    typeof d.decisions === "object"
  );
}

/** Deletes every reconciliation draft in this tab that belongs to a different user. */
function removeOtherUsersDrafts(s: Storage, uid: string): void {
  const stale: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key?.startsWith(DRAFT_KEY_PREFIX) && key !== keyFor(uid)) stale.push(key);
  }
  for (const key of stale) s.removeItem(key);
}

export function loadReconciliationDraft(uid: string, now = Date.now()): DraftLoadResult {
  try {
    const s = storage();
    if (!s) return { status: "none" };
    removeOtherUsersDrafts(s, uid);
    const raw = s.getItem(keyFor(uid));
    if (!raw) return { status: "none" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      s.removeItem(keyFor(uid));
      return { status: "corrupt" };
    }
    if (!isValidDraft(parsed) || parsed.uid !== uid) {
      s.removeItem(keyFor(uid));
      return { status: "corrupt" };
    }
    if (now >= parsed.expiresAt) {
      s.removeItem(keyFor(uid));
      return { status: "expired" };
    }
    return {
      status: "restored",
      expiresAt: parsed.expiresAt,
      state: {
        fingerprint: parsed.fingerprint,
        source: parsed.source === "ocr" ? "ocr" : "text",
        accountId: parsed.accountId ?? null,
        priorSessionIds: parsed.priorSessionIds ?? {},
        rows: parsed.rows.map(fromStoredRow),
        decisions: parsed.decisions,
        createdAt: parsed.createdAt,
      },
    };
  } catch {
    return { status: "none" };
  }
}

export function clearReconciliationDraft(uid: string): void {
  try {
    storage()?.removeItem(keyFor(uid));
  } catch {
    // ignore
  }
}
