/**
 * Reports / Analytics audit scenarios (2026-11-24). Every expectation is hand-computed from the raw records below.
 * Focus: things a "Paid towards debts" style total can count twice (card EMIs vs the card bill that settles them),
 * money lent (loan given) vs money borrowed, and the Analytics focus-period helper for custom ranges.
 */

import { describe, expect, it } from "vitest";
import { mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { buildPeriodReportSources, periodFigures } from "@/lib/engines/period-report";
import { resolveReportPeriod, trendPeriods } from "@/lib/engines/report-period";
import type { LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import type { Emi } from "@/lib/models/emi";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { focusedPointIndex } from "@/features/analytics/lib/focus-point";

const NOW = new Date(2026, 10, 19, 12);
const BANK = "bank";
const CARD = "card";
const d = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour);

const tx = (p: Partial<Transaction> & { id: string }): Transaction => ({
  ...TransactionRepository.buildTransaction({ type: p.type ?? "expense", amount: p.amount ?? 0, dateTime: p.dateTime ?? NOW, accountId: p.accountId ?? BANK, categoryId: p.categoryId ?? "misc" }),
  ...p,
});

function sourcesFor(transactions: Transaction[], extra: { emis?: Emi[]; emiPayments?: { scheduleId: string; date: Date; amount: number; recordedEarlier: boolean; transactionId?: string | null }[]; loanPayments?: LoanScheduledPayment[] } = {}) {
  return buildPeriodReportSources({
    transactions,
    spendTransactions: transactions,
    mySpendCtx: mySpendContextFromRecords({ transactions, expenses: [], loans: [{ id: "L1", agreementKind: "loan" }], emis: [{ id: "E1", purchaseTransactionId: null }] }),
    creditCards: [{ id: "cc", accountId: CARD }],
    emis: extra.emis ?? [],
    expenses: [],
    emiPayments: extra.emiPayments ?? [],
    loanPayments: extra.loanPayments ?? [],
    installmentsByScheduleId: {},
    accounts: [
      { id: BANK, currentBalance: 0 },
      { id: CARD, currentBalance: 0 },
    ],
  });
}

const november = resolveReportPeriod({ kind: "month", year: 2026, month: 10 }, 1, NOW);

describe("card-linked EMI is settled by the card bill — never two 'paid' amounts for one rupee", () => {
  // Card EMI (Case B, charged to the card): installment 2,500 posts a card expense; the bill payment (bank → card) is 2,500.
  const emi = { id: "E1", scheduleId: "S-E1", linkedCreditCardId: "cc", purchaseTransactionId: null, deletedAt: null } as unknown as Emi;
  const transactions = [
    tx({ id: "emi-on-card", amount: 2_500, dateTime: d(10, 5), accountId: CARD, emiId: "E1", paymentAllocationType: "regularEmi" }),
    tx({ id: "bill-out", amount: 2_500, dateTime: d(10, 10), transferId: "T1" }),
    tx({ id: "bill-in", type: "income", amount: 2_500, dateTime: d(10, 10), accountId: CARD, transferId: "T1" }),
  ];
  const sources = sourcesFor(transactions, { emis: [emi], emiPayments: [{ scheduleId: "S-E1", date: d(10, 5), amount: 2_500, recordedEarlier: false, transactionId: "emi-on-card" }] });
  const f = periodFigures(sources, november);

  it("cash basis: only the bill payment leaves the bank", () => {
    expect(f.cash.moneyOut).toBe(2_500);
    expect(f.cash.creditCardPayments).toBe(2_500);
  });
  it("Month Cycle outflow counts the EMI once", () => {
    expect(f.outflow).toBe(2_500);
  });
  it("paid towards debts = 2,500 (the card bill), not 5,000", () => {
    expect(f.debt.paidTowardsDebts).toBe(2_500);
  });
  it("the EMI installment is still reported (informational) and split out as card-settled", () => {
    expect(f.debt.emiPaid).toBe(2_500);
    expect(f.debt.emiPaidOnCard).toBe(2_500);
  });
});

describe("a plain bank-paid EMI is NOT card-settled", () => {
  const emi = { id: "E2", scheduleId: "S-E2", linkedCreditCardId: null, purchaseTransactionId: null, deletedAt: null } as unknown as Emi;
  const sources = sourcesFor([tx({ id: "p", amount: 1_000, dateTime: d(10, 5), emiId: "E2" })], { emis: [emi], emiPayments: [{ scheduleId: "S-E2", date: d(10, 5), amount: 1_000, recordedEarlier: false }] });
  const f = periodFigures(sources, november);
  it("counts once in paid towards debts", () => {
    expect(f.debt.emiPaidOnCard).toBe(0);
    expect(f.debt.paidTowardsDebts).toBe(1_000);
  });
});

describe("loan repayment charged to a card is settled by the card bill too", () => {
  const transactions = [
    tx({ id: "loanpay-card", amount: 1_200, dateTime: d(10, 5), accountId: CARD, loanId: "L1", paymentAllocationType: "regularEmi" }),
    tx({ id: "bill-out", amount: 1_200, dateTime: d(10, 10), transferId: "T1" }),
    tx({ id: "bill-in", type: "income", amount: 1_200, dateTime: d(10, 10), accountId: CARD, transferId: "T1" }),
  ];
  const loanPayments: LoanScheduledPayment[] = [{ direction: "taken", installmentDueDate: d(10, 5), amount: 1_200, date: d(10, 5), transactionId: "loanpay-card", deletedAt: null }];
  const f = periodFigures(sourcesFor(transactions, { loanPayments }), november);
  it("not counted twice", () => {
    expect(f.debt.loanRepaid).toBe(1_200);
    expect(f.debt.paidTowardsDebts).toBe(1_200);
  });
});

describe("money lent (loan given) is not income or spending; collected repayments are not income", () => {
  const transactions = [
    tx({ id: "salary", type: "income", amount: 10_000, dateTime: d(10, 1), categoryId: "salary" }),
    tx({ id: "lend", amount: 3_000, dateTime: d(10, 2), loanId: "L9", paymentAllocationType: "additionalDisbursement" }),
    tx({ id: "collect", type: "income", amount: 1_000, dateTime: d(10, 20), loanId: "L9", paymentAllocationType: "regularEmi" }),
  ];
  const loanPayments: LoanScheduledPayment[] = [{ direction: "given", installmentDueDate: d(10, 20), amount: 1_000, date: d(10, 20), transactionId: "collect", deletedAt: null }];
  const f = periodFigures(sourcesFor(transactions, { loanPayments }), november);
  // Mirrors the Month Cycle rule (shared engine, read-only): a repayment I COLLECT is an income-type row and is counted;
  // the lent principal itself is a disbursement and never is. Reported, not changed here.
  it("income = salary + the collected repayment (Month Cycle rule); the lent 3,000 is never income", () => expect(f.income).toBe(11_000));
  it("outflow and my spend ignore the lent principal", () => {
    expect(f.outflow).toBe(0);
    expect(f.mySpend).toBe(0);
  });
  it("cash basis (Dashboard rule): principal disbursements never count; the collection is money in", () => {
    expect(f.cash.moneyIn).toBe(11_000);
    expect(f.cash.moneyOut).toBe(0);
  });
  it("collected repayment is reported as collected, not repaid", () => {
    expect(f.debt.loanCollected).toBe(1_000);
    expect(f.debt.loanRepaid).toBe(0);
    expect(f.debt.paidTowardsDebts).toBe(0);
  });
});

describe("focusedPointIndex — the window point that IS the focused period", () => {
  const points = trendPeriods(november, 1, 6, NOW).map((period) => ({ period }));
  it("finds a calendar month inside its window", () => {
    expect(focusedPointIndex(points, november)).toBe(5);
  });
  it("a custom range is NOT any of the month points → -1 (never silently the first month)", () => {
    const range = resolveReportPeriod({ kind: "range", start: d(10, 3), end: d(10, 9) }, 1, NOW);
    expect(focusedPointIndex(points, range)).toBe(-1);
  });
});
