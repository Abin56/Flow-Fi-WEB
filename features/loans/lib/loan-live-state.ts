/**
 * Pure helpers that keep the open Loan UI converging on persisted Firestore state. No React, no
 * Firestore — unit-testable in this project's Node-only test environment.
 */

import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";

/**
 * React Query key for a loan's payment/principal history. The history is a one-shot read (it spans
 * per-installment `payments` subcollections, which one live listener can't cover), so it must
 * re-read whenever the live data it summarizes changes. Every money operation leaves a trace in the
 * live Loan/installment snapshot that this key includes:
 *  - EMI, partial, advance and multi-EMI payments → an installment's `amountPaid`
 *  - extra principal (re-planned) → the installment ids of the regenerated tail
 *  - borrow/lend more → `loanAmount` (plus the regenerated tail)
 *  - each reversal → the same fields moving back
 * The previous key only included installment ids, so an ordinary payment (ids unchanged) left the
 * open dialog's history stale until it was closed and reopened.
 */
export function loanHistoryQueryKey(
  uid: string | undefined,
  loan: Pick<Loan, "id" | "scheduleId" | "loanAmount" | "installmentCount" | "editHistory">,
  installments: Pick<Installment, "id" | "amountPaid" | "isSkipped">[],
): readonly unknown[] {
  const scheduleFingerprint = installments.map((i) => `${i.id}:${i.amountPaid}:${i.isSkipped ? 1 : 0}`).join(",");
  return [
    "loan-financial-history",
    uid,
    loan.id,
    loan.scheduleId,
    loan.loanAmount,
    loan.installmentCount ?? null,
    loan.editHistory.length,
    scheduleFingerprint,
  ] as const;
}

/**
 * Installment ids whose `payments` subcollection may hold this loan's history: the live schedule plus
 * every installment an extra-principal / additional-amount re-plan retired. The extra-principal
 * payment record is written under the schedule's LAST installment, which a successful re-plan then
 * soft-deletes — reading only the live schedule made that entry vanish from history.
 */
export function historyInstallmentIds(liveInstallmentIds: string[], events: { retiredInstallmentIds: string[] }[]): string[] {
  return Array.from(new Set([...liveInstallmentIds, ...events.flatMap((event) => event.retiredInstallmentIds)]));
}

/**
 * User-facing message for a failed Loan mutation. Repository validation errors are plain `Error`s
 * written for people ("Loan amount can't be less than…") and are shown as-is; Firestore/network
 * failures (`FirebaseError`, which carries a `code`) have internal text and get the fallback.
 */
export function friendlyLoanError(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!(error instanceof Error)) return fallback;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || error.name === "FirebaseError") {
    return code === "unavailable" ? "You appear to be offline. Check your connection and try again." : fallback;
  }
  return error.message.trim() || fallback;
}
