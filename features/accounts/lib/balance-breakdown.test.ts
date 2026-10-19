import { describe, expect, it } from "vitest";
import { buildBalanceBreakdown, type BalanceAccountInput } from "@/features/accounts/lib/balance-breakdown";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";

let seq = 0;
function tx(overrides: Partial<Transaction> & Pick<Transaction, "accountId" | "type" | "amount">): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    dateTime: new Date(2026, 9, 1 + (seq % 20)),
    categoryId: "c",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date(2026, 9, 1),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    fundedByPersonId: null,
    transferFeeForId: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

/** An account whose stored balance is exactly what the app's delta writes would have produced. */
function account(id: string, opening: number, txs: Transaction[]): BalanceAccountInput {
  const current = Math.round((opening + txs.filter((t) => t.accountId === id && t.deletedAt == null).reduce((s, t) => s + balanceEffect(t), 0)) * 100) / 100;
  return { id, name: id.toUpperCase(), openingBalance: opening, currentBalance: current };
}

describe("buildBalanceBreakdown", () => {
  it("explains a positive account: opening + added − deducted = current", () => {
    const txs = [tx({ accountId: "a", type: "income", amount: 5000 }), tx({ accountId: "a", type: "expense", amount: 1200 })];
    const a = account("a", 1000, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.starting).toBe(1000);
    expect(b.added).toBe(5000);
    expect(b.deducted).toBe(1200);
    expect(b.fromRecords).toBe(4800);
    expect(b.current).toBe(4800);
    expect(b.unexplained).toBe(0);
    expect(b.positive.accounts.map((x) => x.id)).toEqual(["a"]);
    expect(b.negative.accounts).toEqual([]);
  });

  it("explains a negative account", () => {
    const txs = [tx({ accountId: "a", type: "expense", amount: 700 })];
    const a = account("a", 200, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.current).toBe(-500);
    expect(b.unexplained).toBe(0);
    expect(b.negative.total).toBe(-500);
    expect(b.positive.total).toBe(0);
  });

  it("splits a mixed total into holding and overdrawn accounts that add up to the total", () => {
    const txs = [tx({ accountId: "a", type: "income", amount: 900 }), tx({ accountId: "b", type: "expense", amount: 400 })];
    const a = account("a", 100, txs);
    const c = account("b", 0, txs);
    const b = buildBalanceBreakdown({ accounts: [a, c], transactions: txs });
    expect(b.positive.total).toBe(1000);
    expect(b.negative.total).toBe(-400);
    expect(b.positive.total + b.negative.total).toBe(b.current);
    expect(b.current).toBe(600);
  });

  it("keeps an opening-balance-only account and an empty history explainable", () => {
    const a = account("a", 2500, []);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: [] });
    expect(b.fromRecords).toBe(2500);
    expect(b.movements).toEqual([]);
    expect(b.moneyIn).toEqual([]);
  });

  it("never calls a transfer between owned accounts income or spending", () => {
    const out = tx({ accountId: "a", type: "expense", amount: 300, transferId: "x1" });
    const inn = tx({ accountId: "b", type: "income", amount: 300, transferId: "x1" });
    const txs = [out, inn];
    const a = account("a", 1000, txs);
    const c = account("b", 0, txs);
    const both = buildBalanceBreakdown({ accounts: [a, c], transactions: txs });
    expect(both.moneyIn.map((m) => m.category)).toEqual(["transferIn"]);
    expect(both.moneyOut.map((m) => m.category)).toEqual(["transferOut"]);
    expect(both.current).toBe(1000); // nets to zero across both
    expect(both.moneyIn.some((m) => m.category === "income")).toBe(false);
  });

  it("labels a transfer into a credit card as a card bill payment", () => {
    const out = tx({ accountId: "a", type: "expense", amount: 800, transferId: "p1" });
    const cardLeg = tx({ accountId: "card", type: "income", amount: 800, transferId: "p1" });
    const a = account("a", 2000, [out]);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: [out, cardLeg], cardAccountIds: new Set(["card"]) });
    expect(b.moneyOut).toEqual([{ category: "cardPayment", label: "Credit card bill payments", amount: 800, count: 1 }]);
    expect(b.unexplained).toBe(0);
  });

  it("keeps loan principal, loan/EMI payments and People money out of income and expenses", () => {
    const txs = [
      tx({ accountId: "a", type: "income", amount: 10000, loanId: "L", paymentAllocationType: "additionalDisbursement" }),
      tx({ accountId: "a", type: "expense", amount: 1500, loanId: "L", paymentAllocationType: "regularEmi" }),
      tx({ accountId: "a", type: "expense", amount: 500, emiId: "E", paymentAllocationType: "regularEmi" }),
      tx({ accountId: "a", type: "income", amount: 250, isPersonLedgerMovement: true }),
      tx({ accountId: "a", type: "expense", amount: 100, isPersonLedgerMovement: true }),
    ];
    const a = account("a", 0, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.moneyIn.map((m) => m.category).sort()).toEqual(["loanReceived", "peopleIn"]);
    expect(b.moneyOut.map((m) => m.category).sort()).toEqual(["loanPaid", "peopleOut"]);
    expect(b.moneyOut.find((m) => m.category === "loanPaid")).toMatchObject({ amount: 2000, count: 2 });
    expect(b.unexplained).toBe(0);
  });

  it("treats partial payments as the amount actually moved", () => {
    const txs = [tx({ accountId: "a", type: "expense", amount: 333.33, loanId: "L", paymentAllocationType: "regularEmi" })];
    const a = account("a", 1000, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.deducted).toBe(333.33);
    expect(b.current).toBe(666.67);
    expect(b.unexplained).toBe(0);
  });

  it("does not show a historical (already-included) payment as a cash movement", () => {
    const historical = tx({ accountId: "a", type: "expense", amount: 4000, excludeFromCalculations: true, loanId: "L" });
    const real = tx({ accountId: "a", type: "expense", amount: 100 });
    const txs = [historical, real];
    const a = account("a", 1000, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.movements).toHaveLength(1);
    expect(b.deducted).toBe(100);
    expect(b.notCountedCount).toBe(1);
    expect(b.unexplained).toBe(0);
  });

  it("ignores deleted (reversed/cancelled) transactions", () => {
    const gone = tx({ accountId: "a", type: "expense", amount: 900, deletedAt: new Date() });
    const live = tx({ accountId: "a", type: "income", amount: 50 });
    const a = account("a", 100, [gone, live]);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: [gone, live] });
    expect(b.movements.map((m) => m.id)).toEqual([live.id]);
    expect(b.current).toBe(150);
    expect(b.unexplained).toBe(0);
  });

  it("separates a transfer fee from the transfer itself", () => {
    const fee = tx({ accountId: "a", type: "expense", amount: 10, transferFeeForId: "x9" });
    const a = account("a", 100, [fee]);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: [fee] });
    expect(b.moneyOut[0]?.category).toBe("transferFee");
  });

  it("reports an honest unexplained difference instead of inventing a balancing entry", () => {
    const txs = [tx({ accountId: "a", type: "income", amount: 100 })];
    const a: BalanceAccountInput = { id: "a", name: "A", openingBalance: 0, currentBalance: 175.5 };
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.current).toBe(175.5);
    expect(b.fromRecords).toBe(100);
    expect(b.unexplained).toBe(75.5);
    expect(b.movements).toHaveLength(1); // no fabricated row
    // …and it agrees with the canonical drift detector.
    expect(accountBalanceDrift(a, txs)?.drift).toBe(75.5);
  });

  it("matches the canonical drift detector's expected balance", () => {
    const txs = [tx({ accountId: "a", type: "income", amount: 10.1 }), tx({ accountId: "a", type: "expense", amount: 0.2 })];
    const a = account("a", 0.1, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(accountBalanceDrift(a, txs)).toBeNull();
    expect(b.unexplained).toBe(0);
  });

  it("keeps paise exact across many small movements", () => {
    const txs = Array.from({ length: 1000 }, () => tx({ accountId: "a", type: "income", amount: 0.1 }));
    const a = account("a", 0, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.added).toBe(100);
    expect(b.current).toBe(100);
    expect(b.unexplained).toBe(0);
  });

  it("handles a large history and counts by category", () => {
    const txs = Array.from({ length: 20000 }, (_, i) => tx({ accountId: "a", type: i % 2 ? "income" : "expense", amount: 12.34 }));
    const a = account("a", 0, txs);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: txs });
    expect(b.movements).toHaveLength(20000);
    expect(b.moneyIn[0]?.count).toBe(10000);
    expect(b.unexplained).toBe(0);
  });

  it("counts a record by its balance effect, not by its accounting month", () => {
    const t = tx({ accountId: "a", type: "income", amount: 400, dateTime: new Date(2026, 8, 30), accountingMonth: new Date(2026, 9, 1) });
    const a = account("a", 0, [t]);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: [t] });
    expect(b.current).toBe(400);
    expect(b.unexplained).toBe(0);
  });

  it("ignores a person-funded expense (no account leg) and other accounts' records", () => {
    const funded = tx({ accountId: "", type: "expense", amount: 700, fundedByPersonId: "p" });
    const other = tx({ accountId: "z", type: "expense", amount: 5 });
    const a = account("a", 50, []);
    const b = buildBalanceBreakdown({ accounts: [a], transactions: [funded, other] });
    expect(b.movements).toEqual([]);
    expect(b.unexplained).toBe(0);
  });
});
