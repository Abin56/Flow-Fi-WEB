/**
 * Reports / Analytics round-2 scenarios (2026-11-24). Expected values are hand-computed from the records written in
 * each scenario — never read back from the engine. Real posting shapes follow `emi-card-funding.ts` (card / bank mode,
 * Case A / B) and `loan-origination.ts` / `loan-payment-core.ts` (lend = expense + additionalDisbursement, collect = income).
 */

import { describe, expect, it } from "vitest";
import { changePercent } from "@/features/reports/components/report-ui";
import { periodReportCsv } from "@/features/reports/lib/report-csv";
import { focusedPointIndex } from "@/features/analytics/lib/focus-point";
import { mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { buildPeriodReportSources, periodDetail, periodFigures } from "@/lib/engines/period-report";
import { previousReportPeriod, resolveReportPeriod, trendPeriods } from "@/lib/engines/report-period";
import type { LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import type { Emi } from "@/lib/models/emi";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const NOW = new Date(2026, 10, 24, 12);
const BANK = "bank";
const CARD = "card";
const d = (m: number, day: number, h = 12) => new Date(2026, m, day, h);
const tx = (p: Partial<Transaction> & { id: string }): Transaction => ({
  ...TransactionRepository.buildTransaction({ type: p.type ?? "expense", amount: p.amount ?? 0, dateTime: p.dateTime ?? NOW, accountId: p.accountId ?? BANK, categoryId: p.categoryId ?? "misc" }),
  ...p,
});
type EmiPay = { scheduleId: string; date: Date; amount: number; recordedEarlier: boolean };
const cardEmi = { id: "E1", scheduleId: "S1", linkedCreditCardId: "cc", purchaseTransactionId: null, deletedAt: null } as unknown as Emi;

function build(transactions: Transaction[], o: { emis?: Emi[]; emiPayments?: EmiPay[]; loanPayments?: LoanScheduledPayment[] } = {}) {
  return buildPeriodReportSources({
    transactions,
    spendTransactions: transactions,
    mySpendCtx: mySpendContextFromRecords({ transactions, expenses: [], loans: [{ id: "L1", agreementKind: "loan" }, { id: "L9", agreementKind: "loan" }], emis: [{ id: "E1", purchaseTransactionId: null }] }),
    creditCards: [{ id: "cc", accountId: CARD }],
    emis: o.emis ?? [],
    expenses: [],
    emiPayments: o.emiPayments ?? [],
    loanPayments: o.loanPayments ?? [],
    installmentsByScheduleId: {},
    accounts: [
      { id: BANK, currentBalance: 0 },
      { id: CARD, currentBalance: 0 },
    ],
  });
}
const nov = resolveReportPeriod({ kind: "month", year: 2026, month: 10 }, 1, NOW);
const bill = (id: string, amt: number, day = 10) => [
  tx({ id: `${id}-o`, amount: amt, dateTime: d(10, day), transferId: id }),
  tx({ id: `${id}-i`, type: "income", amount: amt, dateTime: d(10, day), accountId: CARD, transferId: id }),
];

describe("1. lend 10,000, receive 2,000 back", () => {
  const lend = tx({ id: "lend", amount: 10_000, dateTime: d(10, 2), loanId: "L9", paymentAllocationType: "additionalDisbursement" });
  const back = tx({ id: "back", type: "income", amount: 2_000, dateTime: d(10, 20), loanId: "L9", paymentAllocationType: "regularEmi" });
  const lp: LoanScheduledPayment[] = [{ direction: "given", installmentDueDate: d(10, 20), amount: 2_000, date: d(10, 20), transactionId: "back", deletedAt: null }];
  const f = periodFigures(build([lend, back], { loanPayments: lp }), nov);
  it("lent principal is never spend / outflow", () => {
    expect(f.outflow).toBe(0);
    expect(f.mySpend).toBe(0);
  });
  it("Money In (cash basis) = 2,000 exactly once — not doubled by the schedule row", () => {
    expect(f.cash.moneyIn).toBe(2_000);
    expect(f.cash.moneyOut).toBe(0);
  });
  it("collected is reported as collected (2,000), nothing as repaid / paid towards debts", () => {
    expect(f.debt).toMatchObject({ loanCollected: 2_000, loanRepaid: 0, paidTowardsDebts: 0 });
  });
  it("DOCUMENTED (shared Month Cycle rule, not changed): Income = 2,000 because the collection is an income-type row", () => {
    expect(f.income).toBe(2_000);
  });
  it("account balance still moves by the real cash: −10,000 + 2,000", () => {
    const det = periodDetail(build([lend, back], { loanPayments: lp }), nov);
    const bank = det.accounts.find((a) => a.accountId === BANK)!;
    expect(bank.moneyOut).toBe(10_000);
    expect(bank.moneyIn).toBe(2_000);
  });
});

describe("2. credit card scenarios — Paid Towards Debts", () => {
  const paid = (txs: Transaction[], emiAmt?: number, loan?: LoanScheduledPayment[]) =>
    periodFigures(build(txs, { emis: [cardEmi], emiPayments: emiAmt ? [{ scheduleId: "S1", date: d(10, 5), amount: emiAmt, recordedEarlier: false }] : [], loanPayments: loan }), nov);

  it("normal card purchase alone: no debt payment, no cash out", () => {
    const f = paid([tx({ id: "p", amount: 800, accountId: CARD, dateTime: d(10, 3) })]);
    expect(f.debt.paidTowardsDebts).toBe(0);
    expect(f.cash.moneyOut).toBe(0);
    expect(f.outflow).toBe(800);
  });
  it("card bill payment alone: 5,000 paid, outflow unchanged 0", () => {
    const f = paid([...bill("T", 5_000)]);
    expect(f.debt.paidTowardsDebts).toBe(5_000);
    expect(f.outflow).toBe(0);
    expect(f.cash.moneyOut).toBe(5_000);
  });
  it("user example: bill 7,000 (includes EMI principal 900) + interest 100 paid from bank = 7,100", () => {
    const f = paid([...bill("T", 7_000), tx({ id: "int", amount: 100, dateTime: d(10, 5), emiId: "E1", paymentAllocationType: "regularEmi" })], 1_000);
    expect(f.debt.emiPaid).toBe(1_000);
    expect(f.debt.cardBillPayments).toBe(7_000);
    expect(f.debt.emiPaidOnCard).toBe(900);
    expect(f.debt.paidTowardsDebts).toBe(7_100);
  });
  it("Case A bank mode: interest 100 bank expense + 900 principal transfer pair → 1,000", () => {
    const f = paid([tx({ id: "int", amount: 100, dateTime: d(10, 5), emiId: "E1" }), ...bill("xfer_emi_1", 900, 5).map((t) => ({ ...t, emiId: "E1" }))], 1_000);
    expect(f.debt.paidTowardsDebts).toBe(1_000);
  });
  it("Case B bank mode: whole 1,000 installment paid from bank, no card leg → 1,000 (not dropped)", () => {
    const f = paid([tx({ id: "inst", amount: 1_000, dateTime: d(10, 5), emiId: "E1" })], 1_000);
    expect(f.debt.paidTowardsDebts).toBe(1_000);
    expect(f.debt.emiPaidOnCard).toBe(0);
  });
  it("Case B card mode: 1,000 on card, later bill 1,000 → 1,000 (once)", () => {
    const f = paid([tx({ id: "inst", amount: 1_000, accountId: CARD, dateTime: d(10, 5), emiId: "E1" }), ...bill("T", 1_000)], 1_000);
    expect(f.debt.paidTowardsDebts).toBe(1_000);
  });
  it("non-card EMI paid from the bank: 2,500 once", () => {
    const plain = { id: "E2", scheduleId: "S2", linkedCreditCardId: null, purchaseTransactionId: null, deletedAt: null } as unknown as Emi;
    const f = periodFigures(build([tx({ id: "x", amount: 2_500, dateTime: d(10, 5), emiId: "E2" })], { emis: [plain], emiPayments: [{ scheduleId: "S2", date: d(10, 5), amount: 2_500, recordedEarlier: false }] }), nov);
    expect(f.debt.paidTowardsDebts).toBe(2_500);
    expect(f.outflow).toBe(2_500);
  });
  it("recorded-earlier EMI payment moves no money → 0", () => {
    const f = periodFigures(build([], { emis: [cardEmi], emiPayments: [{ scheduleId: "S1", date: d(10, 5), amount: 1_000, recordedEarlier: true }] }), nov);
    expect(f.debt.paidTowardsDebts).toBe(0);
    expect(f.outflow).toBe(0);
  });
  it("loan repayment charged to a card 1,200 + bill 1,200 → 1,200; paid direct from bank → 1,200", () => {
    const lp = (id: string): LoanScheduledPayment[] => [{ direction: "taken", installmentDueDate: d(10, 5), amount: 1_200, date: d(10, 5), transactionId: id, deletedAt: null }];
    const onCard = paid([tx({ id: "lc", amount: 1_200, accountId: CARD, dateTime: d(10, 5), loanId: "L1", paymentAllocationType: "regularEmi" }), ...bill("T", 1_200)], undefined, lp("lc"));
    expect(onCard.debt.paidTowardsDebts).toBe(1_200);
    const direct = paid([tx({ id: "lb", amount: 1_200, dateTime: d(10, 5), loanId: "L1", paymentAllocationType: "regularEmi" })], undefined, lp("lb"));
    expect(direct.debt.paidTowardsDebts).toBe(1_200);
  });
  it("CSV carries the same numbers as the engine (7,100 example)", () => {
    const det = periodDetail(build([...bill("T", 7_000), tx({ id: "int", amount: 100, dateTime: d(10, 5), emiId: "E1" })], { emis: [cardEmi], emiPayments: [{ scheduleId: "S1", date: d(10, 5), amount: 1_000, recordedEarlier: false }] }), nov);
    const csv = periodReportCsv({ detail: det, accountName: (i) => i, categoryName: (i) => i });
    const row = (label: string) => csv.split("\n").find((l) => l.includes(label))!;
    expect(row("EMI installments paid")).toContain(",1000,");
    expect(row("Card bill payments")).toContain(",7000,");
    expect(row("settled by a card bill")).toContain(",900,");
    expect(row("Paid towards debts")).toContain(",7100,");
  });
});

describe("3. date filtering", () => {
  // Oct 1: salary 1,000 · Oct 15: food 100 · Nov 3: salary 2,000 · Nov 5: food 300 · Nov 8: rent 500 · Dec 2: food 700
  const txs = [
    tx({ id: "s1", type: "income", amount: 1_000, dateTime: d(9, 1), categoryId: "salary" }),
    tx({ id: "f1", amount: 100, dateTime: d(9, 15), categoryId: "food" }),
    tx({ id: "s2", type: "income", amount: 2_000, dateTime: d(10, 3), categoryId: "salary" }),
    tx({ id: "f2", amount: 300, dateTime: d(10, 5), categoryId: "food" }),
    tx({ id: "r", amount: 500, dateTime: d(10, 8), categoryId: "rent" }),
    tx({ id: "f3", amount: 700, dateTime: d(11, 2), categoryId: "food" }),
  ];
  const src = build(txs);
  const range = (a: Date, b: Date) => resolveReportPeriod({ kind: "range", start: a, end: b }, 1, NOW);

  it("custom 4–7 Nov: only f2 (300); salary on the 3rd and rent on the 8th excluded; edge days inclusive", () => {
    const f = periodFigures(src, range(d(10, 4), d(10, 7)));
    expect([f.income, f.outflow, f.mySpend, f.net]).toEqual([0, 300, 300, -300]);
    expect(periodFigures(src, range(d(10, 5), d(10, 5))).outflow).toBe(300);
  });
  it("range 1 Oct – 30 Nov = Oct + Nov (multi-month)", () => {
    const f = periodFigures(src, range(d(9, 1), d(10, 30)));
    expect([f.income, f.outflow, f.mySpend]).toEqual([3_000, 900, 900]);
    expect(f.spendByCategory.get("food")?.amount).toBe(400);
    expect(f.spendByCategory.get("rent")?.amount).toBe(500);
  });
  it("calendar month Nov and cycle (start day 1) agree: 2,000 / 800", () => {
    const m = periodFigures(src, nov);
    const c = periodFigures(src, resolveReportPeriod({ kind: "cycle", offset: 0 }, 1, NOW));
    expect([m.income, m.outflow]).toEqual([2_000, 800]);
    expect([c.income, c.outflow]).toEqual([2_000, 800]);
  });
  it("financial cycle from the 4th (4 Nov – 3 Dec): f2 + r + f3 = 1,500; previous cycle 4 Oct – 3 Nov = salary 2,000 (3 Nov) and food 100", () => {
    const cyc = resolveReportPeriod({ kind: "cycle", offset: 0 }, 4, NOW);
    expect(cyc.start.getDate()).toBe(4);
    const f = periodFigures(src, cyc);
    expect([f.income, f.outflow]).toEqual([0, 1_500]);
    const prev = periodFigures(src, previousReportPeriod(cyc, 4, NOW));
    expect([prev.income, prev.outflow]).toEqual([2_000, 100]);
  });
  it("custom range previous period is the equal-length window right before; change percents are right", () => {
    const r = range(d(10, 4), d(10, 8)); // 5 days
    const p = previousReportPeriod(r, 1, NOW); // 30 Oct – 3 Nov
    expect([p.start.getDate(), p.end.getDate(), p.days]).toEqual([30, 3, 5]);
    const cur = periodFigures(src, r);
    const prev = periodFigures(src, p);
    expect(prev.income).toBe(2_000);
    expect(cur.outflow).toBe(800);
    expect(changePercent(cur.outflow, prev.outflow)).toBeNull();
    expect(changePercent(300, 200)).toBe(50);
    expect(changePercent(-300, -200)).toBe(-50);
  });
  it("empty period: zeros, no savings rate, no categories, no daily entries", () => {
    const empty = periodDetail(src, range(d(7, 1), d(7, 31)));
    expect([empty.income, empty.outflow, empty.mySpend, empty.net]).toEqual([0, 0, 0, 0]);
    expect(empty.savingsRate).toBeNull();
    expect(empty.spendByCategory.size).toBe(0);
    expect(empty.daily.size).toBe(0);
  });
  it("a custom range never maps to a trend point; a cycle / month always maps to itself", () => {
    const r = range(d(10, 4), d(10, 7));
    const pts = trendPeriods(r, 1, 6, NOW).map((period) => ({ period }));
    expect(focusedPointIndex(pts, r)).toBe(-1);
    expect(focusedPointIndex(pts, pts[0].period)).toBe(0);
    const cyc = resolveReportPeriod({ kind: "cycle", offset: -1 }, 18, NOW);
    const cpts = trendPeriods(cyc, 18, 6, NOW).map((period) => ({ period }));
    expect(focusedPointIndex(cpts, cyc)).toBe(5);
  });
  it("trend points equal each month computed alone: Sep 0, Oct 100, Nov 800", () => {
    expect(trendPeriods(nov, 1, 3, NOW).map((p) => periodFigures(src, p).outflow)).toEqual([0, 100, 800]);
  });
});
