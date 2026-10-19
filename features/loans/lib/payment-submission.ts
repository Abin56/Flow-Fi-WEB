/**
 * The lifecycle of one Loan & EMI payment submission, kept out of the dialog so it can be tested:
 * a synchronous in-flight guard (two fast clicks can't both start a write — React state updates are
 * async, so a `saving` flag alone isn't enough), the real stages the write goes through, and the
 * saving → success / saving → error transitions. On error the guard is released so the user can retry
 * (with the same idempotency key — the repositories make that retry safe).
 */

import type { OperationStage } from "@/lib/operation-progress/operation-progress";

/** What a running payment write reports: its label and its real stages, with the one running now. */
export interface OperationProgressState {
  label: string;
  stages?: string[];
  current?: number;
}

/**
 * The progress band a payment stage belongs to: the first stage is the submitting write, the last is the
 * live-state refresh, and anything between (re-planning the schedule) is a related update.
 */
export function stageBand(index: number, count: number): OperationStage {
  if (count > 1 && index >= count - 1) return "refresh";
  return index <= 0 ? "submit" : "related";
}

export type SubmissionPhase = "idle" | "saving" | "success" | "error";

/**
 * The stages a payment write genuinely has. An EMI payment and a Loan payment's core are each ONE
 * atomic Firestore transaction (payment + schedule together), so they are one stage — never split into
 * fake sub-steps. Only a Loan extra-principal payment has a second write (re-planning the schedule).
 */
export function paymentStages(opts: { reamortizes: boolean }): string[] {
  return opts.reamortizes
    ? ["Recording payment", "Re-planning schedule", "Refreshing balances"]
    : ["Recording payment & schedule", "Refreshing balances"];
}

/** The live-state refresh that follows a committed write. It never decides whether the payment succeeded. */
export type RefreshState = "refreshing" | "done" | "failed";
/** How a wait for the refresh ended: it settled, or the wait gave up while it was still running. */
export type RefreshWaitOutcome = "done" | "failed" | "timeout";

export interface PaymentSubmissionHandlers<T> {
  onPhase: (phase: SubmissionPhase) => void;
  onProgress: (progress: OperationProgressState) => void;
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
  /** "refreshing" fires just before `onSuccess` (the refresh is already under way); "done"/"failed" when it settles. */
  onRefresh?: (state: RefreshState, error?: unknown) => void;
}

export interface PaymentSubmissionContext {
  /** Moves the progress to `stages[index]`. */
  stage: (index: number) => void;
}

export function createPaymentSubmission() {
  let inFlight = false;
  let refreshOutcome: Promise<"done" | "failed"> | null = null;
  return {
    get inFlight() {
      return inFlight;
    },
    /**
     * Resolves once the refresh after the committed write has settled — or with "timeout" after `maxMs`, so a
     * hung re-read can never hold a surface open. Resolves "done" when no refresh is running.
     */
    refreshSettled(maxMs: number): Promise<RefreshWaitOutcome> {
      const outcome = refreshOutcome;
      if (!outcome) return Promise.resolve("done");
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), maxMs);
        void outcome.then((o) => {
          clearTimeout(timer);
          resolve(o);
        });
      });
    },
    /**
     * Runs `write` then `refresh` unless a submission is already running (returns false then). `refresh`
     * is the live-state refresh after the write commits; its stage is always the last one. Success is
     * announced as soon as the write commits — the refresh runs after that without blocking it, and the
     * returned promise settles once the refresh has (it never rejects because of it).
     */
    async run<T>(
      opts: { label: string; stages: string[]; write: (ctx: PaymentSubmissionContext) => Promise<T>; refresh: () => Promise<unknown> },
      handlers: PaymentSubmissionHandlers<T>,
    ): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      const report = (current: number) => handlers.onProgress({ label: opts.label, stages: opts.stages, current });
      handlers.onPhase("saving");
      report(0);
      let result: T;
      try {
        result = await opts.write({ stage: report });
      } catch (e) {
        inFlight = false;
        handlers.onPhase("error");
        handlers.onError(e);
        return true;
      }
      report(opts.stages.length - 1);
      // The write has committed. The re-read starts now (invalidation is synchronous) but the confirmation
      // does not wait for it, and a failed re-read is never reported as a failed payment — the committed
      // write is not retried, and the live Firestore listeners still deliver the new state.
      const refreshing = (async (): Promise<{ error?: unknown }> => {
        try {
          await opts.refresh();
          return {};
        } catch (error) {
          return { error };
        }
      })();
      refreshOutcome = refreshing.then((r) => ("error" in r ? "failed" : "done"));
      handlers.onRefresh?.("refreshing");
      handlers.onPhase("success");
      handlers.onSuccess(result);
      const settled = await refreshing;
      if ("error" in settled) handlers.onRefresh?.("failed", settled.error);
      else handlers.onRefresh?.("done");
      // Stays locked after success — the surface closes; a second click must not record again.
      return true;
    },
  };
}
