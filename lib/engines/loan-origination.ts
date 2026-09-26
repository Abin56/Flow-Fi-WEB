/**
 * Pure origination contract for `LoanRepository.createAgreementWithOrigination` — deterministic
 * document IDs and the single physical money movement (if any) a new Loan-backed agreement records.
 * Mirrors `lib/features/lending/domain/loan_origination.dart` exactly; both apps are held to the same
 * answers by `tests/cross-platform-fixtures/loan-origination-fixture.json`.
 *
 * Rules:
 *  - Account movement is opt-in. With no `movementAccountId` there is no Transaction and no Account write.
 *  - Money I Borrowed (`loan`, "taken") records the principal received: +loanAmount into the Account.
 *  - Money I Lent (`loan`, "given") records the principal sent: −loanAmount out of the Account.
 *  - Installment Purchase records only the down payment actually paid now: −downPayment. The financed
 *    principal (`loanAmount`) never moves an Account at origination, and no purchase Transaction is ever
 *    created here — a tracked card purchase is linked by `purchaseTransactionId`, never invented.
 *  - Principal movements reuse the existing `additionalDisbursement` allocation (a principal
 *    disbursement, not income/spending — see `isLoanPrincipalDisbursement`). A down payment carries no
 *    allocation, so it keeps ordinary purchase (expense) semantics.
 */

import type { LoanAgreementKind, LoanDirection, LoanRepaymentType } from "@/lib/models/loan";
import type { PaymentAllocationType, ScheduleType } from "@/lib/models/payment-schedule";

/**
 * Writes in one origination = Loan + schedule + installments + (Transaction + Account). Firestore caps
 * one transaction's commit at 500 writes; staying well below keeps the whole origination one atomic
 * commit instead of a multi-phase state machine.
 */
export const MAX_ATOMIC_ORIGINATION_INSTALLMENTS = 480;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function assertValidOriginationKey(idempotencyKey: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new Error("Origination idempotency key must be 8–128 letters, digits, '-' or '_'");
  }
}

export interface OriginationIds {
  loanId: string;
  scheduleId: string;
  transactionId: string;
  /** 1-based, matching `Installment.sequenceNumber`. */
  installmentId: (sequenceNumber: number) => string;
}

/** Every document an origination creates, derived only from the caller's idempotency key. */
export function originationIdsFor(idempotencyKey: string): OriginationIds {
  assertValidOriginationKey(idempotencyKey);
  const prefix = `orig_${idempotencyKey}`;
  return {
    loanId: `${prefix}_loan`,
    scheduleId: `${prefix}_sched`,
    transactionId: `${prefix}_txn`,
    installmentId: (sequenceNumber) => `${prefix}_inst_${sequenceNumber}`,
  };
}

/** True for a Transaction written by an origination (labels only — never used for money math). */
export function isOriginationTransactionId(transactionId: string): boolean {
  return transactionId.startsWith("orig_") && transactionId.endsWith("_txn");
}

export type OriginationMovementKind = "principalReceived" | "principalSent" | "downPaymentPaid";

export interface OriginationMovement {
  kind: OriginationMovementKind;
  transactionType: "income" | "expense";
  amount: number;
  /** Signed Account.currentBalance delta. */
  balanceDelta: number;
  allocationType: PaymentAllocationType | null;
}

export interface OriginationMovementInput {
  agreementKind: LoanAgreementKind;
  direction: LoanDirection;
  loanAmount: number;
  downPayment: number | null;
  /** Null = "agreement already exists / do not move money now". */
  movementAccountId: string | null;
}

export function planOriginationMovement(input: OriginationMovementInput): OriginationMovement | null {
  if (input.movementAccountId == null) return null;
  if (input.agreementKind === "installmentPurchase") {
    const down = input.downPayment ?? 0;
    if (!(down > 0)) throw new Error("There is no down payment to record");
    return { kind: "downPaymentPaid", transactionType: "expense", amount: down, balanceDelta: -down, allocationType: null };
  }
  return input.direction === "taken"
    ? { kind: "principalReceived", transactionType: "income", amount: input.loanAmount, balanceDelta: input.loanAmount, allocationType: "additionalDisbursement" }
    : { kind: "principalSent", transactionType: "expense", amount: input.loanAmount, balanceDelta: -input.loanAmount, allocationType: "additionalDisbursement" };
}

