/** Test fixtures shared by the Debt Planner engine tests — realistic, deterministic records. */

import type { Installment } from "@/lib/models/payment-schedule";
import { calculate } from "@/lib/engines/interest-calculator";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import type { CardFacilityInput, EmiDebtInput, LoanDebtInput, PersonDebtInput } from "@/lib/engines/debt-position";

/** 1 Oct 2026, mid-morning — "today" for every test. */
export const NOW = new Date(2026, 9, 1, 10, 0, 0);

export function monthly(start: Date, i: number): Date {
  return new Date(start.getFullYear(), start.getMonth() + i, start.getDate());
}

export function installment(scheduleId: string, seq: number, dueDate: Date, amountDue: number, amountPaid = 0, principalPortion: number | null = null, interestPortion: number | null = null): Installment {
  return {
    id: `${scheduleId}-i${seq}`,
    scheduleId,
    ownerType: "loan",
    ownerId: scheduleId,
    sequenceNumber: seq,
    dueDate,
    amountDue,
    amountPaid,
    isSkipped: false,
    principalPortion,
    interestPortion,
    createdAt: NOW,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

/** An even no-interest schedule; the first `paidCount` installments fully paid. */
export function flatSchedule(scheduleId: string, total: number, count: number, firstDue: Date, paidCount = 0): Installment[] {
  const share = total / count;
  return Array.from({ length: count }, (_, i) => installment(scheduleId, i + 1, monthly(firstDue, i), share, i < paidCount ? share : 0));
}

/** A reducing-balance schedule from the app's own `calculate`, first `paidCount` paid. */
export function amortizedSchedule(scheduleId: string, principal: number, ratePercent: number, count: number, firstDue: Date, paidCount = 0): Installment[] {
  const breakdown = calculate({ principal, type: "reducingBalance", ratePercent, period: "yearly", installmentCount: count, installmentFrequency: "monthly" });
  return breakdown.periods.map((p, i) =>
    installment(scheduleId, i + 1, monthly(firstDue, i), p.paymentAmount, i < paidCount ? p.paymentAmount : 0, p.principalPortion, p.interestPortion),
  );
}

export function loanInput(overrides: Partial<LoanDebtInput> & { id: string; installments: Installment[] }): LoanDebtInput {
  const loanAmount = overrides.loanAmount ?? 25000;
  return {
    name: overrides.id,
    lenderName: "Bank",
    direction: "taken",
    category: "institutional",
    personId: null,
    isClosed: false,
    loanAmount,
    interest: null,
    repaymentType: "installment",
    installmentFrequency: "monthly",
    outstandingPrincipal: outstandingPrincipalFor(loanAmount, overrides.installments),
    ownedByCardId: null,
    purchaseRepresented: false,
    ...overrides,
  };
}

export function emiInput(overrides: Partial<EmiDebtInput> & { id: string; installments: Installment[]; principalAmount: number }): EmiDebtInput {
  return {
    name: overrides.id,
    lenderName: "Store finance",
    isClosed: false,
    isDefaulted: false,
    interest: null,
    installmentFrequency: "monthly",
    outstandingPrincipal: outstandingPrincipalFor(overrides.principalAmount, overrides.installments),
    ownedByCardId: null,
    purchaseRepresented: false,
    ...overrides,
  };
}

export function cardInput(overrides: Partial<CardFacilityInput> & { id: string }): CardFacilityInput {
  return {
    name: "HDFC Card",
    cardIds: [overrides.id],
    outstanding: 0,
    lockedEmiPrincipal: 0,
    creditLimit: 50000,
    available: 50000,
    utilizationPercent: 0,
    statements: [],
    minimumDuePercent: null,
    statedInterestRatePercent: null,
    ...overrides,
  };
}

export function personInput(overrides: Partial<PersonDebtInput> & { personId: string }): PersonDebtInput {
  return { name: overrides.personId, directBalance: 0, emiReceivable: 0, loanReceivable: 0, loanPayable: 0, ...overrides };
}
