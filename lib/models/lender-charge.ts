/**
 * A verified lender charge billed against a Loan or an EMI — interest, a late-payment penalty, a processing or
 * service fee, GST — that FlowFi did not record when it was billed. It is its own liability: it never changes
 * outstanding principal, and it is not part of the installment schedule.
 *
 * FOUNDATION ONLY. This describes the data the approved `lenderCharges` subcollection will hold
 * (`loans/{id}/lenderCharges`, `emis/{id}/lenderCharges`). Nothing persists or reads it yet — there is deliberately
 * no repository or Firestore converter until the whole financial write path (billing, settlement, reporting,
 * card-linked duplicate protection, audit, reversal) can be enabled together.
 *
 * Accounting (approved policy):
 *  - Billing recognises the expense ONCE, on `billedDate`, and creates the unpaid liability. No cash moves.
 *  - Paying the charge reduces the funding account and the liability; it is never a second expense.
 *  - What has been paid is DERIVED from `settlements` (each tied to the payment transaction that moved the money),
 *    never stored as a flag that could say "paid" before the payment committed.
 *  - Reversal retires an unpaid charge (`reversedAt`) and keeps every audit entry; a paid charge is reversed only by
 *    reversing its payment first.
 */

import type { SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

export type LenderChargeType = "interest" | "penalty" | "processingFee" | "serviceFee" | "gst" | "other";

export const LENDER_CHARGE_TYPES: readonly LenderChargeType[] = ["interest", "penalty", "processingFee", "serviceFee", "gst", "other"];

export type LenderChargeAgreementKind = "loan" | "emi";

/** One payment applied to a charge. `transactionId` is the account transaction that moved the money. */
export interface LenderChargeSettlement {
  id: string;
  transactionId: string;
  amount: number;
  date: Date;
  /** Set when the payment was reversed — the amount then no longer counts as paid. */
  reversedAt: Date | null;
}

/** The user's explicit answer for a card-linked agreement (see `reviewCardRepresentation` / `cardChargeGate`). */
export interface LenderChargeCardReview {
  decision: "notOnCard" | "alreadyOnCard";
  /** Card transaction ids the user looked at and said are NOT this charge. */
  reviewedTransactionIds: string[];
  confirmedAt: Date;
}

export interface LenderCharge extends SoftDeletableEntity {
  agreementKind: LenderChargeAgreementKind;
  agreementId: string;
  type: LenderChargeType;
  /** The billed amount, > 0. Never edited after recording — a wrong charge is reversed and re-recorded. */
  amount: number;
  /** When the lender billed it: the date the expense is recognised and Net Worth moves. */
  billedDate: Date;
  /** The lender's own reference (statement / invoice / charge id). May be empty only when the lender gave none. */
  lenderReference: string;
  reason: string;
  /** Spend category of the recognised expense; null → the app's default "fees" category. */
  categoryId: string | null;
  settlements: LenderChargeSettlement[];
  reversedAt: Date | null;
  reversalReason: string | null;
  /** Only for an agreement linked to a credit card tracked in FlowFi. */
  cardReview: LenderChargeCardReview | null;
  /** Deterministic id of this recording — a retry or a second tab can never create it twice. */
  idempotencyKey: string;
  createdAt: Date;
}

/** The marker a lender-charge settlement transaction carries (additive; absent on every existing transaction). */
export interface LenderChargeSettlementMarker {
  lenderChargeId?: string | null;
}

/** True only for a transaction that settles a lender charge. Existing transactions never have the marker. */
export function isLenderChargeSettlement(t: LenderChargeSettlementMarker): boolean {
  return t.lenderChargeId != null && t.lenderChargeId !== "";
}
