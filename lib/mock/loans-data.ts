/** Realistic placeholder data only — no Firestore wiring yet. Shapes mirror the eventual real domain types
 *  (lib/models/loan.ts) loosely: lender, principal, interest terms, EMI amount, progress through the
 *  installment schedule, and the next due date. The primary loan (Home Loan) uses
 *  lib/engines/interest-calculator.ts to generate a real reducing-balance EMI schedule rather than faked
 *  numbers — see `homeLoanSchedule` below, computed once at module load and sliced for display. */

import { calculate, type InterestType } from "@/lib/engines/interest-calculator";

export interface MockLoan {
  id: string;
  name: string;
  lender: string;
  principal: number;
  interestType: InterestType;
  ratePercent: number;
  totalInstallments: number;
  installmentsPaid: number;
  emiAmount: number;
  nextDueDate: string;
  outstandingPrincipal: number;
  /** Accent token name — maps to an existing tone class, keeps each loan visually distinct without new colors. */
  accent: "primary" | "success" | "warning" | "purple" | "expense";
}

// Primary loan: a real 240-installment (20-year) reducing-balance amortization at 8.65% p.a.
// Truncated for realism to "as of" installment 42 (i.e. ~3.5 years in) for the summary fields below.
const HOME_LOAN_PRINCIPAL = 6_500_000;
const HOME_LOAN_RATE = 8.65;
const HOME_LOAN_TERM_MONTHS = 240;
const HOME_LOAN_INSTALLMENTS_PAID = 42;

export const homeLoanSchedule = calculate({
  principal: HOME_LOAN_PRINCIPAL,
  type: "reducingBalance",
  ratePercent: HOME_LOAN_RATE,
  period: "yearly",
  installmentCount: HOME_LOAN_TERM_MONTHS,
  installmentFrequency: "monthly",
});

const homeLoanEmi = homeLoanSchedule.periods[0]?.paymentAmount ?? 0;
const homeLoanOutstanding =
  homeLoanSchedule.periods[HOME_LOAN_INSTALLMENTS_PAID - 1]?.remainingPrincipal ?? HOME_LOAN_PRINCIPAL;

export const mockLoans: MockLoan[] = [
  {
    id: "loan-home",
    name: "Home Loan",
    lender: "HDFC Bank",
    principal: HOME_LOAN_PRINCIPAL,
    interestType: "reducingBalance",
    ratePercent: HOME_LOAN_RATE,
    totalInstallments: HOME_LOAN_TERM_MONTHS,
    installmentsPaid: HOME_LOAN_INSTALLMENTS_PAID,
    emiAmount: homeLoanEmi,
    nextDueDate: "2026-08-05",
    outstandingPrincipal: homeLoanOutstanding,
    accent: "primary",
  },
  {
    id: "loan-car",
    name: "Car Loan",
    lender: "SBI",
    principal: 950_000,
    interestType: "reducingBalance",
    ratePercent: 9.25,
    totalInstallments: 60,
    installmentsPaid: 18,
    emiAmount: 19850,
    nextDueDate: "2026-08-10",
    outstandingPrincipal: 641_200,
    accent: "warning",
  },
  {
    id: "loan-personal",
    name: "Personal Loan",
    lender: "ICICI Bank",
    principal: 300_000,
    interestType: "flat",
    ratePercent: 12,
    totalInstallments: 24,
    installmentsPaid: 9,
    emiAmount: 15250,
    nextDueDate: "2026-08-18",
    outstandingPrincipal: 168_500,
    accent: "expense",
  },
  {
    id: "loan-education",
    name: "Education Loan",
    lender: "Axis Bank",
    principal: 1_200_000,
    interestType: "reducingBalance",
    ratePercent: 8.9,
    totalInstallments: 84,
    installmentsPaid: 30,
    emiAmount: 18960,
    nextDueDate: "2026-08-22",
    outstandingPrincipal: 812_400,
    accent: "purple",
  },
];