export function originationDescription(kind: OriginationMovementKind, name: string | null): string {
  const label = kind === "principalReceived" ? "Loan received" : kind === "principalSent" ? "Money lent" : "Down payment";
  return name?.trim() ? `${label} — ${name.trim()}` : label;
}

/** Schedule shape for a new Loan: a one-time loan is one "oneTime" installment on its due date — never fake monthly rows. */
export function originationScheduleShape(
  repaymentType: LoanRepaymentType,
  installmentFrequency: ScheduleType | null,
  installmentCount: number | null,
): { scheduleType: ScheduleType; installmentCount: number } {
  return repaymentType === "oneTime"
    ? { scheduleType: "oneTime", installmentCount: 1 }
    : { scheduleType: installmentFrequency!, installmentCount: installmentCount! };
}

export interface OriginationPrincipalEffect {
  /** Change to the chosen Account's balance (0 when no movement is recorded). */
  accountDelta: number;
  /** New Loan-owned liability (Money I Borrowed, or a non-card installment purchase). */
  liabilityDelta: number;
  /** New receivable (Money I Lent). */
  receivableDelta: number;
}

/**
 * Balance-sheet effect of the origination itself (before any repayment). A card-financed purchase adds
 * no Loan-owned liability — the card owns that exposure (Case A: the linked purchase; Case B: the locked
 * remaining installment principal), exactly as `unifiedAgreementFromLoan` reports it.
 */
export function originationPrincipalEffect(
  input: OriginationMovementInput & { fundingSource: string | null },
): OriginationPrincipalEffect {
  const movement = planOriginationMovement(input);
  const accountDelta = movement?.balanceDelta ?? 0;
  if (input.direction === "given") return { accountDelta, liabilityDelta: 0, receivableDelta: input.loanAmount };
  const cardOwned = input.agreementKind === "installmentPurchase" && input.fundingSource === "creditCard";
  return { accountDelta, liabilityDelta: cardOwned ? 0 : input.loanAmount, receivableDelta: 0 };
}

/** The idempotency key a wizard-created Loan was originated with, or null for any other Loan. */
export function originationKeyFromLoanId(loanId: string): string | null {
  const match = /^orig_([A-Za-z0-9_-]{8,128})_loan$/.exec(loanId);
  return match == null ? null : match[1];
}

/** Which origination movement a recorded origination Transaction represents. */
export function originationMovementKindOf(transaction: { type: "income" | "expense"; paymentAllocationType: PaymentAllocationType | null }): OriginationMovementKind {
  if (transaction.paymentAllocationType == null) return "downPaymentPaid";
  return transaction.type === "income" ? "principalReceived" : "principalSent";
}

/** Indian-grouped rupees without paise when whole ("₹1,50,000"), identical to Flutter's formatter. */
export function formatOriginationRupees(amount: number): string {
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** Plain-language effect of "Reverse & Delete" / "Reverse Loan Creation", shown before confirming. */
export function originationReversalMessage(movement: { kind: OriginationMovementKind; amount: number; accountName: string } | null): string {
  if (movement == null) return "This will reverse the creation of this agreement and move it to Trash. No account will change.";
  const amount = formatOriginationRupees(movement.amount);
  switch (movement.kind) {
    case "principalReceived":
      return `This will remove the original ${amount} received into ${movement.accountName} and reverse the loan creation.`;
    case "principalSent":
      return `This will restore ${amount} to ${movement.accountName} and reverse the amount lent.`;
    case "downPaymentPaid":
      return `This will restore the recorded ${amount} down payment to ${movement.accountName} and reverse the installment purchase.`;
  }
}
