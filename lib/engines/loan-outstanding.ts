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

/** Minimal payment shape for `principalPrepaidFor`. */
export interface PrepaymentRecord {
  allocationType: string;
  /** The principal-only portion of an extra-principal payment (the overflow beyond the EMIs due). */
  prepaymentPrincipalAmount: number | null;
  amount: number;
  deletedAt: Date | null;
}

/**
 * Total extra principal paid on a loan, derived from its persisted `InstallmentPayment` records —
 * never a stored running total (so a reversal, which soft-deletes the record, or a retry, which
 * never writes a second record, can't leave it out of sync). `payments` must be every payment under
 * the loan's schedule, INCLUDING payments under installments a re-plan has since retired: the
 * extra-principal record is written under the schedule's last installment, which that same re-plan
 * usually retires. Mirrors Flutter's `principalPrepaidFor`.
 */
export function principalPrepaidFor(payments: PrepaymentRecord[]): number {
  return payments.reduce((sum, p) => {
    if (p.deletedAt != null || p.allocationType !== "principalPrepayment") return sum;
    return sum + (p.prepaymentPrincipalAmount ?? p.amount);
  }, 0);
}

/**
 * Outstanding principal including extra-principal payments — the canonical figure for display,
 * re-plans, Reports and Net Worth. `principalPrepaid` comes from `principalPrepaidFor`.
 */
export function outstandingPrincipalAfterPrepaymentsFor(
  loanAmount: number,
  installments: OutstandingInstallment[],
  principalPrepaid: number,
): number {
  return clamp(loanAmount - principalPaidFor(installments) - principalPrepaid, 0, loanAmount);
}
