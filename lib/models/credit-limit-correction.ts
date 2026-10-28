/**
 * Append-only audit record of one Balance Control credit-limit correction — a user-entered reconciliation
 * against a bank/lender figure, distinct from the plain field-edit history `CreditCardProfile.editHistory` /
 * `SharedCreditLimit.editHistory` already carry (those record WHAT changed; this additionally records WHY,
 * the bank's own figure, and the date the user says it took effect).
 *
 * `users/{uid}/creditCards/{cardId}/limitCorrections/{correctionId}` (standalone card) or
 * `users/{uid}/sharedCreditLimits/{sharedLimitId}/limitCorrections/{correctionId}` (shared facility).
 * Never edited after creation — a reversal soft-marks it (`reversedAt`/`reversalId`), mirroring
 * `LoanReamortizationEvent`'s reversal convention, rather than deleting it.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";

/** Why FlowFi's figure differed from the bank's — chosen by the user, never inferred. */
export type CreditLimitCorrectionReason =
  | "bankIncreased"
  | "bankDecreased"
  | "dataEntryError"
  | "sharedLimitRestructured"
  | "other";

const REASONS: CreditLimitCorrectionReason[] = ["bankIncreased", "bankDecreased", "dataEntryError", "sharedLimitRestructured", "other"];

export function creditLimitCorrectionReasonFromName(name: string): CreditLimitCorrectionReason {
  return (REASONS as string[]).includes(name) ? (name as CreditLimitCorrectionReason) : "other";
}

export interface CreditLimitCorrection {
  id: string;
  /** The card this correction targets — set only when the card is standalone (not on a shared facility). */
  cardId: string | null;
  /** The shared facility this correction targets — set only when the card shares a limit. Exactly one of `cardId` / `sharedLimitId` is set. */
  sharedLimitId: string | null;
  previousLimit: number;
  /** The bank/lender's reported limit, as typed by the user. */
  newLimit: number;
  /** The date the user says the new limit took effect (may be in the past). */
  effectiveDate: Date;
  reason: CreditLimitCorrectionReason;
  /** Free-text note / supporting reference, e.g. "SMS from bank dated 12 Oct". */
  note: string;
  createdAt: Date;
  reversedAt: Date | null;
  /** The idempotency key of the reversal action, mirroring `LoanReamortizationEvent.reversalId`. */
  reversalId: string | null;
}

export function creditLimitCorrectionFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): CreditLimitCorrection {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    cardId: (data.cardId as string | undefined) ?? null,
    sharedLimitId: (data.sharedLimitId as string | undefined) ?? null,
    previousLimit: data.previousLimit as number,
    newLimit: data.newLimit as number,
    effectiveDate: (data.effectiveDate as Timestamp).toDate(),
    reason: creditLimitCorrectionReasonFromName((data.reason as string | undefined) ?? "other"),
    note: (data.note as string | undefined) ?? "",
    createdAt: (data.createdAt as Timestamp).toDate(),
    reversedAt: (data.reversedAt as Timestamp | undefined)?.toDate() ?? null,
    reversalId: (data.reversalId as string | undefined) ?? null,
  };
}

export function creditLimitCorrectionToFirestore(c: CreditLimitCorrection): DocumentData {
  return {
    cardId: c.cardId,
    sharedLimitId: c.sharedLimitId,
    previousLimit: c.previousLimit,
    newLimit: c.newLimit,
    effectiveDate: Timestamp.fromDate(c.effectiveDate),
    reason: c.reason,
    note: c.note,
    createdAt: Timestamp.fromDate(c.createdAt),
    reversedAt: c.reversedAt == null ? null : Timestamp.fromDate(c.reversedAt),
    reversalId: c.reversalId,
  };
}
