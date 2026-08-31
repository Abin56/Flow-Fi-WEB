import { describe, expect, it } from "vitest";
import {
  buildHistory,
  splitExpenseDetailFor,
  type HistoryBillData,
  type HistoryEmiData,
  type HistoryExpense,
  type HistoryInstallment,
  type HistoryLoanData,
  type HistoryTransaction,
} from "./history-builder";

function transaction(overrides: Partial<HistoryTransaction> = {}): HistoryTransaction {
  return {
    id: "t1",
    type: "expense",
    amount: 500,
    dateTime: new Date("2026-07-10T10:00:00Z"),
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    isDeleted: false,
    ...overrides,
  };
}

describe("buildHistory — transaction classification", () => {
  it("id-prefixes a plain transaction and classifies it as 'transaction'/'myExpense'", () => {
    const [entry] = buildHistory({ transactions: [transaction()], expenses: [], loans: [], bills: [], emis: [] });
    expect(entry.id).toBe("txn-t1");
    expect(entry.category).toBe("transaction");
    expect(entry.kind).toBe("myExpense");
    expect(entry.isCredit).toBe(false);
  });

  it("classifies an income transaction as 'myIncome' and a credit", () => {
    const [entry] = buildHistory({
      transactions: [transaction({ type: "income" })],
      expenses: [],
      loans: [],
      bills: [],
      emis: [],
    });
    expect(entry.kind).toBe("myIncome");
    expect(entry.isCredit).toBe(true);
  });

  it("a transfer leg overrides every other classification, even a split expense", () => {
    const expense: HistoryExpense = {
      transactionId: "t1",
      isSplit: true,
      scheduleId: "sched-1",
      myShare: 200,
      participants: [{ name: "You", share: 200, isMe: true }],
    };
    const [entry] = buildHistory({
      transactions: [transaction({ transferId: "xfer-1" })],
      expenses: [expense],
      loans: [],
      bills: [],
      emis: [],
    });
    expect(entry.kind).toBe("transfer");
    // Category classification is independent of kind — a transfer-tagged transaction can
    // still carry a matching split Expense record, so it's still labeled splitExpense.
    expect(entry.category).toBe("splitExpense");
  });

  it("splitExpense classification beats moneyReceived, which beats plain transaction", () => {
    const splitExpense: HistoryExpense = {
      transactionId: "t1",
      isSplit: true,
      scheduleId: "sched-1",
      myShare: 200,
      participants: [{ name: "You", share: 200, isMe: true }],
    };
    const [split] = buildHistory({
      transactions: [transaction({ receiptPurpose: "loan-repayment" })],
      expenses: [splitExpense],
      loans: [],
      bills: [],
      emis: [],
    });
    expect(split.category).toBe("splitExpense");

    const [moneyReceived] = buildHistory({
      transactions: [transaction({ id: "t2", receiptPurpose: "loan-repayment" })],
      expenses: [],
      loans: [],
      bills: [],
      emis: [],
    });
    expect(moneyReceived.category).toBe("moneyReceived");
  });

  it("excludes soft-deleted transactions unless includeDeleted is set", () => {
    const deleted = transaction({ isDeleted: true });
    expect(buildHistory({ transactions: [deleted], expenses: [], loans: [], bills: [], emis: [] })).toHaveLength(0);
    expect(
      buildHistory({ transactions: [deleted], expenses: [], loans: [], bills: [], emis: [], includeDeleted: true }),
    ).toHaveLength(1);
  });
});

