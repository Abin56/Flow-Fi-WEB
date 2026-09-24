/**
 * Direct port of
 * `lib/features/lending/domain/loan_additional_disbursement.dart`.
 * A single "more principal was added to this loan" event —
 * `users/{uid}/loans/{loanId}/additionalDisbursements/{disbursementId}`.
 * Deliberately NOT an `InstallmentPayment`: a disbursement isn't a payment
 * against any installment (it moves money in the OPPOSITE direction of a
 * payment — see `LoanAdvancePaymentRepository.recordAdditionalDisbursement`'s
 * doc comment) and forcing it into that shape would overload
 * `InstallmentPayment.amount`/`allocationType`/`prepaymentPrincipalAmount`
 * with misleading semantics. Append-only — soft-delete (via
 * `LoanAdvancePaymentRepository.reverseAdditionalDisbursement`) is the only
 * way its effect changes.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

export interface LoanAdditionalDisbursement extends SoftDeletableEntity {
  loanId: string;
  /** Always positive — the amount of principal added. Never applied toward any `Installment.amountPaid`; it increases `Loan.loanAmount` directly. */
  amount: number;
  date: Date;
  note: string;
  createdAt: Date;
  /** FK to the `Transaction` this disbursement moved money through. */
  transactionId: string | null;
  /**
   * FK to the `LoanReamortizationEvent` this disbursement triggered, when
   * the re-amortization solve succeeded. Null when the solve was
   * unsolvable or skipped (nothing to re-amortize).
   */
  reamortizationEventId: string | null;
}

export function loanAdditionalDisbursementFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): LoanAdditionalDisbursement {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    loanId: data.loanId as string,
    amount: data.amount as number,
    date: (data.date as Timestamp).toDate(),
    note: (data.note as string | undefined) ?? "",
    createdAt: (data.createdAt as Timestamp).toDate(),
    transactionId: (data.transactionId as string | undefined) ?? null,
    reamortizationEventId: (data.reamortizationEventId as string | undefined) ?? null,
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: [],
  };
}

export function loanAdditionalDisbursementToFirestore(disbursement: LoanAdditionalDisbursement): DocumentData {
  return {
    loanId: disbursement.loanId,
    amount: disbursement.amount,
    date: Timestamp.fromDate(disbursement.date),
    note: disbursement.note,
    createdAt: Timestamp.fromDate(disbursement.createdAt),
    transactionId: disbursement.transactionId,
    reamortizationEventId: disbursement.reamortizationEventId,
    deletedAt: disbursement.deletedAt == null ? null : Timestamp.fromDate(disbursement.deletedAt),
    lastEditedAt: disbursement.lastEditedAt == null ? null : Timestamp.fromDate(disbursement.lastEditedAt),
    editHistory: [],
  };
}
