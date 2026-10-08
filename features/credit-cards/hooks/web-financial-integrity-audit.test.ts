/**
 * Web Financial Integrity Audit (2026-10-07) — pure-engine reproductions for the calculation findings in
 * `docs/web-financial-integrity-audit.md`.
 *
 * AUDIT PINS: each test asserts CURRENT behaviour. Tests named "PINS BUG" lock in a wrong figure so the
 * finding is proven; when the finding is fixed the pin fails and must be replaced by a regression test of
 * the correct outcome. "PASS" tests lock in behaviour the audit verified as correct.
 *
 * Where a hook does its own inline mapping before calling an engine, the mapping is reproduced here
 * verbatim and cited by file — the engine input types themselves are what make the defect unavoidable.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { cardBillsForCard, cardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { CycleAnchor } from "@/lib/engines/cycle-engine";
import { amountFor, type FinancialViewInputs } from "@/lib/engines/dashboard-aggregation";
import { allocateOwnership, splitByOwnership } from "@/lib/engines/debt-ownership";
import { cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { buildMySpendContext, myConsumptionAmount } from "@/lib/engines/my-spend";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import { computeCreditCardStandings, creditCardTotalsFrom } from "./use-credit-cards-data";

const at = (y: number, m: number, day: number, h = 12, min = 0) => new Date(y, m - 1, day, h, min);
let seq = 0;

function card(overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id: "card-1",
    accountId: "acc-card-1",
    sharedLimitId: null,
    statementDay: 15,
    paymentDueDay: 5,
    creditLimit: 100_000,
    minimumDuePercent: null,
    autoPay: false,
    status: "active",
    cardNetwork: null,
    lastFourDigits: "4242",
    issuer: null,
    annualFee: 0,
    joiningFee: 0,
    interestRatePercent: null,
    rewardNotes: null,
    autoDebitAccount: null,
    cardHolderName: null,
    createdAt: at(2026, 1, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function txn(overrides: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `t-${seq}`,
    type: "expense",
    amount: 100,
    dateTime: at(2026, 8, 16),
    accountId: "acc-card-1",
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: at(2026, 8, 16),
    transferMatchedAt: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    status: "posted",
    isBusiness: false,
    source: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

/** A stored statement exactly as `StatementRepository.materializeIfDue` (and Flutter) writes it: day-precision midnight dates. */
function storedStatement(overrides: Partial<Statement> = {}): Statement {
  return {
    id: "st-aug",
    cardId: "card-1",
    periodStart: new Date(2026, 6, 16),
    periodEnd: new Date(2026, 7, 15),
    generatedDate: new Date(2026, 7, 15),
    dueDate: new Date(2026, 8, 5),
    totalAmount: 1_000,
    minimumDue: null,
    amountPaid: 0,
    interestCharged: null,
    lateFee: null,
    createdAt: new Date(2026, 7, 16),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("Credit card standings (Credit Cards screen, Dashboard utilization, Net Worth lock)", () => {
  it("[WFI-P1-02] FIXED: a purchase on the statement day after 00:00 is billed once, by the stored statement", () => {
    const purchase = txn({ amount: 1_000, dateTime: at(2026, 8, 15, 14, 30) });
    const now = at(2026, 8, 20);
    const [standing] = computeCreditCardStandings({
      cards: [card()],
      sharedLimits: [],
      statements: [storedStatement()],
      transactions: [purchase],
      utilizationEmis: [],
      now,
    });

    // The canonical bill chain (Pay bill / Month Cycle / People gate) owes ₹1,000.
    const scope = cardStatementPaymentScope(cardBillsForCard(card(), [purchase], [storedStatement()], now), now);
    expect(scope.cardOutstanding).toBe(1_000);
    // The standings chain (Credit Cards outstanding / available / utilization, Dashboard utilization) agrees.
    expect(standing.outstanding).toBe(1_000);
    expect(standing.available).toBe(99_000);
    expect(standing.currentCycleSpend).toBe(0);
    // The card account itself says ₹1,000.
    expect(-balanceEffect(purchase)).toBe(1_000);
  });

  it("[WFI-P1-03] FIXED: with no stored statements, 'Spent this month' is this cycle's spend; older cycles stay owed", () => {
    const old = txn({ amount: 1_000, dateTime: at(2026, 7, 1) }); // cycle 16 Jun – 15 Jul, due 5 Aug (overdue)
    const recent = txn({ amount: 200, dateTime: at(2026, 8, 20) }); // open cycle 16 Aug – 15 Sep
    const now = at(2026, 8, 25);
    const standings = computeCreditCardStandings({ cards: [card()], sharedLimits: [], statements: [], transactions: [old, recent], utilizationEmis: [], now });

    const bills = cardBillsForCard(card(), [old, recent], [], now);
    expect(bills.filter((b) => !b.isClosed).reduce((s, b) => s + b.remaining, 0)).toBe(200); // canonical open cycle
    expect(standings[0].currentCycleSpend).toBe(200);
    expect(creditCardTotalsFrom(standings).spentThisMonth).toBe(200); // the "Spent this month" tile
    expect(standings[0].outstanding).toBe(1_200); // the overdue July cycle is still owed
  });

  it("[WFI-P1-04] FIXED: a transfer OUT of a card (card → bank / card → card) is billed like the debt it raised", () => {
    const out = txn({ type: "expense", amount: 5_000, transferId: "x1", dateTime: at(2026, 8, 18) });
    const now = at(2026, 9, 20);
    const scope = cardStatementPaymentScope(cardBillsForCard(card(), [out], [], now), now);
    const [standing] = computeCreditCardStandings({ cards: [card()], sharedLimits: [], statements: [], transactions: [out], utilizationEmis: [], now });

    expect(balanceEffect(out)).toBe(-5_000); // Account.currentBalance → Dashboard card debt & Net Worth: ₹5,000 owed
    expect(scope.cardOutstanding).toBe(5_000); // Pay bill / Month Cycle agree with the account
    expect(standing.outstanding).toBe(5_000); // Credit Cards / utilization agree too
  });

  it("PASS: card credits (refunds) reduce the statement instead of being charged; bill payments settle oldest first", () => {
    const buy = txn({ amount: 1_000, dateTime: at(2026, 8, 1) });
    const refund = txn({ type: "income", amount: 300, dateTime: at(2026, 8, 3) });
    const pay = txn({ type: "income", amount: 500, transferId: "p1", dateTime: at(2026, 8, 20) });
    const now = at(2026, 8, 25);
    const scope = cardStatementPaymentScope(cardBillsForCard(card(), [buy, refund, pay], [], now), now);
    expect(scope.cardOutstanding).toBe(200);
  });
});

const CARD_ACCOUNTS = new Set(["acc-card-1"]);

function monthCycleInputs(transactions: Transaction[], emiInstallments: { dueDate: Date; amountPaid: number }[] = []): FinancialViewInputs {
  return {
    transactions: monthCycleDashboardTransactions(transactions, CARD_ACCOUNTS),
    expenses: [],
    billOccurrences: [],
    emiInstallments,
    loanInstallments: [],
    creditCardStatements: [],
    creditCardAccountIds: new Set<string>(),
  };
}

describe("Month Cycle hero figures (Income / Total outflow)", () => {
  const range = cycleRangeFor(1, at(2026, 10, 7));
  const strategy = { kind: "reportsPeriod" as const, isMonthGranular: true };

  it("[WFI-P1-05] FIXED: 'Don't count this in my totals' transactions are left out of Month Cycle income and total outflow", () => {
    const hiddenIncome = txn({ type: "income", amount: 10_000, accountId: "bank", excludeFromCalculations: true, dateTime: at(2026, 10, 2) });
    const hiddenSpend = txn({ type: "expense", amount: 4_000, accountId: "bank", excludeFromCalculations: true, dateTime: at(2026, 10, 2) });
    const counted = txn({ type: "expense", amount: 250, accountId: "bank", dateTime: at(2026, 10, 2) });
    const inputs = monthCycleInputs([hiddenIncome, hiddenSpend, counted]);
    expect(amountFor("income", strategy, range, inputs)).toBe(0);
    expect(amountFor("combinedExpenses", strategy, range, inputs)).toBe(250);
    // Agrees with My Spend (shared classifier).
    expect(myConsumptionAmount(hiddenSpend, buildMySpendContext({ expenses: [] }))).toBe(0);
  });

  it("[WFI-P1-05] FIXED: trashed transactions never count", () => {
    const trashed = txn({ type: "income", amount: 900, accountId: "bank", deletedAt: at(2026, 10, 3), dateTime: at(2026, 10, 2) });
    expect(amountFor("income", strategy, range, monthCycleInputs([trashed]))).toBe(0);
  });

  it("[WFI-P2-01] FIXED: a refund credited to a CARD is not Month Cycle income; a bank income still is", () => {
    const cardRefund = txn({ type: "income", amount: 700, accountId: "acc-card-1", dateTime: at(2026, 10, 3) });
    const salary = txn({ type: "income", amount: 50_000, accountId: "bank", dateTime: at(2026, 10, 1) });
    expect(amountFor("income", strategy, range, monthCycleInputs([cardRefund, salary]))).toBe(50_000);
  });

  it("[WFI-P1-06] FIXED: a card-linked EMI payment is counted once in Month Cycle total outflow (via emiPaid)", () => {
    const emiOnCard = txn({ amount: 5_000, accountId: "acc-card-1", emiId: "emi-1", paymentAllocationType: "regularEmi", dateTime: at(2026, 10, 5) });
    const inputs = monthCycleInputs([emiOnCard], [{ dueDate: at(2026, 10, 5), amountPaid: 5_000 }]);
    expect(amountFor("combinedExpenses", strategy, range, inputs)).toBe(5_000);
  });
});

describe("Dashboard cash flow (Income / Expenses tiles — `useCashFlowThisMonth`)", () => {
  it("[WFI-P1-05] FIXED: excluded transactions are left out of Dashboard Money In / Money Out", () => {
    const now = at(2026, 10, 7);
    const hidden = txn({ type: "expense", amount: 4_000, accountId: "bank", excludeFromCalculations: true, dateTime: at(2026, 10, 2) });
    const counted = txn({ type: "expense", amount: 300, accountId: "bank", dateTime: at(2026, 10, 2) });
    const summary = cashFlowThisMonth({
      transactions: cashFlowTransactions([hidden, counted], new Set()),
      emiPaidThisMonth: 0,
      loanPaidThisMonth: 0,
      billsPaidThisMonth: 0,
      moneyReceivedThisMonth: 0,
      now,
    });
    expect(summary.moneyOut).toBe(300);
  });
});

describe("Cycle boundaries", () => {
  it("[WFI-P3-01] FIXED: CycleAnchor.currentCycleFor in January starts in the previous December", () => {
    const period = new CycleAnchor(15).currentCycleFor(at(2027, 1, 10));
    expect(period.end).toEqual(new Date(2027, 0, 15));
    expect(period.start).toEqual(new Date(2026, 11, 16));
    expect(period.start.getTime()).toBeLessThan(period.end.getTime());
  });

  it("PASS: Month Cycle window is contiguous and inclusive (start day 18: 18 Sep 00:00 → 17 Oct 23:59:59.999)", () => {
    const r = cycleRangeFor(18, at(2026, 10, 7));
    expect(r.start).toEqual(new Date(2026, 8, 18));
    expect(r.end).toEqual(new Date(2026, 9, 17, 23, 59, 59, 999));
    const next = cycleRangeFor(18, new Date(2026, 9, 18, 0, 0, 0, 0));
    expect(next.start).toEqual(new Date(2026, 9, 18));
  });

  it("PASS: card statement windows close on the statement day (inclusive) and use the card's own cycle", () => {
    const onDay = txn({ amount: 100, dateTime: at(2026, 8, 15, 23, 59) });
    const dayAfter = txn({ amount: 50, dateTime: at(2026, 8, 16, 0, 1) });
    const bills = cardBillsForCard(card(), [onDay, dayAfter], [], at(2026, 8, 20));
    const aug = bills.find((b) => b.periodEnd.getTime() === new Date(2026, 7, 15).getTime())!;
    const sep = bills.find((b) => b.periodEnd.getTime() === new Date(2026, 8, 15).getTime())!;
    expect(aug.totalAmount).toBe(100);
    expect(sep.totalAmount).toBe(50);
    expect(aug.dueDate).toEqual(new Date(2026, 8, 5));
  });
});

describe("Money precision", () => {
  it("[WFI-P3-02] FIXED: an equal split of ₹0.03 across 4 is refused up front instead of writing a ₹0.00 share", () => {
    const split = (total: number) =>
      ExpenseRepository.resolveShares({
        type: "equal",
        total,
        inputs: [{ name: "Me", isMe: true, value: null }, { personId: "a", name: "A", value: null }, { personId: "b", name: "B", value: null }, { personId: "c", name: "C", value: null }],
      }).map((p) => p.share);
    expect(() => split(0.03)).toThrow("too small to split");
    expect(split(0.04)).toEqual([0.01, 0.01, 0.01, 0.01]);
  });

  it("PASS: equal splits of awkward totals reconcile to the paisa (3, 4, 5, 7 people)", () => {
    for (const [total, n] of [[100, 3], [999.99, 4], [1000.01, 5], [0.01, 1], [1234.57, 7]] as const) {
      const inputs = Array.from({ length: n }, (_, i) => ({ personId: `p${i}`, name: `P${i}`, value: null }));
      const shares = ExpenseRepository.resolveShares({ type: "equal", total, inputs }).map((p) => p.share);
      expect(Math.round(shares.reduce((s, v) => s + v, 0) * 100)).toBe(Math.round(total * 100));
    }
  });

  it("PASS: loan/EMI ownership shares split every installment exactly in paise (2–6 parties, odd amounts)", () => {
    for (const parties of [2, 3, 4, 5, 6]) {
      const { shares, error } = allocateOwnership(100_000.01, "equal", Array.from({ length: parties }, (_, i) => ({ personId: i === 0 ? null : `p${i}`, value: 0 })));
      expect(error).toBeNull();
      for (const installment of [3_333.33, 999.99, 0.03, 12_345.67]) {
        const parts = splitByOwnership(installment, shares);
        expect(Math.round(parts.reduce((s, p) => s + p.amount, 0) * 100)).toBe(Math.round(installment * 100));
        expect(parts.every((p) => p.amount >= 0)).toBe(true);
      }
    }
  });
});
