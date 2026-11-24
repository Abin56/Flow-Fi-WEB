// @vitest-environment jsdom
/**
 * Reports / Analytics round-4 (2026-11-24): loan-collection split completeness (never guessed), legacy collections,
 * card-charged EMI vs real bank cash, backdated loan payment dates, and engine → KPI note → CSV agreement.
 * Expected values are hand-computed from the records written in each scenario.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KpiStrip } from "@/features/analytics/components/analytics-charts";
import { incomeCompositionNote } from "@/features/reports/lib/income-note";
import { loanCollectionPrincipalByTransaction } from "@/features/reports/lib/loan-collection-principal";
import { periodReportCsv } from "@/features/reports/lib/report-csv";
import { mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { buildPeriodReportSources, periodDetail, periodFigures, type LoanCollectionSplit } from "@/lib/engines/period-report";
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
const build = (transactions: Transaction[], o: { emis?: Emi[]; emiPayments?: { scheduleId: string; date: Date; amount: number; recordedEarlier: boolean }[]; loanPayments?: LoanScheduledPayment[]; principal?: Map<string, LoanCollectionSplit> } = {}) =>
  buildPeriodReportSources({
    transactions,
    spendTransactions: transactions,
    mySpendCtx: mySpendContextFromRecords({ transactions, expenses: [], loans: [{ id: "L9", agreementKind: "loan" }, { id: "L1", agreementKind: "loan" }], emis: [{ id: "E1", purchaseTransactionId: null }] }),
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
const collection = (id: string, amount: number, day = 20) => tx({ id, type: "income", amount, dateTime: d(10, day), loanId: "L9", paymentAllocationType: "regularEmi" });

describe("loan collection split — never guessed", () => {
  it("₹2,200 received = ₹2,000 principal + ₹200 interest (complete record)", () => {
    const f = periodFigures(build([collection("c", 2_200)], { principal: new Map([["c", { principal: 2_000, total: 2_200 }]]) }), nov);
    expect([f.cash.moneyIn, f.principalRecovered, f.loanInterestEarned, f.loanCollectionUnclassified, f.earnedIncome, f.income]).toEqual([2_200, 2_000, 200, 0, 200, 2_200]);
  });
  it("no split available → everything unclassified, principal 0, earned 0 (NOT silently all principal, NOT silently earned)", () => {
    const f = periodFigures(build([collection("c", 2_200)]), nov);
    expect([f.principalRecovered, f.loanInterestEarned, f.loanCollectionUnclassified, f.earnedIncome]).toEqual([0, 0, 2_200, 0]);
    expect(f.income).toBe(2_200); // Month Cycle meaning unchanged
  });
  it("schedule payments that do not add up to the money received → unclassified", () => {
    const f = periodFigures(build([collection("c", 2_200)], { principal: new Map([["c", { principal: 2_000, total: 2_000 }]]) }), nov);
    expect([f.principalRecovered, f.loanCollectionUnclassified]).toEqual([0, 2_200]);
  });
  const inst = { id: "i1", scheduleId: "SL", amountDue: 1_200, principalPortion: 1_000, deletedAt: null };
  const inst2 = { id: "i2", scheduleId: "SL", amountDue: 1_200, principalPortion: 1_000, deletedAt: null };
  const pay = (txId: string, instId: string, day: number, amount: number, extra: Partial<LoanScheduledPayment> = {}): LoanScheduledPayment => ({ direction: "given", installmentDueDate: d(10, 20), amount, date: d(10, day), transactionId: txId, deletedAt: null, installmentId: instId, scheduleId: "SL", paymentId: `${txId}-${instId}`, allocationType: "regularEmi", ...extra });
  it("one transaction paying two installments sums both (1,200 + 1,200 → principal 2,000, interest 400)", () => {
    const m = loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [inst, inst2], loanPayments: [pay("t", "i1", 20, 1_200), pay("t", "i2", 20, 1_200)] });
    expect(m.get("t")).toEqual({ principal: 2_000, total: 2_400 });
  });
  it("partial repayment: 600 of a 1,200 installment (principal 1,000) → principal 500, interest 100", () => {
    const m = loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [inst], loanPayments: [pay("t", "i1", 20, 600)] });
    expect(m.get("t")).toEqual({ principal: 500, total: 600 });
  });
  it("missing / retired installment → no entry (unclassified), never principal 0 with interest = everything", () => {
    const retired = { ...inst, deletedAt: d(9, 1) };
    expect(loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [retired], loanPayments: [pay("t", "i1", 20, 1_200)] }).has("t")).toBe(false);
    expect(loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [], loanPayments: [pay("t", "i1", 20, 1_200)] }).has("t")).toBe(false);
    expect(loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [inst], loanPayments: [pay("t", "ghost", 20, 1_200)] }).has("t")).toBe(false);
  });
  it("one unknown payment makes the whole transaction unclassified", () => {
    const m = loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [inst], loanPayments: [pay("t", "i1", 20, 600), pay("t", "ghost", 20, 600)] });
    expect(m.has("t")).toBe(false);
  });
  it("an explicit principal prepayment is all principal", () => {
    const m = loanCollectionPrincipalByTransaction({ givenScheduleIds: ["SL"], installments: [inst], loanPayments: [pay("t", "i1", 20, 700, { allocationType: "principalPrepayment", prepaymentPrincipalAmount: 700 })] });
    expect(m.get("t")).toEqual({ principal: 700, total: 700 });
  });
  it("two collections in the month are classified independently (one known, one not)", () => {
    const f = periodFigures(build([collection("a", 2_200), collection("b", 500, 21)], { principal: new Map([["a", { principal: 2_000, total: 2_200 }]]) }), nov);
    expect([f.principalRecovered, f.loanInterestEarned, f.loanCollectionUnclassified, f.income]).toEqual([2_000, 200, 500, 2_700]);
    expect(f.earnedIncome).toBe(200);
  });
});

describe("historical / legacy loan collections (schedule payment with no account transaction)", () => {
  const legacy: LoanScheduledPayment = { direction: "given", installmentDueDate: d(10, 20), amount: 1_500, date: d(10, 20), transactionId: null, deletedAt: null };
  const f = periodFigures(build([], { loanPayments: [legacy] }), nov);
  it("cash-basis Money In counts it once (existing Dashboard rule); Month Cycle income does not", () => {
    expect(f.cash.moneyIn).toBe(1_500);
    expect(f.income).toBe(0);
  });
  it("it is never principal recovered / unclassified income, and is flagged as an older record", () => {
    expect([f.principalRecovered, f.loanCollectionUnclassified, f.earnedIncome]).toEqual([0, 0, 0]);
    expect([f.debt.loanCollected, f.debt.loanCollectedLegacy]).toEqual([1_500, 1_500]);
  });
  it("a collection that HAS a transaction is not also counted as legacy (no duplicate)", () => {
    const linked = periodFigures(build([collection("c", 1_500)], { loanPayments: [{ ...legacy, transactionId: "c" }], principal: new Map([["c", { principal: 1_500, total: 1_500 }]]) }), nov);
    expect([linked.cash.moneyIn, linked.debt.loanCollected, linked.debt.loanCollectedLegacy]).toEqual([1_500, 1_500, 0]);
  });
  it("a collection whose transaction was deleted contributes nothing anywhere", () => {
    const gone = periodFigures(build([{ ...collection("c", 1_500), deletedAt: d(10, 21) }], { loanPayments: [{ ...legacy, transactionId: "c" }] }), nov);
    expect([gone.cash.moneyIn, gone.income, gone.debt.loanCollected]).toEqual([0, 0, 0]);
  });
});

describe("card-charged EMI is not bank cash; only real bank movements are", () => {
  const emiPay = (day: number, amount: number) => [{ scheduleId: "S1", date: d(9, day), amount, recordedEarlier: false }];
  it("₹900 EMI charged to the card on 31 Oct: no bank cash out, no debt cash paid in October", () => {
    const f = periodFigures(build([tx({ id: "chg", amount: 900, accountId: CARD, dateTime: d(9, 31), emiId: "E1" })], { emis: [cardEmi], emiPayments: emiPay(31, 900) }), month(9));
    expect([f.cash.moneyOut, f.debt.paidTowardsDebts, f.debt.emiPaidDirect]).toEqual([0, 0, 0]);
    expect(f.outflow).toBe(900); // Month Cycle: counted once, by payment date
  });
  it("the later bank → card bill payment (Nov 3) is the cash: 900 out in November, 0 more outflow", () => {
    const txs = [
      tx({ id: "chg", amount: 900, accountId: CARD, dateTime: d(9, 31), emiId: "E1" }),
      tx({ id: "b-o", amount: 900, dateTime: d(10, 3), transferId: "B" }),
      tx({ id: "b-i", type: "income", amount: 900, dateTime: d(10, 3), accountId: CARD, transferId: "B" }),
    ];
    const f = periodFigures(build(txs, { emis: [cardEmi], emiPayments: emiPay(31, 900) }), nov);
    expect([f.cash.moneyOut, f.debt.cardBillPayments, f.debt.paidTowardsDebts, f.outflow]).toEqual([900, 900, 900, 0]);
  });
});

describe("loan repayment date follows the money (backdated schedule date)", () => {
  it("schedule date 31 Oct, account transaction 1 Nov → counted in November only, once", () => {
    const p: LoanScheduledPayment = { direction: "taken", installmentDueDate: d(9, 31), amount: 1_200, date: d(9, 31), transactionId: "lp", deletedAt: null };
    const src = build([tx({ id: "lp", amount: 1_200, dateTime: d(10, 1), loanId: "L1", paymentAllocationType: "regularEmi" })], { loanPayments: [p] });
    expect([periodFigures(src, month(9)).debt.loanRepaid, periodFigures(src, nov).debt.loanRepaid]).toEqual([0, 1_200]);
  });
});

describe("engine → KPI note → tile → CSV agree for the same period", () => {
  const txs = [tx({ id: "sal", type: "income", amount: 5_000, dateTime: d(10, 1), categoryId: "salary" }), collection("c", 2_200)];
  const src = build(txs, { principal: new Map([["c", { principal: 2_000, total: 2_200 }]]) });
  const det = periodDetail(src, nov);
  const fmt = (v: number) => `₹${v.toLocaleString("en-IN")}`;
  it("note text", () => {
    expect(incomeCompositionNote(det, fmt)).toBe("Incl. ₹2,000 loan principal recovered · ₹200 loan interest · earned ₹5,200");
    expect(incomeCompositionNote({ ...det, principalRecovered: 0, loanInterestEarned: 0, loanCollectionUnclassified: 0 }, fmt)).toBeNull();
    expect(incomeCompositionNote({ ...det, principalRecovered: 0, loanInterestEarned: 0, loanCollectionUnclassified: 2_200, earnedIncome: 5_000 }, fmt)).toBe("Incl. ₹2,200 loan collection not split · earned ₹5,000");
  });
  it("KPI tile shows engine income (7,200) and the same note", () => {
    render(<KpiStrip points={[{ period: nov, figures: det }]} focusIndex={0} focusFigures={det} previous={null} view="flow" onView={() => {}} />);
    expect(screen.getByTestId("an-metric-income-value").getAttribute("data-value")).toBe("7200");
    expect(screen.getByTestId("an-metric-income").textContent).toContain("₹2,000 loan principal recovered");
    expect(screen.getByTestId("an-metric-net-value").getAttribute("data-value")).toBe("7200");
  });
  it("CSV rows carry the same numbers", () => {
    const csv = periodReportCsv({ detail: det, accountName: (i) => i, categoryName: (i) => i });
    const row = (label: string) => csv.split("\n").find((l) => l.includes(label))!;
    expect(row("Income,")).toContain(",7200,");
    expect(row("loan principal recovered")).toContain(",2000,");
    expect(row("loan interest collected")).toContain(",200,");
    expect(row("not split")).toContain(",0,");
    expect(row("earned income")).toContain(",5200,");
    expect(row("Cash money in")).toContain(",7200,");
  });
});
