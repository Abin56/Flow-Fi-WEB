/**
 * Direct port of `lib/features/lending/domain/loan_reamortization_event.dart`.
 * Append-only audit record of one re-amortization —
 * `users/{uid}/loans/{loanId}/reamortizationEvents/{eventId}`. Never edited
 * after creation; a reversal (payment-deletion path, not yet built) soft-marks
 * it rather than deleting it, keeping the history honest.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";

/**
 * What caused a `LoanReamortizationEvent` — a principal prepayment or an
 * additional disbursement triggering the automatic solve, or a manual
 * "Edit Loan Terms" action.
 */
export type ReamortizationTriggerType = "prepayment" | "manualEditTerms" | "additionalDisbursement";

const TRIGGER_TYPES: ReamortizationTriggerType[] = ["prepayment", "manualEditTerms", "additionalDisbursement"];

export function reamortizationTriggerTypeFromName(name: string): ReamortizationTriggerType {
  return (TRIGGER_TYPES as string[]).includes(name) ? (name as ReamortizationTriggerType) : "manualEditTerms";
}

export interface LoanReamortizationEvent {
  id: string;
  loanId: string;
  triggerType: ReamortizationTriggerType;
  /** FK to the `InstallmentPayment` with `allocationType === "principalPrepayment"` that caused this event. Null for an "additionalDisbursement"-triggered event (see `triggeredByDisbursementId` instead). */
  triggeredByPaymentId: string | null;
  /** FK to the `LoanAdditionalDisbursement` that caused this event — set only when `triggerType` is "additionalDisbursement". Null for every other trigger type. */
  triggeredByDisbursementId: string | null;
  principalBefore: number;
  principalAfter: number;
  installmentCountBefore: number;
  installmentCountAfter: number;
  date: Date;
  createdAt: Date;
  /** Set when the triggering payment was later deleted and this re-amortization was undone. */
  reversed: boolean;
  /**
   * The exact ids of the installments this event soft-deleted (the
   * "untouched" tail that existed before re-amortization) — required to
   * restore the original schedule on reversal without guessing from
   * `sequenceNumber`/timestamps. Empty for legacy events predating this
   * field, which are consequently **not** safely reversible (see
   * `LoanAdvancePaymentRepository.reversePayment`'s eligibility check).
   */
  retiredInstallmentIds: string[];
  /** The exact ids of the installments this event generated (the new tail) — required to retire them again on reversal. */
  generatedInstallmentIds: string[];
  /** `PaymentSchedule.totalAmount` immediately before this event — needed to restore the schedule's cached total on reversal. Null for legacy events. */
  scheduleTotalAmountBefore: number | null;
  /**
   * `Loan.loanAmount` immediately before this event — only set when
   * `triggerType` is "additionalDisbursement", needed to reverse the
   * principal bump exactly. Null for every other trigger type and for
   * legacy disbursement events predating this field (which are
   * consequently not safely reversible).
   */
  loanAmountBefore: number | null;
  /** When `reversed` was set — null until then. */
  reversedAt: Date | null;
  /**
   * The idempotency key of the reversal action that set `reversed` — lets a
   * retried reversal detect it already happened, mirroring
   * `LoanAdvancePaymentRepository.record`'s own idempotency scheme. Null
   * until reversed.
   */
  reversalId: string | null;
}

export function loanReamortizationEventFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): LoanReamortizationEvent {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    loanId: data.loanId as string,
    triggerType: reamortizationTriggerTypeFromName(data.triggerType as string),
    triggeredByPaymentId: (data.triggeredByPaymentId as string | undefined) ?? null,
    triggeredByDisbursementId: (data.triggeredByDisbursementId as string | undefined) ?? null,
    principalBefore: data.principalBefore as number,
    principalAfter: data.principalAfter as number,
    installmentCountBefore: data.installmentCountBefore as number,
    installmentCountAfter: data.installmentCountAfter as number,
    date: (data.date as Timestamp).toDate(),
    createdAt: (data.createdAt as Timestamp).toDate(),
    reversed: (data.reversed as boolean | undefined) ?? false,
    retiredInstallmentIds: (data.retiredInstallmentIds as string[] | undefined) ?? [],
    generatedInstallmentIds: (data.generatedInstallmentIds as string[] | undefined) ?? [],
    scheduleTotalAmountBefore: (data.scheduleTotalAmountBefore as number | undefined) ?? null,
    loanAmountBefore: (data.loanAmountBefore as number | undefined) ?? null,
    reversedAt: (data.reversedAt as Timestamp | undefined)?.toDate() ?? null,
    reversalId: (data.reversalId as string | undefined) ?? null,
  };
}

export function loanReamortizationEventToFirestore(event: LoanReamortizationEvent): DocumentData {
  return {
    loanId: event.loanId,
    triggerType: event.triggerType,
    triggeredByPaymentId: event.triggeredByPaymentId,
    triggeredByDisbursementId: event.triggeredByDisbursementId,
    principalBefore: event.principalBefore,
    principalAfter: event.principalAfter,
    installmentCountBefore: event.installmentCountBefore,
    installmentCountAfter: event.installmentCountAfter,
    date: Timestamp.fromDate(event.date),
    createdAt: Timestamp.fromDate(event.createdAt),
    reversed: event.reversed,
    retiredInstallmentIds: event.retiredInstallmentIds,
    generatedInstallmentIds: event.generatedInstallmentIds,
    scheduleTotalAmountBefore: event.scheduleTotalAmountBefore,
    loanAmountBefore: event.loanAmountBefore,
    reversedAt: event.reversedAt == null ? null : Timestamp.fromDate(event.reversedAt),
    reversalId: event.reversalId,
  };
}
