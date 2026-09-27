/**
 * Pure planning for the unified Record Payment surface — which quick choices to offer and the exact
 * params each one sends to the EXISTING operations. No money is computed here beyond summing
 * installments' `remainingAmount`; allocation, prepayment and re-amortization stay in the repositories.
 *
 * Loan → `useLoanActions().recordPayment` (`LoanAdvancePaymentRepository.record`, one atomic call):
 *   - it fills the installments *currently due* on the payment date (overdue, else the next one) first;
 *   - `includeUpcomingInstallments: true` lets it keep filling upcoming installments in order;
 *   - whatever is still left becomes a principal prepayment (reduce-tenure re-amortization);
 *   - one-time loans refuse anything above what is owed.
 * EMI  → `useEmiActions().recordPayment` — one installment per payment (partial allowed, never above
 *   that installment's remaining amount); a card-linked EMI's principal share restores card credit
 *   through the existing breakdown split.
 */

import { previewPrincipalPrepayment } from "@/features/loans/lib/loan-adjustment-preview";
import type { Loan } from "@/lib/models/loan";
import { remainingAmount, type Installment, type PaymentAllocationType } from "@/lib/models/payment-schedule";

export type PayChoice = "installment" | "allDue" | "remaining" | "custom";
/** What a loan payment above the currently-due amount does — both are existing repository behaviours. */
export type ExtraTreatment = "reducePrincipal" | "payUpcoming";

export interface QuickOption {
  choice: Exclude<PayChoice, "custom">;
  label: string;
  hint: string;
  amount: number;
}

/** Installments a payment can still go to, in schedule order — same filter the repository applies. */
export function payableInstallments(installments: Installment[]): Installment[] {
  return installments
    .filter((i) => i.deletedAt == null && !i.isSkipped && remainingAmount(i) > 0)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

export function totalRemainingOf(installments: Installment[]): number {
  return payableInstallments(installments).reduce((sum, i) => sum + remainingAmount(i), 0);
}

/** A yyyy-mm-dd payment date as local noon — the convention the Loan adjustment flow already uses. */
export function paymentDateFrom(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface LoanPaymentFigures {
  next: Installment | null;
  /** What `record()` fills before anything counts as extra: installments due on `date`, else the next one. */
  dueAmount: number;
  dueCount: number;
  totalRemaining: number;
  payableCount: number;
}

export function loanPaymentFigures(loan: Loan, installments: Installment[], date: Date): LoanPaymentFigures {
  const payable = payableInstallments(installments);
  if (payable.length === 0) return { next: null, dueAmount: 0, dueCount: 0, totalRemaining: 0, payableCount: 0 };
  const dueCount = payable.filter((i) => i.dueDate.getTime() <= date.getTime()).length || 1;
  return {
    next: payable[0],
    // The existing preview reproduces the repository's own "currently due" scope.
    dueAmount: previewPrincipalPrepayment(loan, installments, 0, date).scheduledAmount,
    dueCount,
    totalRemaining: payable.reduce((sum, i) => sum + remainingAmount(i), 0),
    payableCount: payable.length,
  };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

export function loanQuickOptions(loan: Loan, figures: LoanPaymentFigures): QuickOption[] {
  const { next } = figures;
  if (next == null) return [];
  const options: QuickOption[] = [
    { choice: "installment", label: "Pay installment", hint: `#${next.sequenceNumber}`, amount: remainingAmount(next) },
  ];
  if (figures.dueCount > 1 && !near(figures.dueAmount, options[0].amount)) {
    options.push({ choice: "allDue", label: "Pay everything due", hint: `${figures.dueCount} installments`, amount: figures.dueAmount });
  }
  const largest = Math.max(...options.map((o) => o.amount));
  if (loan.repaymentType !== "oneTime" && figures.totalRemaining > largest + 0.5) {
    options.push({
      choice: "remaining",
      label: "Pay all remaining",
      hint: `${figures.payableCount} installments${loan.interest && loan.interest.ratePercent > 0 ? " · incl. scheduled interest" : ""}`,
      amount: figures.totalRemaining,
    });
  }
  return options;
}

export type LoanPaymentPlan =
  | { ok: true; amount: number; includeUpcomingInstallments: boolean; extra: number }
  | { ok: false; error: string };

export function planLoanPayment(input: {
  loan: Loan;
  figures: LoanPaymentFigures;
  choice: PayChoice;
  customAmount: string;
  treatment: ExtraTreatment;
}): LoanPaymentPlan {
  const { loan, figures, choice } = input;
  if (figures.next == null) return { ok: false, error: "Nothing is left to pay on this loan." };
  if (choice !== "custom") {
    const option = loanQuickOptions(loan, figures).find((o) => o.choice === choice);
    if (!option) return { ok: false, error: "Choose how much to pay." };
    return { ok: true, amount: option.amount, includeUpcomingInstallments: choice === "remaining", extra: 0 };
  }
  const amount = Number(input.customAmount);
  if (input.customAmount.trim() === "" || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than 0." };
  if (loan.repaymentType === "oneTime" && amount > figures.totalRemaining + 1e-9) {
    return { ok: false, error: `This loan is repaid in one payment — the most you can pay is ₹${figures.totalRemaining.toLocaleString("en-IN")}.` };
  }
  const extra = Math.max(0, amount - figures.dueAmount);
  return { ok: true, amount, includeUpcomingInstallments: extra > 0 && input.treatment === "payUpcoming", extra };
}

/** Success copy from the repository's own classification of what the payment turned out to be. */
export function loanPaymentSuccessTitle(type: PaymentAllocationType): string {
  switch (type) {
    case "principalPrepayment":
      return "Extra principal payment recorded successfully";
    case "advanceEmi":
      return "Advance payment recorded successfully";
    default:
      return "Payment recorded successfully";
  }
}

export type EmiPaymentPlan = { ok: true; amount: number } | { ok: false; error: string };

export function emiQuickOptions(next: Installment | null): QuickOption[] {
  return next ? [{ choice: "installment", label: "Pay installment", hint: `#${next.sequenceNumber}`, amount: remainingAmount(next) }] : [];
}

export function planEmiPayment(next: Installment | null, choice: PayChoice, customAmount: string): EmiPaymentPlan {
  if (next == null) return { ok: false, error: "Nothing is left to pay on this EMI." };
  const owed = remainingAmount(next);
  if (choice !== "custom") return { ok: true, amount: owed };
  const amount = Number(customAmount);
  if (customAmount.trim() === "" || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than 0." };
  if (amount > owed + 1e-9) {
    return { ok: false, error: `EMI payments apply to one installment at a time — the most you can pay now is ₹${owed.toLocaleString("en-IN")}.` };
  }
  return { ok: true, amount };
}
