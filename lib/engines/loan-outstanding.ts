/**
 * Canonical "how much principal is still outstanding on a loan" formula —
 * shared by `LoanRepository.editLoanTerms` (which needs it to re-amortize
 * the unpaid tail) and `use-loans-data.ts`'s `toLoanRow` (which needs it to
 * display "Outstanding"/"Loan Amount Left"). No UI or Firestore dependency.
 *
 * Extracted after an audit finding: `toLoanRow` used to reimplement this
 * formula itself, but credited a partially-paid installment's WHOLE
 * principal share the moment any amount was paid, instead of prorating by
 * `amountPaid / amountDue` like `editLoanTerms` always did. The two
 * implementations disagreed on-screen for the same loan whenever an
 * installment was only partially paid (`LoanScheduleDialog` showed
 * "Outstanding" and "Loan Amount Left" as two different numbers). There is
 * now exactly one implementation.
 */

/** Minimal installment shape this formula needs. */
export interface OutstandingInstallment {
  amountDue: number;
  amountPaid: number;
  isSkipped: boolean;
  /** Null for non-interest-bearing loans — the whole `amountDue` is then principal. */
  principalPortion: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Sum of principal already paid off across `installments`. An installment
 * counts once any amount has been paid toward it or it's been skipped; a
 * fully-paid installment counts its whole principal share, a partially-paid
 * one counts only the prorated fraction of what was actually paid.
 */
export function principalPaidFor(installments: OutstandingInstallment[]): number {
  return installments.reduce((sum, i) => {
    if (i.amountPaid <= 0) return sum;
    const principalShare = i.principalPortion ?? i.amountDue;
    if (i.amountPaid >= i.amountDue) return sum + principalShare;
    return sum + principalShare * (i.amountPaid / i.amountDue);
  }, 0);
}

/** `loanAmount` minus principal already paid off, clamped to `[0, loanAmount]`. */
export function outstandingPrincipalFor(loanAmount: number, installments: OutstandingInstallment[]): number {
  return clamp(loanAmount - principalPaidFor(installments), 0, loanAmount);
}
