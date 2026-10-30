/**
 * Smart Capture → Reconciliation handoff (Phase 3). In memory only — a module-level store that lives as long as this
 * tab's JavaScript does. Nothing here is written to Firestore, localStorage or sessionStorage; a page refresh clears
 * it (the reconciliation draft survives a refresh on its own, without the screenshot — see reconciliation-draft.ts).
 *
 * Three slots, each with one owner:
 *  - `pending`: a capture Smart Capture handed over, waiting for Reconciliation to take it. Reconciliation
 *    consumes it (or, when another review is already in progress, the user explicitly keeps or replaces).
 *  - `screenshot`: the screenshot Reconciliation is showing beside its rows. Its object URL is created HERE from the
 *    image Blob, so it is independent of Smart Capture's own URL (which Smart Capture revokes when it unmounts).
 *    Revoked when replaced, declined or discarded.
 *  - `snapshot`: what Smart Capture needs to reopen exactly where the user left it ("Back to Smart Capture"). It
 *    keeps the Blob, never a URL — Smart Capture creates and owns its own URL when it restores.
 *
 * Handoff never changes a value: rows keep their parser-assigned ids (not display order), dates, amounts,
 * directions, descriptions, include state and every confirmation/issue flag exactly as reviewed.
 */

import type { ReviewRow } from "@/features/smart-capture/lib/capture-review";
import { sourceFingerprint } from "@/features/smart-capture/lib/capture-draft";
import type { CaptureParseResult } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { Rect } from "@/features/smart-capture/lib/image-crop";
import type { CaptureMode, OcrCapture } from "@/features/smart-capture/components/capture-input";
import type { Account } from "@/lib/models/account";
import { priorCaptureSessionIds } from "./session-key";
import type { ReconRow } from "./types";

export interface HandoffScreenshot {
  fingerprint: string;
  /** OCR geometry with `imageUrl` = this store's own object URL. */
  capture: OcrCapture;
}

export interface PendingHandoff {
  id: string;
  fingerprint: string;
  source: "text" | "ocr";
  rows: ReconRow[];
  accountId: string | null;
  priorSessionIds: Record<string, string>;
  screenshot: HandoffScreenshot | null;
  createdAt: number;
}

export interface CaptureSnapshot {
  fingerprint: string;
  sourceText: string;
  parse: CaptureParseResult;
  rows: ReviewRow[];
  /** OCR geometry; its `imageUrl` is stale — Smart Capture replaces it with its own URL on restore. */
  ocr: OcrCapture | null;
  image: { file: Blob; name: string } | null;
  crop: Rect | null;
  mode: CaptureMode;
  accountId: string | null;
}

interface HandoffState {
  pending: PendingHandoff | null;
  screenshot: HandoffScreenshot | null;
  snapshot: CaptureSnapshot | null;
}

let state: HandoffState = { pending: null, screenshot: null, snapshot: null };
const listeners = new Set<() => void>();

function emit(next: HandoffState) {
  state = next;
  for (const l of listeners) l();
}

function revoke(shot: HandoffScreenshot | null, keep?: HandoffScreenshot | null) {
  if (shot && shot.capture.imageUrl !== keep?.capture.imageUrl) {
    try {
      URL.revokeObjectURL(shot.capture.imageUrl);
    } catch {
      // ignore
    }
  }
}

export function subscribeHandoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHandoffState(): HandoffState {
  return state;
}

export type HandoffInput = {
  sourceText: string;
  parse: CaptureParseResult;
  rows: ReviewRow[];
  ocr: OcrCapture | null;
  image: { file: Blob; name: string } | null;
  crop: Rect | null;
  mode: CaptureMode;
  accountId: string | null;
  accounts: Pick<Account, "id" | "deletedAt">[];
};

/**
 * Smart Capture → Review & Import, straight after extraction. Rows arrive exactly as read — including the ones
 * that still need an OCR check or a correction: Review & Import settles those (Smart Capture's own gates —
 * `openIssues`, `isComplete` — are what its import gate `valueIssues` reads), so nothing unresolved can be imported.
 * Rows the parser suggested leaving out (a cut-off sliver, an EMI or card-payment line) arrive excluded, and can be
 * included there. Refuses only an empty capture.
 */
export function handOffCapture(input: HandoffInput): { ok: true; id: string } | { ok: false; error: string } {
  if (input.rows.length === 0) return { ok: false, error: "No rows were extracted." };
  const fingerprint = sourceFingerprint(input.sourceText);
  const id = `handoff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  let screenshot: HandoffScreenshot | null = null;
  if (input.ocr && input.image) {
    screenshot = { fingerprint, capture: { ...input.ocr, imageUrl: URL.createObjectURL(input.image.file) } };
  }
  // A newer Continue supersedes an earlier one Reconciliation hasn't taken yet.
  revoke(state.pending?.screenshot ?? null, state.screenshot);

  const rows: ReconRow[] = input.rows.map((r) => ({ ...r, needsReconfirm: false, captureExcluded: false }));
  emit({
    ...state,
    pending: {
      id,
      fingerprint,
      source: input.ocr ? "ocr" : "text",
      rows,
      accountId: input.accountId,
      priorSessionIds: priorCaptureSessionIds(input.sourceText, input.accounts.filter((a) => a.deletedAt == null)),
      screenshot,
      createdAt: Date.now(),
    },
    snapshot: {
      fingerprint,
      sourceText: input.sourceText,
      parse: input.parse,
      rows: input.rows,
      ocr: input.ocr,
      image: input.image,
      crop: input.crop,
      mode: input.mode,
      accountId: input.accountId,
    },
  });
  return { ok: true, id };
}

/** Reconciliation takes the pending capture; its screenshot becomes the one shown (the previous one is revoked). */
export function consumePendingHandoff(): PendingHandoff | null {
  const pending = state.pending;
  if (!pending) return null;
  revoke(state.screenshot, pending.screenshot);
  emit({ ...state, pending: null, screenshot: pending.screenshot ?? (state.screenshot?.fingerprint === pending.fingerprint ? state.screenshot : null) });
  return pending;
}

/** The user kept their current review instead — the newer capture's screenshot is released. Smart Capture's snapshot stays. */
export function declinePendingHandoff(): void {
  if (!state.pending) return;
  revoke(state.pending.screenshot, state.screenshot);
  emit({ ...state, pending: null });
}

/** Reconciliation discarded its review — release the screenshot it was showing. */
export function releaseReconciliationScreenshot(): void {
  if (!state.screenshot) return;
  revoke(state.screenshot);
  emit({ ...state, screenshot: null });
}

/** Smart Capture discarded its capture / started a new one — forget the restore snapshot (never a review in progress). */
export function clearCaptureSnapshot(): void {
  if (!state.snapshot) return;
  emit({ ...state, snapshot: null });
}

export function screenshotFor(fingerprint: string | null | undefined): HandoffScreenshot | null {
  return fingerprint && state.screenshot?.fingerprint === fingerprint ? state.screenshot : null;
}

/** Test-only: releases everything. */
export function _resetHandoffForTests(): void {
  revoke(state.pending?.screenshot ?? null);
  revoke(state.screenshot);
  state = { pending: null, screenshot: null, snapshot: null };
  for (const l of listeners) l();
}
