/**
 * Operation-stage progress for CRUD writes — the model behind the shared percentage indicator
 * (`components/feedback/operation-progress.tsx`). Pure: no React, no store, clock injected.
 *
 * Firestore exposes no byte-level progress, so the percentage is NOT network progress. It says which
 * real stage of the operation is running, each stage owning a band of the bar:
 *
 *   prepare  0–15   validating / preparing
 *   submit  15–40   the write itself
 *   related 40–70   follow-on writes (schedule, balances, linked records)
 *   refresh 70–90   re-reading / reconciling live state
 *   done      100   only once the operation has actually succeeded
 *
 * Inside a band the figure eases toward the band's ceiling but never reaches it, so a slow write keeps
 * moving without ever implying it's further along than it is. Stages only move forward; a caller may skip
 * a stage that its operation doesn't have. Nothing here waits: a fast operation jumps straight to 100.
 */

export type OperationStage = "prepare" | "submit" | "related" | "refresh";
export type OperationStatus = "running" | "success" | "error";

export const OPERATION_STAGE_BANDS: Record<OperationStage, { from: number; to: number }> = {
  prepare: { from: 0, to: 15 },
  submit: { from: 15, to: 40 },
  related: { from: 40, to: 70 },
  refresh: { from: 70, to: 90 },
};

const STAGE_ORDER: OperationStage[] = ["prepare", "submit", "related", "refresh"];

/** Secondary line when a caller doesn't name the stage more specifically. */
export const DEFAULT_STAGE_DETAIL: Record<OperationStage, string> = {
  prepare: "Preparing",
  submit: "Saving",
  related: "Updating related data",
  refresh: "Refreshing",
};

/** Time constant of the in-band easing — about two-thirds of a band is covered after this long. */
const STAGE_EASE_MS = 900;
/** The figure stays at least this far below a band's ceiling until the next stage actually starts. */
const CEILING_GAP = 1;

export interface OperationSnapshot {
  id: string;
  /** "Recording payment" — the headline while running and on failure. */
  label: string;
  status: OperationStatus;
  stage: OperationStage;
  /** "Updating installment schedule" — what the current stage is doing. */
  detail: string;
  stageStartedAt: number;
  /** "Payment recorded" — the headline once done. */
  successLabel: string;
  /** "Couldn't record payment" — the headline on failure. */
  errorLabel: string;
  errorDetail: string | null;
  /** Where the bar stopped when the operation failed. */
  frozenPercent: number | null;
  retry: (() => void) | null;
}

export interface OperationOptions {
  label: string;
  successLabel?: string;
  errorLabel?: string;
  /** Detail for the opening "prepare" stage. */
  detail?: string;
}

/** "Recording payment…" → "Recording payment"; trailing ellipses belong to spinners, not a headline with a %. */
function bare(label: string): string {
  return label.replace(/(\.\.\.|…)\s*$/, "").trim();
}

