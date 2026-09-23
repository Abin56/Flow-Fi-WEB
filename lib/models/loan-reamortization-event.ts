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
 * What caused a `LoanReamortizationEvent` — a principal prepayment
 * triggering the automatic solve, or a manual "Edit Loan Terms" action.
 */
export type ReamortizationTriggerType = "prepayment" | "manualEditTerms";

const TRIGGER_TYPES: ReamortizationTriggerType[] = ["prepayment", "manualEditTerms"];

export function reamortizationTriggerTypeFromName(name: string): ReamortizationTriggerType {
  return (TRIGGER_TYPES as string[]).includes(name) ? (name as ReamortizationTriggerType) : "manualEditTerms";
}

export interface LoanReamortizationEvent {
  id: string;
  loanId: string;
  triggerType: ReamortizationTriggerType;
  /** FK to the `InstallmentPayment` with `allocationType === "principalPrepayment"` that caused this event. */
  triggeredByPaymentId: string | null;
  principalBefore: number;
  principalAfter: number;
  installmentCountBefore: number;
  installmentCountAfter: number;
  date: Date;
  createdAt: Date;
  /** Set when the triggering payment was later deleted and this re-amortization was undone. */
  reversed: boolean;
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
    principalBefore: data.principalBefore as number,
    principalAfter: data.principalAfter as number,
    installmentCountBefore: data.installmentCountBefore as number,
    installmentCountAfter: data.installmentCountAfter as number,
    date: (data.date as Timestamp).toDate(),
    createdAt: (data.createdAt as Timestamp).toDate(),
    reversed: (data.reversed as boolean | undefined) ?? false,
  };
}

export function loanReamortizationEventToFirestore(event: LoanReamortizationEvent): DocumentData {
  return {
    loanId: event.loanId,
    triggerType: event.triggerType,
    triggeredByPaymentId: event.triggeredByPaymentId,
    principalBefore: event.principalBefore,
    principalAfter: event.principalAfter,
    installmentCountBefore: event.installmentCountBefore,
    installmentCountAfter: event.installmentCountAfter,
    date: Timestamp.fromDate(event.date),
    createdAt: Timestamp.fromDate(event.createdAt),
    reversed: event.reversed,
  };
}
