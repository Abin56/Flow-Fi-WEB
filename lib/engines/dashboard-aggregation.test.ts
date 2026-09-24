import { describe, expect, it } from "vitest";
import {
  amountFor,
  type DashboardExpense,
  type DashboardStatement,
  type DashboardTransaction,
  type DateRange,
  type DateRangeStrategy,
  type FinancialViewInputs,
} from "./dashboard-aggregation";

/**
 * Regression test for the audit finding: `myExpenses`/`expenseTransactionsInRange`
 * had no equivalent of mobile's `excludeCreditCardAccounts` flag
 * (`expense_calculator_provider.dart`'s `_expenseTransactionsInRange`). Since
 * `combinedExpenses`/`netCashFlow` also add `creditCardPaid` (a card's
 * statement `amountPaid`) as a separate line item, a card purchase counted
 * again inside `myExpenses` double-counted the same real-world spend once it
 * had been paid off — a purchase of ₹500 on a card, once its statement was
 * paid, showed as ₹1000 of spend instead of ₹500. This is exploitable
 * cross-platform since mobile and web share one Firestore project: a
 * statement payment recorded from mobile makes web's dashboard double-count
 * it the next time it loads, even though web itself never wrote the payment.
 */
describe("dashboard-aggregation credit card double-counting", () => {
  const strategy: DateRangeStrategy = { kind: "reportsPeriod", isMonthGranular: true };
  const range: DateRange = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-09-30T23:59:59Z") };

  const cardPurchase: DashboardTransaction = {
    id: "txn-card-purchase",
    type: "expense",
    amount: 500,
    dateTime: new Date("2026-09-05T10:00:00Z"),
    effectiveMonth: new Date("2026-09-01T00:00:00Z"),
    isTransfer: false,
    accountId: "card-account-1",
  };
  const bankExpense: DashboardTransaction = {
    id: "txn-bank-expense",
    type: "expense",
    amount: 200,
    dateTime: new Date("2026-09-06T10:00:00Z"),
    effectiveMonth: new Date("2026-09-01T00:00:00Z"),
    isTransfer: false,
    accountId: "bank-account-1",
  };
  const expenses: DashboardExpense[] = [];
  const statements: DashboardStatement[] = [
    { dueDate: new Date("2026-09-20T00:00:00Z"), amountPaid: 500 },
  ];

  function inputsFor(creditCardAccountIds: ReadonlySet<string>): FinancialViewInputs {
    return {
      transactions: [cardPurchase, bankExpense],
      expenses,
      billOccurrences: [],
      emiInstallments: [],
      loanInstallments: [],
      creditCardStatements: statements,
      creditCardAccountIds,
    };
  }

  it("does not double-count a card purchase once its statement is paid (combinedExpenses)", () => {
    const inputs = inputsFor(new Set(["card-account-1"]));
    // ₹200 bank expense + ₹500 credit card payment = ₹700, NOT ₹500 (purchase) + ₹200 (bank) + ₹500 (payment) = ₹1200.
    expect(amountFor("combinedExpenses", strategy, range, inputs)).toBe(700);
  });

  it("does not double-count in netCashFlow either", () => {
    const inputs = inputsFor(new Set(["card-account-1"]));
    const income = amountFor("income", strategy, range, inputs);
    expect(income - amountFor("netCashFlow", strategy, range, inputs)).toBe(700);
  });

  it("still includes the raw card purchase in the standalone myExpenses module (mirrors mobile default)", () => {
    // Mirrors mobile: only combinedExpenses/netCashFlow pass excludeCreditCardAccounts;
    // the standalone "My Expenses" widget shows the purchase on its own date, unpaired
    // with the later statement payment.
    const inputs = inputsFor(new Set());
    expect(amountFor("myExpenses", strategy, range, inputs)).toBe(700);
  });

  it("falls back to no exclusion when creditCardAccountIds is empty (would double-count)", () => {
    const inputs = inputsFor(new Set());
    // Without exclusion, combinedExpenses would incorrectly sum to 1200 (500 + 200 + 500).
    expect(amountFor("combinedExpenses", strategy, range, inputs)).toBe(1200);
  });
});
