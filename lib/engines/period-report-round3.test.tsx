// @vitest-environment jsdom
/**
 * Reports / Analytics round-3 (2026-11-24): earned income vs recovered principal, EMI payment date vs bank-leg date,
 * the actual values reaching the Analytics KPI tiles, and CSV parity. Expected values are hand-computed.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KpiStrip } from "@/features/analytics/components/analytics-charts";
import { loanCollectionPrincipalByTransaction } from "@/features/reports/lib/loan-collection-principal";
import { periodReportCsv } from "@/features/reports/lib/report-csv";
import { mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { buildPeriodReportSources, periodDetail, periodFigures } from "@/lib/engines/period-report";
import { resolveReportPeriod } from "@/lib/engines/report-period";
import type { LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import type { Emi } from "@/lib/models/emi";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

afterEach(cleanup);

const NOW = new Date(2026, 10, 24, 12);
const BANK = "bank";
const CARD = "card";
const d = (m: number, day: number, h = 12) => new Date(2026, m, day, h);
const tx = (p: Partial<Transaction> & { id: string }): Transaction => ({
  ...TransactionRepository.buildTransaction({ type: p.type ?? "expense", amount: p.amount ?? 0, dateTime: p.dateTime ?? NOW, accountId: p.accountId ?? BANK, categoryId: p.categoryId ?? "misc" }),
  ...p,
});
const cardEmi = { id: "E1", scheduleId: "S1", linkedCreditCardId: "cc", purchaseTransactionId: null, deletedAt: null } as unknown as Emi;
const build = (transactions: Transaction[], o: { emis?: Emi[]; emiPayments?: { scheduleId: string; date: Date; amount: number; recordedEarlier: boolean }[]; loanPayments?: LoanScheduledPayment[]; principal?: Map<string, { principal: number; total: number }> } = {}) =>
  buildPeriodReportSources({
    transactions,
    spendTransactions: transactions,
    mySpendCtx: mySpendContextFromRecords({ transactions, expenses: [], loans: [{ id: "L9", agreementKind: "loan" }], emis: [{ id: "E1", purchaseTransactionId: null }] }),
    creditCards: [{ id: "cc", accountId: CARD }],
    emis: o.emis ?? [],
    expenses: [],
    emiPayments: o.emiPayments ?? [],
    loanPayments: o.loanPayments ?? [],
    installmentsByScheduleId: {},
    accounts: [{ id: BANK, currentBalance: 0 }, { id: CARD, currentBalance: 0 }],
    loanCollectionPrincipal: o.principal,
  });
const month = (m: number) => resolveReportPeriod({ kind: "month", year: 2026, month: m }, 1, NOW);
const nov = month(10);

describe("earned income vs principal recovered (loan I lent)", () => {
  const salary = tx({ id: "sal", type: "income", amount: 5_000, dateTime: d(10, 1), categoryId: "salary" });
  const lend = tx({ id: "lend", amount: 10_000, dateTime: d(10, 2), loanId: "L9", paymentAllocationType: "additionalDisbursement" });
  const back = (amt: number) => tx({ id: "back", type: "income", amount: amt, dateTime: d(10, 20), loanId: "L9", paymentAllocationType: "regularEmi" });

  it("₹2,000 collected, no interest: income 7,000 (Month Cycle) = earned 5,000 + principal recovered 2,000", () => {
    const f = periodFigures(build([salary, lend, back(2_000)], { principal: new Map([["back", { principal: 2_000, total: 2_000 }]]) }), nov);
    expect([f.income, f.principalRecovered, f.earnedIncome]).toEqual([7_000, 2_000, 5_000]);
    expect(f.net).toBe(7_000); // Month Cycle meaning unchanged
  });
  it("₹2,200 collected of which principal 2,000: earned = 5,000 + 200 interest", () => {
    const f = periodFigures(build([salary, lend, back(2_200)], { principal: new Map([["back", { principal: 2_000, total: 2_200 }]]) }), nov);
    expect([f.income, f.principalRecovered, f.earnedIncome]).toEqual([7_200, 2_000, 5_200]);
  });
  it("only the lent loan's collections: a salary, a refund-free month has no principal recovered", () => {
    const f = periodFigures(build([salary]), nov);
    expect([f.principalRecovered, f.earnedIncome, f.loanCollectionUnclassified]).toEqual([0, 5_000, 0]);
  });
  it("a collection outside the period is not in this period's principal recovered", () => {
    const sp = { principal: new Map([["back", { principal: 2_000, total: 2_000 }]]) };
    const f = periodFigures(build([salary, { ...back(2_000), dateTime: d(9, 20) }], sp), nov);
    expect([f.income, f.principalRecovered]).toEqual([5_000, 0]);
    expect(periodFigures(build([salary, { ...back(2_000), dateTime: d(9, 20) }], sp), month(9)).principalRecovered).toBe(2_000);
  });
  it("principal is split by the balance sheet's own rule: installment 1,200 = 1,000 principal + 200 interest", () => {
    const inst = { id: "i1", scheduleId: "SL", amountDue: 1_200, principalPortion: 1_000, deletedAt: null };
    const pay = (id: string, day: number, amount: number): LoanScheduledPayment => ({ direction: "given", installmentDueDate: d(10, 20), amount, date: d(10, day), transactionId: id, deletedAt: null, installmentId: "i1", scheduleId: "SL", paymentId: id, allocationType: "regularEmi" });
    const one = loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [inst], loanPayments: [pay("a", 20, 1_200)] });
    expect(one.get("a")).toEqual({ principal: 1_000, total: 1_200 });
    const two = loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [inst], loanPayments: [pay("a", 10, 600), pay("b", 20, 600)] });
    expect([two.get("a")?.principal, two.get("b")?.principal]).toEqual([500, 500]);
    // a loan I BORROWED is never a collection
    expect(loanCollectionPrincipalByTransaction({ givenScheduleIds: [], installments: [inst], loanPayments: [pay("a", 20, 1_200)] }).size).toBe(0);
  });
  it("CSV shows income, principal recovered and earned income with the same numbers", () => {
    const det = periodDetail(build([salary, lend, back(2_000)], { principal: new Map([["back", { principal: 2_000, total: 2_000 }]]) }), nov);
    const csv = periodReportCsv({ detail: det, accountName: (i) => i, categoryName: (i) => i });
    const row = (label: string) => csv.split("\n").find((l) => l.includes(label))!;
    expect(row("Income,")).toContain(",7000,");
    expect(row("principal recovered")).toContain(",2000,");
    expect(row("earned income")).toContain(",5000,");
  });
});

describe("EMI payment date vs bank-side leg date (card EMI, installment 1,000 = principal 900 + interest 100)", () => {
  // Installment recorded 31 Oct; the 900 principal is a bank → card transfer on 31 Oct; the 100 interest bank expense posts 1 Nov.
  const txs = [
    tx({ id: "pri-o", amount: 900, dateTime: d(9, 31), transferId: "X", emiId: "E1" }),
    tx({ id: "pri-i", type: "income", amount: 900, dateTime: d(9, 31), accountId: CARD, transferId: "X", emiId: "E1" }),
    tx({ id: "int", amount: 100, dateTime: d(10, 1), emiId: "E1", paymentAllocationType: "regularEmi" }),
  ];
  const src = build(txs, { emis: [cardEmi], emiPayments: [{ scheduleId: "S1", date: d(9, 31), amount: 1_000, recordedEarlier: false }] });
  const oct = periodFigures(src, month(9));
  const novF = periodFigures(src, nov);

  it("October: the 900 principal transfer is the card payment; the interest has not moved yet → paid 900", () => {
    expect(oct.debt.cardBillPayments).toBe(900);
    expect(oct.debt.paidTowardsDebts).toBe(900);
  });
  it("November: the 100 interest is counted in November, once → paid 100", () => {
    expect(novF.debt.emiPaidDirect).toBe(100);
    expect(novF.debt.paidTowardsDebts).toBe(100);
  });
  it("across both months the 1,000 is counted exactly once (900 + 100) — nothing lost, nothing doubled", () => {
    expect(oct.debt.paidTowardsDebts + novF.debt.paidTowardsDebts).toBe(1_000);
  });
  it("Month Cycle outflow counts the installment once, on its payment date (Oct 1,000 / Nov 0) — unchanged shared rule", () => {
    expect([oct.outflow, novF.outflow]).toEqual([1_000, 0]);
  });
  it("cash basis follows the actual cash dates: Oct out 900, Nov out 100", () => {
    expect([oct.cash.moneyOut, novF.cash.moneyOut]).toEqual([900, 100]);
  });
  it("one two-month range sees everything once: paid 1,000, outflow 1,000, cash out 1,000", () => {
    const f = periodFigures(src, resolveReportPeriod({ kind: "range", start: d(9, 1), end: d(10, 30) }, 1, NOW));
    expect([f.debt.paidTowardsDebts, f.outflow, f.cash.moneyOut]).toEqual([1_000, 1_000, 1_000]);
  });
});

describe("Scenarios A/B/C stay correct with the date-aware rule", () => {
  const emiPay = [{ scheduleId: "S1", date: d(10, 5), amount: 1_000, recordedEarlier: false }];
  const bill = (amt: number) => [tx({ id: "b-o", amount: amt, dateTime: d(10, 10), transferId: "B" }), tx({ id: "b-i", type: "income", amount: amt, dateTime: d(10, 10), accountId: CARD, transferId: "B" })];
  it("A: bill 7,000 + interest 100 = 7,100", () => {
    expect(periodFigures(build([...bill(7_000), tx({ id: "i", amount: 100, dateTime: d(10, 5), emiId: "E1" })], { emis: [cardEmi], emiPayments: emiPay }), nov).debt.paidTowardsDebts).toBe(7_100);
  });
  it("B: whole installment from bank = 1,000 once", () => {
    expect(periodFigures(build([tx({ id: "i", amount: 1_000, dateTime: d(10, 5), emiId: "E1" })], { emis: [cardEmi], emiPayments: emiPay }), nov).debt.paidTowardsDebts).toBe(1_000);
  });
  it("C: charged to card 1,000 then bill 1,000 = 1,000 (not 2,000)", () => {
    expect(periodFigures(build([tx({ id: "i", amount: 1_000, accountId: CARD, dateTime: d(10, 5), emiId: "E1" }), ...bill(1_000)], { emis: [cardEmi], emiPayments: emiPay }), nov).debt.paidTowardsDebts).toBe(1_000);
  });
});

describe("values reaching the Analytics KPI tiles", () => {
  const figures = (income: number, outflow: number) => ({ income, outflow, mySpend: outflow, net: income - outflow, savingsRate: income > 0 ? ((income - outflow) / income) * 100 : null, principalRecovered: 0, earnedIncome: income }) as never;
  const pts = [10, 20, 30].map((v, i) => ({ period: { start: new Date(2026, 8 + i, 1), isCurrent: false } as never, figures: figures(v * 100, v * 10) }));

  it("custom range (focusIndex −1): tiles show the range's own figures, not the first month's", () => {
    render(<KpiStrip points={pts} focusIndex={-1} focusFigures={figures(777, 55)} previous={null} view="flow" onView={() => {}} />);
    expect(screen.getByTestId("an-metric-income-value").getAttribute("data-value")).toBe("777");
    expect(screen.getByTestId("an-metric-outflow-value").getAttribute("data-value")).toBe("55");
    expect(screen.getByTestId("an-metric-net-value").getAttribute("data-value")).toBe("722");
  });
  it("month window: tiles show the focused period; the change chip compares with the previous period", () => {
    render(<KpiStrip points={pts} focusIndex={2} focusFigures={pts[2].figures} previous={pts[1].figures} view="flow" onView={() => {}} />);
    expect(screen.getByTestId("an-metric-income-value").getAttribute("data-value")).toBe("3000");
    expect(screen.getByTestId("an-metric-income").textContent).toContain("50%"); // 3000 vs 2000
  });
  it("income tile explains recovered loan principal when present", () => {
    const f = { ...(figures(7_000, 0) as object), principalRecovered: 2_000, earnedIncome: 5_000 } as never;
    render(<KpiStrip points={pts} focusIndex={-1} focusFigures={f} previous={null} view="flow" onView={() => {}} />);
    expect(screen.getByTestId("an-metric-income").textContent).toContain("loan principal recovered");
  });
});
