/**
 * The three recognition moments of a lender charge, in the cash-basis feeds (Month Cycle "Total outflow", Dashboard
 * Money Out) and the accrual feed (My Spend):
 *   billed   → expense in My Spend, NO cash outflow
 *   settled  → cash outflow exactly once, NO second expense
 *   reversed (unpaid) → nothing anywhere
 * Ordinary transactions keep their existing classification (pinned in the "unchanged" block).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { amountFor, type FinancialViewInputs } from "@/lib/engines/dashboard-aggregation";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { lenderChargeBillingTransaction, withLenderChargeBilling } from "@/lib/engines/lender-charge-accounting";
import { buildMySpendContext, classifyForMySpend } from "@/lib/engines/my-spend";
import type { LenderCharge } from "@/lib/models/lender-charge";
import type { Transaction } from "@/lib/models/transaction";

const NOW = new Date(2026, 9, 20, 12);
const d = (day: number) => new Date(2026, 9, day, 12);

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: "t", type: "expense", amount: 100, dateTime: d(10), accountId: "bank", categoryId: "food", description: "", notes: "", receiptPurpose: null, transferId: null,
    excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false, createdAt: d(10), transferMatchedAt: null, status: "posted", isBusiness: false,
    source: null, loanId: null, emiId: null, installmentId: null, installmentPaymentId: null, paymentAllocationType: null, isPersonLedgerMovement: false,
    deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
  } as Transaction;
}
const charge = (over: Partial<LenderCharge> = {}): LenderCharge => ({
  id: "c1", agreementKind: "emi", agreementId: "e1", type: "penalty", amount: 1000, billedDate: d(5), lenderReference: "R", reason: "late", categoryId: null,
  settlements: [], reversedAt: null, reversalReason: null, cardReview: null, idempotencyKey: "k", createdAt: d(5), deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
});
/** The payment that settles a charge: a real account debit, marked, with NO loan/EMI link. */
const settlement = (amount: number, day = 12) => tx({ id: `pay-${amount}`, amount, dateTime: d(day), lenderChargeId: "c1" });

const noCards = new Set<string>();
const outflow = (transactions: Transaction[]) => {
  const range = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31, 23, 59, 59) };
  const inputs: FinancialViewInputs = {
    transactions: monthCycleDashboardTransactions(transactions, noCards), expenses: [], billOccurrences: [], emiInstallments: [], loanInstallments: [], creditCardStatements: [], creditCardAccountIds: noCards,
  };
  return amountFor("combinedExpenses", { kind: "reportsPeriod", isMonthGranular: false }, range, inputs);
};
const dashboardMoneyOut = (transactions: Transaction[]) =>
  cashFlowThisMonth({ transactions: cashFlowTransactions(transactions, noCards), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: NOW }).moneyOut;
const spend = (transactions: Transaction[]) => {
  const ctx = buildMySpendContext({ expenses: [] });
  return transactions.reduce((s, t) => s + classifyForMySpend(t, ctx).myAmount, 0);
};

describe("unchanged: ordinary transactions", () => {
  it("an ordinary expense is outflow, Money Out and spend", () => {
    const t = [tx({ amount: 250 })];
    expect(outflow(t)).toBe(250);
    expect(dashboardMoneyOut(t)).toBe(250);
    expect(spend(t)).toBe(250);
  });
  it("a transfer is none of them", () => {
    const t = [tx({ amount: 900, transferId: "x" })];
    expect(outflow(t)).toBe(0);
    expect(dashboardMoneyOut(t)).toBe(0);
    expect(spend(t)).toBe(0);
  });
  it("a People ledger movement and a loan disbursement stay out of Money Out", () => {
    expect(dashboardMoneyOut([tx({ isPersonLedgerMovement: true, amount: 700 })])).toBe(0);
    expect(dashboardMoneyOut([tx({ loanId: "l", paymentAllocationType: "additionalDisbursement", amount: 700 })])).toBe(0);
  });
});

describe("billing: expense, never cash", () => {
  it("is My Spend once, and is not cash outflow or Money Out (billing rows never reach the cash feeds)", () => {
    const real = [tx({ amount: 100 })];
    const withBilling = withLenderChargeBilling(real, [charge()]);
    expect(spend(withBilling)).toBe(1100);
    // the cash feeds are built from REAL transactions only
    expect(outflow(real)).toBe(100);
    expect(dashboardMoneyOut(real)).toBe(100);
  });
  it("were a billing row ever fed to the cash feed it would count — which is exactly why the hooks must not", () => {
    // Documents the failure mode the Month Cycle hook was fixed for.
    expect(outflow([lenderChargeBillingTransaction(charge())])).toBe(1000);
  });
});

describe("settlement: cash once, no second expense", () => {
  it("counts once in Month Cycle outflow and Dashboard Money Out", () => {
    expect(outflow([settlement(400)])).toBe(400);
    expect(dashboardMoneyOut([settlement(400)])).toBe(400);
  });
  it("is not My Spend", () => {
    expect(spend([settlement(400)])).toBe(0);
  });
  it("billing + a partial settlement + the rest: spend is the billed amount once, cash out is what was paid", () => {
    const real = [settlement(400, 12), settlement(600, 18)];
    expect(spend(withLenderChargeBilling(real, [charge()]))).toBe(1000);
    expect(outflow(real)).toBe(1000);
    expect(dashboardMoneyOut(real)).toBe(1000);
  });
  it("a settlement paid from a card account is liability only until the card is paid (existing card rule)", () => {
    const cardAcc = new Set(["card"]);
    const out = cashFlowThisMonth({ transactions: cashFlowTransactions([settlement(400)].map((t) => ({ ...t, accountId: "card" })), cardAcc), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: NOW });
    expect(out.moneyOut).toBe(0);
  });
});

describe("reversal of an unpaid charge", () => {
  it("leaves no expense and no cash anywhere", () => {
    const reversed = charge({ reversedAt: d(8) });
    expect(spend(withLenderChargeBilling([], [reversed]))).toBe(0);
    expect(outflow([])).toBe(0);
    expect(dashboardMoneyOut([])).toBe(0);
  });
});
