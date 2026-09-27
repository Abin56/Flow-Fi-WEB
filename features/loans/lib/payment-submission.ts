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

export interface PaymentSubmissionHandlers<T> {
  onPhase: (phase: SubmissionPhase) => void;
  onProgress: (progress: OperationProgressState) => void;
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
}

export interface PaymentSubmissionContext {
  /** Moves the progress to `stages[index]`. */
  stage: (index: number) => void;
}

export function createPaymentSubmission() {
  let inFlight = false;
  return {
    get inFlight() {
      return inFlight;
    },
    /**
     * Runs `write` then `refresh` unless a submission is already running (returns false then). `refresh`
     * is the live-state refresh after the write commits; its stage is always the last one.
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
      // The write has committed — a failed re-read must never be reported as a failed payment (the live
      // Firestore listeners still deliver the new state), so it can't turn this into an error.
      await opts.refresh().catch(() => undefined);
      handlers.onPhase("success");
      handlers.onSuccess(result);
      // Stays locked after success — the surface closes; a second click must not record again.
      return true;
    },
  };
}