export function beginOperation(id: string, opts: OperationOptions, now: number): OperationSnapshot {
  const label = bare(opts.label);
  return {
    id,
    label,
    status: "running",
    stage: "prepare",
    detail: opts.detail ?? DEFAULT_STAGE_DETAIL.prepare,
    stageStartedAt: now,
    successLabel: opts.successLabel ?? "Done",
    errorLabel: opts.errorLabel ?? `Couldn't finish: ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
    errorDetail: null,
    frozenPercent: null,
    retry: null,
  };
}

/** The whole-number percentage to show at `now`. 100 only for a succeeded operation. */
export function operationPercent(s: OperationSnapshot, now: number): number {
  if (s.status === "success") return 100;
  if (s.status === "error") return s.frozenPercent ?? 0;
  const { from, to } = OPERATION_STAGE_BANDS[s.stage];
  const elapsed = Math.max(0, now - s.stageStartedAt);
  const eased = from + (to - from) * (1 - Math.exp(-elapsed / STAGE_EASE_MS));
  return Math.min(Math.floor(eased), to - CEILING_GAP);
}

/** Moves to `stage` (forward only — an earlier or repeated stage just updates the detail line). */
export function advanceOperation(s: OperationSnapshot, stage: OperationStage, detail: string | undefined, now: number): OperationSnapshot {
  if (s.status !== "running") return s;
  if (STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(s.stage)) return detail ? { ...s, detail } : s;
  return { ...s, stage, detail: detail ?? DEFAULT_STAGE_DETAIL[stage], stageStartedAt: now };
}

export function completeOperation(s: OperationSnapshot, successLabel?: string): OperationSnapshot {
  if (s.status !== "running") return s;
  return { ...s, status: "success", successLabel: successLabel ?? s.successLabel };
}

/** Stops the bar where it is — never at 100 — and records why. */
export function failOperation(
  s: OperationSnapshot,
  now: number,
  opts: { detail?: string | null; errorLabel?: string; retry?: (() => void) | null } = {},
): OperationSnapshot {
  if (s.status !== "running") return s;
  return {
    ...s,
    status: "error",
    frozenPercent: operationPercent(s, now),
    errorLabel: opts.errorLabel ?? s.errorLabel,
    errorDetail: opts.detail ?? null,
    retry: opts.retry ?? null,
  };
}

/* ───────────────────────── Handle ───────────────────────── */

/** The success toast shown once the progress surface is dismissed. */
export interface OperationToast {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export interface OperationSink {
  update: (snapshot: OperationSnapshot) => void;
  /** Called once the success confirmation has been shown (and, for a floating surface, after a failure times out). */
  remove: () => void;
  /** Success feedback shown after the progress surface is dismissed — the app's toast. */
  toast?: (toast: OperationToast) => void;
}

export interface OperationClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

const realClock: OperationClock = { now: () => Date.now(), setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) };

/** How long "✓ Payment recorded · 100%" stays before the surface goes and the toast appears. */
export const SUCCESS_HOLD_MS = 700;

export interface OperationHandle {
  readonly id: string;
  /** Enter a stage; `detail` is the secondary line ("Updating installment schedule"). */
  stage: (stage: OperationStage, detail?: string) => void;
  /** Mark done: jump to 100% with a check, then dismiss and show `toast` (if given). */
  succeed: (opts?: { label?: string; toast?: OperationToast }) => void;
  /** Mark failed: stop the bar, show the failure; `retry` renders a "Try again" action. */
  fail: (opts?: { detail?: string | null; label?: string; retry?: () => void }) => void;
  /** Remove the surface without a result (e.g. the user cancelled a confirmation step). */
  dismiss: () => void;
}

export function createOperation(opts: OperationOptions, sink: OperationSink, clock: OperationClock = realClock, id: string = randomId()): OperationHandle {
  let snapshot = beginOperation(id, opts, clock.now());
  let removed = false;
  sink.update(snapshot);
  const set = (next: OperationSnapshot) => {
    if (removed || next === snapshot) return;
    snapshot = next;
    sink.update(next);
  };
  const remove = () => {
    if (removed) return;
    removed = true;
    sink.remove();
  };
  return {
    id,
    stage: (stage, detail) => set(advanceOperation(snapshot, stage, detail, clock.now())),
    succeed: (o = {}) => {
      if (snapshot.status !== "running") return;
      set(completeOperation(snapshot, o.label));
      clock.setTimeout(() => {
        remove();
        if (o.toast) sink.toast?.(o.toast);
      }, SUCCESS_HOLD_MS);
    },
    fail: (o = {}) => set(failOperation(snapshot, clock.now(), { detail: o.detail, errorLabel: o.label, retry: o.retry ?? null })),
    dismiss: remove,
  };
}

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Math.random().toString(36).slice(2)}`;
}

/** An error's message for the failure line, or null when it has nothing useful to say. */
export function errorDetail(e: unknown): string | null {
  return e instanceof Error && e.message.trim() !== "" ? e.message : null;
}
