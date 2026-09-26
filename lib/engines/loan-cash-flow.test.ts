import { describe, expect, it } from "vitest";
import { countsFromSchedule, dashboardLoanPaidRows, scheduleOnlyLoanFlows, type LoanScheduledPayment } from "./loan-cash-flow";
import { cashFlowThisMonth } from "./cash-flow";

const sep = { start: new Date(2026, 8, 1), end: new Date(2026, 8, 30, 23, 59, 59, 999) };
const day = new Date(2026, 8, 10);
const due = new Date(2026, 8, 15);

function payment(over: Partial<LoanScheduledPayment>): LoanScheduledPayment {
  return { direction: "taken", installmentDueDate: due, amount: 1000, date: day, transactionId: null, deletedAt: null, ...over };
}

describe("countsFromSchedule — each Loan money movement counted exactly once", () => {
  it("modern payment linked to a Transaction is NOT counted from the schedule (the Transaction counts it)", () => {
    expect(countsFromSchedule({ transactionId: "adv_k_txn", deletedAt: null })).toBe(false);
  });
  it("legacy payment with no Transaction IS counted from the schedule", () => {
    expect(countsFromSchedule({ transactionId: null, deletedAt: null })).toBe(true);
  });
  it("a reversed (soft-deleted) payment is never counted", () => {
    expect(countsFromSchedule({ transactionId: null, deletedAt: new Date() })).toBe(false);
  });
});

describe("Cash Flow with Loan payments", () => {
  const expenseTxn = (amount: number) => ({ type: "expense" as const, amount, effectiveMonth: new Date(2026, 8, 1), isDeleted: false, isTransfer: false });
  const incomeTxn = (amount: number) => ({ ...expenseTxn(amount), type: "income" as const });
  const now = new Date(2026, 8, 20);

  it("modern linked EMI (borrowed): Money Out = 1,000, not 2,000", () => {
    const flows = scheduleOnlyLoanFlows([payment({ transactionId: "t1" })], sep, "paymentDate");
    const summary = cashFlowThisMonth({ transactions: [expenseTxn(1000)], emiPaidThisMonth: 0, loanPaidThisMonth: flows.moneyOut, loanReceivedThisMonth: flows.moneyIn, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now });
    expect(summary.moneyOut).toBe(1000);
  });

  it("legacy unlinked EMI (borrowed): still Money Out 1,000", () => {
    const flows = scheduleOnlyLoanFlows([payment({})], sep, "paymentDate");
    const summary = cashFlowThisMonth({ transactions: [], emiPaidThisMonth: 0, loanPaidThisMonth: flows.moneyOut, loanReceivedThisMonth: flows.moneyIn, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now });
    expect(summary.moneyOut).toBe(1000);
  });

  it("partial payment: counted once at the partial amount", () => {
    const flows = scheduleOnlyLoanFlows([payment({ amount: 400, transactionId: "t1" })], sep, "paymentDate");
    expect(cashFlowThisMonth({ transactions: [expenseTxn(400)], emiPaidThisMonth: 0, loanPaidThisMonth: flows.moneyOut, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now }).moneyOut).toBe(400);
  });

  it("one physical payment across three installments: counted once (3,000), not 6,000", () => {
    const three = [0, 1, 2].map((i) => payment({ transactionId: "t-multi", installmentDueDate: new Date(2026, 8 + i, 15) }));
    const flows = scheduleOnlyLoanFlows(three, sep, "paymentDate");
    expect(flows).toEqual({ moneyIn: 0, moneyOut: 0 });
    expect(cashFlowThisMonth({ transactions: [expenseTxn(3000)], emiPaidThisMonth: 0, loanPaidThisMonth: flows.moneyOut, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now }).moneyOut).toBe(3000);
  });

  it("reversal: soft-deleted payment + soft-deleted Transaction → nothing counted", () => {
    const flows = scheduleOnlyLoanFlows([payment({ transactionId: "t1", deletedAt: new Date() })], sep, "paymentDate");
    expect(cashFlowThisMonth({ transactions: [{ ...expenseTxn(1000), isDeleted: true }], emiPaidThisMonth: 0, loanPaidThisMonth: flows.moneyOut, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now }).moneyOut).toBe(0);
  });

  it("lent loan: a legacy repayment received is Money IN (was counted as Money Out)", () => {
    const flows = scheduleOnlyLoanFlows([payment({ direction: "given" })], sep, "paymentDate");
    expect(flows).toEqual({ moneyIn: 1000, moneyOut: 0 });
    const summary = cashFlowThisMonth({ transactions: [], emiPaidThisMonth: 0, loanPaidThisMonth: flows.moneyOut, loanReceivedThisMonth: flows.moneyIn, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now });
    expect(summary).toEqual({ moneyIn: 1000, moneyOut: 0, net: 1000 });
  });

  it("lent loan: a modern repayment received is Money In once, via its income Transaction", () => {
    const flows = scheduleOnlyLoanFlows([payment({ direction: "given", transactionId: "t1" })], sep, "paymentDate");
    const summary = cashFlowThisMonth({ transactions: [incomeTxn(1000)], emiPaidThisMonth: 0, loanPaidThisMonth: flows.moneyOut, loanReceivedThisMonth: flows.moneyIn, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now });
    expect(summary).toEqual({ moneyIn: 1000, moneyOut: 0, net: 1000 });
  });

  it("buckets by the real payment date for Cash Flow, by due date for the dashboard views", () => {
    const early = payment({ date: new Date(2026, 7, 28), installmentDueDate: new Date(2026, 8, 5) });
    expect(scheduleOnlyLoanFlows([early], sep, "paymentDate").moneyOut).toBe(0);
    expect(scheduleOnlyLoanFlows([early], sep, "dueDate").moneyOut).toBe(1000);
  });
});

describe("dashboardLoanPaidRows (dashboard combinedExpenses / netCashFlow)", () => {
  it("keeps only legacy unlinked payments on money I borrowed", () => {
    const rows = dashboardLoanPaidRows([
      payment({ amount: 100 }),
      payment({ amount: 200, transactionId: "t" }),
      payment({ amount: 300, direction: "given" }),
      payment({ amount: 400, deletedAt: new Date() }),
    ]);
    expect(rows).toEqual([{ dueDate: due, amountPaid: 100 }]);
  });
});
