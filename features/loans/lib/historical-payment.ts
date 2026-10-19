/**
 * How an "Already paid earlier" Loan/EMI payment is recognised and worded wherever it is shown.
 *
 * Such a payment settles the schedule but never moves an account (`lib/engines/recorded-earlier.ts`): its
 * Loan Transaction is posted excluded from every total and balance. In a list it must therefore not read as
 * money leaving an account. The amount is still shown — it is a real payment — but muted and labelled.
 *
 * RECOGNITION. The structured fact is `InstallmentPayment.recordedEarlier` on the payment document the
 * Transaction points at (`installmentPaymentId`). The Transaction itself carries no such flag, so lists resolve it
 * with a direct read of that one document (`useHistoricalPaymentFlags`) for the few candidates that could be
 * historical. The description text ("(already paid earlier)") is NEVER the answer once the structured read has
 * come back — it is only a provisional hint while that read is in flight or unavailable, so an edited or
 * look-alike description can neither remove nor fake the label. Date alone is never used.
 */

import { RECORDED_EARLIER_DESCRIPTION_SUFFIX } from "@/lib/engines/recorded-earlier";
import type { Transaction } from "@/lib/models/transaction";

export const HISTORICAL_PAYMENT_LABEL = "Already paid earlier";

/** Short badge / amount-caption text. */
export const HISTORICAL_PAYMENT_SHORT = "No account debit";

/** The full explanation (tooltips, accessible names). `received` = a Loan I gave: the repayment is not credited again. */
export function historicalPaymentExplanation(received = false): string {
  return received
    ? "Received before FlowFi — already in your balance. No new account credit was recorded."
    : "Paid before FlowFi — already in your balance. No new account debit was recorded.";
}

type PaymentTxn = Pick<Transaction, "loanId" | "excludeFromCalculations" | "installmentId" | "installmentPaymentId" | "description">;

/**
 * Could this Transaction be a historical Loan payment? Necessary conditions only: a Loan payment (it names the
 * installment payment it settled) that is excluded from calculations. Whether it IS historical is the structured
 * flag on that payment document. (An EMI paid earlier posts no Transaction at all.)
 */
export function isHistoricalPaymentCandidate(t: PaymentTxn): boolean {
  return t.loanId != null && t.excludeFromCalculations === true && t.installmentId != null && t.installmentPaymentId != null;
}

/** The write path's description marker — a provisional hint ONLY (see the module comment). */
export function descriptionSaysHistorical(t: Pick<Transaction, "description">): boolean {
  return t.description.endsWith(RECORDED_EARLIER_DESCRIPTION_SUFFIX);
}

/**
 * The answer shown in the UI. `structured` is the payment document's flag: true/false once read, `undefined` while
 * it hasn't (or couldn't) be read. A non-candidate is never historical.
 */
export function resolveHistoricalPayment(t: PaymentTxn, structured: boolean | undefined): boolean {
  if (!isHistoricalPaymentCandidate(t)) return false;
  return structured ?? descriptionSaysHistorical(t);
}
