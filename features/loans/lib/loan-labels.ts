/**
 * Plain-language copy for every Loan money action, in one place so the detail dialog's buttons, each
 * action dialog's title, the Loan history list and the Transactions list all describe the same
 * operation with the same words. Pure — no React, no Firestore — so it's unit-testable here.
 *
 * Each label describes what the repository actually does:
 *  - "Pay Extra Principal" → `LoanAdvancePaymentRepository.record` with an overflow beyond the EMI(s)
 *    currently due (`principalPrepayment`) — lowers the remaining principal.
 *  - "Pay Multiple EMIs"   → `record` with `includeUpcomingInstallments: true`, capped at the scheduled
 *    total — fills the oldest unpaid installments in order. It is NOT a loan payoff/foreclosure: on an
 *    interest-bearing loan the scheduled total still includes future interest, so it was renamed from
 *    "Pay Off Remaining Balance".
 *  - "Borrow More" / "Lend More" → `recordAdditionalDisbursement` (`additionalDisbursement`) — raises
 *    the principal; wording follows the loan's direction.
 */

import { isOriginationTransactionId } from "@/lib/engines/loan-origination";
import type { LoanDirection } from "@/lib/models/loan";
import type { PaymentAllocationType } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";

export const PAY_EXTRA_PRINCIPAL = {
  label: "Pay Extra Principal",
  description: "Pay extra to reduce your remaining loan principal.",
} as const;

export const PAY_MULTIPLE_EMIS = {
  label: "Pay Multiple EMIs",
  description: "Make one payment toward multiple unpaid installments.",
} as const;

export function additionalAmountCopy(direction: LoanDirection): { label: string; description: string } {
  return direction === "given"
    ? { label: "Lend More", description: "Add more money given under this loan." }
    : { label: "Borrow More", description: "Add more money received under this loan." };
}

/** Whether money comes INTO the user's account for this loan operation — decided by the loan's
 *  direction, never by a generic transaction type. Mirrors the repository's own `isIncome` rules. */
export function isMoneyIn(direction: LoanDirection, operation: "payment" | "additionalAmount"): boolean {
  return operation === "payment" ? direction === "given" : direction === "taken";
}

/** Title for one Loan history entry (an installment payment or an additional-amount record). */
export function historyEntryTitle(
  entry: { kind: "payment"; allocationType: PaymentAllocationType; partial: boolean } | { kind: "additionalAmount" },
  direction: LoanDirection,
): string {
  if (entry.kind === "additionalAmount") return direction === "given" ? "Lent more" : "Borrowed more";
  switch (entry.allocationType) {
    case "principalPrepayment":
      return "Extra principal payment";
    case "advanceEmi":
      return "Advance EMI";
    case "additionalDisbursement":
      return direction === "given" ? "Lent more" : "Borrowed more";
    default:
      return entry.partial ? "Partial EMI" : "EMI payment";
  }
}

/**
 * The name the Transactions list shows for a Loan-generated Transaction, built from its persisted
 * `loanId`/`paymentAllocationType` metadata. Returns null for anything that isn't Loan-generated, so
 * the caller keeps showing the stored description. A partial EMI can't be told apart from a full one
 * using the Transaction alone (that lives on the InstallmentPayment), so both read as the EMI label.
 */
export function loanTransactionLabel(
  transaction: Pick<Transaction, "loanId" | "paymentAllocationType" | "type"> & { id?: string },
  loan: { name?: string | null; direction: LoanDirection } | null,
): string | null {
  if (transaction.loanId == null) return null;
  // The origination movement (`createAgreementWithOrigination`) — recognised by its deterministic id.
  if (transaction.id != null && isOriginationTransactionId(transaction.id)) {
    const base = transaction.paymentAllocationType == null
      ? "Down Payment"
      : transaction.type === "income" ? "Loan Received" : "Money Lent";
    const name = loan?.name?.trim();
    return name ? `${base} — ${name}` : base;
  }
  if (transaction.paymentAllocationType == null) return null;
  // The repository writes additional amounts as income for a borrowed loan and expense for a lent
  // one, so the stored type is a safe fallback when the loan itself is gone (e.g. purged).
  const direction: LoanDirection = loan?.direction ?? (transaction.paymentAllocationType === "additionalDisbursement"
    ? (transaction.type === "income" ? "taken" : "given")
    : (transaction.type === "income" ? "given" : "taken"));
  const base = (() => {
    switch (transaction.paymentAllocationType) {
      case "principalPrepayment":
        return "Extra Principal Payment";
      case "advanceEmi":
        return direction === "given" ? "Advance Repayment Received" : "Advance EMI";
      case "additionalDisbursement":
        return direction === "given" ? "Lent More" : "Borrowed More";
      default:
        return direction === "given" ? "Loan Repayment Received" : "Loan EMI";
    }
  })();
  const name = loan?.name?.trim();
  return name ? `${base} — ${name}` : base;
}