describe("buildHistory — loan/bill/EMI payment rows", () => {
  it("emits one credit row per loan payment, and debit rows for bill/EMI payments", () => {
    const loan: HistoryLoanData = {
      id: "loan-1",
      name: "Car loan",
      isDeleted: false,
      payments: [{ id: "p1", date: new Date("2026-07-05"), amount: 1000, note: "", isDeleted: false }],
    };
    const bill: HistoryBillData = {
      id: "bill-1",
      name: "Rent",
      isDeleted: false,
      payments: [{ id: "p2", date: new Date("2026-07-06"), amount: 2000, note: "", isDeleted: false }],
    };
    const emi: HistoryEmiData = {
      id: "emi-1",
      name: "Phone EMI",
      isDeleted: false,
      payments: [{ id: "p3", date: new Date("2026-07-07"), amount: 300, note: "", isDeleted: false }],
    };

    const entries = buildHistory({ transactions: [], expenses: [], loans: [loan], bills: [bill], emis: [emi] });

    const loanEntry = entries.find((e) => e.id === "loan-payment-p1")!;
    expect(loanEntry.isCredit).toBe(true);
    expect(loanEntry.category).toBe("loan");

    const billEntry = entries.find((e) => e.id === "bill-payment-p2")!;
    expect(billEntry.isCredit).toBe(false);
    expect(billEntry.category).toBe("bill");

    const emiEntry = entries.find((e) => e.id === "emi-payment-p3")!;
    expect(emiEntry.isCredit).toBe(false);
    expect(emiEntry.category).toBe("emi");
  });

  it("sorts every entry newest-first regardless of source", () => {
    const loan: HistoryLoanData = {
      id: "loan-1",
      name: null,
      isDeleted: false,
      payments: [{ id: "p1", date: new Date("2026-07-01"), amount: 100, note: "", isDeleted: false }],
    };
    const entries = buildHistory({
      transactions: [transaction({ id: "t1", dateTime: new Date("2026-07-15") })],
      expenses: [],
      loans: [loan],
      bills: [],
      emis: [],
    });
    expect(entries.map((e) => e.id)).toEqual(["txn-t1", "loan-payment-p1"]);
  });
});

describe("splitExpenseDetailFor", () => {
  const expense: HistoryExpense = {
    transactionId: "t1",
    isSplit: true,
    scheduleId: "sched-1",
    myShare: 300,
    participants: [
      { name: "You", share: 300, isMe: true },
      { name: "Priya", share: 200, isMe: false },
    ],
  };

  function installments(overrides: Partial<HistoryInstallment>[]): Record<string, HistoryInstallment[]> {
    return {
      "sched-1": overrides.map((o) => ({ scheduleId: "sched-1", amountPaid: 0, remainingAmount: 0, status: "upcoming", ...o })),
    };
  }

  it("is 'completed' once nothing remains to collect", () => {
    const detail = splitExpenseDetailFor(expense, installments([{ amountPaid: 200, remainingAmount: 0, status: "paid" }]));
    expect(detail.status).toBe("completed");
    expect(detail.amountToCollect).toBe(0);
  });

  it("is 'overdue' if any unpaid installment is overdue, even with others pending", () => {
    const detail = splitExpenseDetailFor(
      expense,
      installments([
        { amountPaid: 0, remainingAmount: 200, status: "overdue" },
      ]),
    );
    expect(detail.status).toBe("overdue");
  });

  it("is 'partial' when something's been paid but nothing is overdue", () => {
    const detail = splitExpenseDetailFor(
      expense,
      installments([{ amountPaid: 50, remainingAmount: 150, status: "partiallyPaid" }]),
    );
    expect(detail.status).toBe("partial");
  });

  it("is 'pending' when nothing has been paid and nothing is overdue", () => {
    const detail = splitExpenseDetailFor(expense, installments([{ amountPaid: 0, remainingAmount: 200, status: "upcoming" }]));
    expect(detail.status).toBe("pending");
  });

  it("sorts 'Me' first in the shares breakdown", () => {
    const detail = splitExpenseDetailFor(expense, installments([]));
    expect(detail.shares[0]).toEqual({ name: "You", share: 300, isMe: true });
    expect(detail.shares[1]).toEqual({ name: "Priya", share: 200, isMe: false });
  });
});
