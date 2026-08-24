"use client";

/**
 * Composes the Reports page's real current-period figures from the same
 * ported engines/hooks the Dashboard, Credit Cards, Loans, and EMI pages
 * already use — replaces `lib/mock/reports-data.ts` as the Reports
 * workspace's data source. Nothing here recomputes a domain formula that
 * already lives in an engine; this file only projects/groups already-loaded
 * repository data, mirroring `features/dashboard/hooks/use-dashboard-data.ts`'s
 * style exactly.
 *
 * Known, accepted gaps for this pass (documented, not silently faked — see
 * the task brief this migration was scoped against):
 *  - There is no balance-history/snapshot mechanism anywhere in this codebase
 *    (confirmed by the Dashboard/Accounts/Credit-Cards hooks' own doc
 *    comments), so a real multi-month Net Worth or Cash Flow *trend line*
 *    cannot be computed — `Account.currentBalance` is a live running total,
 *    not derivable retroactively per past month. This hook exposes only the
 *    single real current-value data point for both; the tabs render an
 *    honest "trend requires balance snapshots over time" note instead of a
 *    fabricated history or forecast.
 *  - For the same reason, no "forecast" is exposed — a projection needs a
 *    real trend to project from, which doesn't exist yet.
 *  - `netWorth` is exactly `calculateNetWorth` (sum of every account's
 *    `currentBalance`) — it is NOT reduced by `liabilitiesBreakdown` below.
 *    Credit-card/loan/EMI debt is tracked as a separate, additional
 *    liabilities figure rather than folded into net worth, since no ported
 *    engine defines "net worth minus outstanding debt" — inventing that
 *    combined formula here would violate "no invented calculations".
 *  - `cashFlow` reuses `useCashFlowThisMonth` as-is — EMI/loan-paid-this-month
 *    are real (sourced from installment data); bill-paid-this-month and
 *    money-received-this-month remain honestly 0 pending a bill-occurrence
 *    payment-history data source (see that hook's own doc comment).
 *  - `assetsByAccountType` groups real `Account.currentBalance` by the
 *    model's real `AccountType` (cash/bank/card/wallet/business/other) —
 *    this replaces the mock's fabricated "Bank & Cash / Investments /
 *    Property / Other Assets" categories, which have no backing field
 *    anywhere in the `Account` model.
 *  - `liabilitiesBreakdown` sums three genuinely-computed real balances:
 *    total credit-card outstanding (`useCreditCardTotals`, the exact
 *    `creditCardStanding`/`sharedCreditLimitStanding` engine output, already
 *    deduped for shared limits), total loan outstanding principal
 *    (`useLoanRows`, the exact formula `LoanRepository.editLoanTerms` uses),
 *    and total EMI remaining balance (`useEmiRows`, the exact
 *    `remainingAmount` installment sum). The mock's "Home Loan" vs.
 *    "Personal Loan" split is dropped — nothing in the `Loan` model
 *    distinguishes loan purpose, so that split would be invented.
 *  - `categorySpending`'s `budget` is `null` when no `Budget` document
 *    targets that category — never a fabricated limit. Categories tab must
 *    treat `budget == null` as "no budget set" rather than defaulting to 0.
 *  - `spendingHeatmap` buckets this month's real expense Transactions by
 *    category x day-of-month week-bucket ("1-7"/"8-14"/"15-21"/"22-31"),
 *    the exact bucketing spirit `use-dashboard-data.ts`'s `cashFlow.weeks`
 *    already uses — not a category x weekday grid (that shape needs many
 *    months of data to look meaningful and isn't what's being computed).
 *  - `insights`/trend narrative text are Milestone 12 (AI Insights) and out
 *    of scope, same accepted gap as the Dashboard's `aiInsight` — the tabs
 *    show a clearly-labeled "coming soon" placeholder instead of narrative
 *    text citing specific numbers.
 */

import { useMemo } from "react";
import { useAccounts, useNetWorth } from "@/hooks/use-accounts";
import { useBudgets } from "@/hooks/use-budgets";
import { useCategories } from "@/hooks/use-categories";
import { useCashFlowThisMonth, useTransactions } from "@/hooks/use-transactions";
import { useCreditCardTotals } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import type { Account, AccountType } from "@/lib/models/account";
import type { Budget } from "@/lib/models/budget";
import type { Category } from "@/lib/models/category";
import { effectiveMonth, isTransfer, type Transaction } from "@/lib/models/transaction";

const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  cash: "Cash",
  bank: "Bank",
  card: "Card",
  wallet: "Wallet",
  business: "Business",
  other: "Other",
};

const WEEK_BUCKETS = ["1-7", "8-14", "15-21", "22-31"] as const;

function isThisMonth(date: Date, now: Date): boolean {
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

/** Same day-of-month bucketing `use-dashboard-data.ts`'s `cashFlow.weeks` uses. */
function weekBucketLabel(dayOfMonth: number): (typeof WEEK_BUCKETS)[number] {
  if (dayOfMonth <= 7) return "1-7";
  if (dayOfMonth <= 14) return "8-14";
  if (dayOfMonth <= 21) return "15-21";
  return "22-31";
}

function categoryNameFor(categoryId: string, categories: Category[]): string {
  return categories.find((c) => c.id === categoryId)?.name ?? "Uncategorized";
}

export interface ReportsCategorySpending {
  categoryId: string;
  category: string;
  amount: number;
  /** null when no Budget document targets this category — never a fabricated limit. */
  budget: number | null;
  txns: number;
}

export interface ReportsBreakdownItem {
  name: string;
  value: number;
}

export function useReportsData() {
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: budgets = [], isLoading: budgetsLoading } = useBudgets();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();

  const netWorthAmount = useNetWorth();
  const cashFlowSummary = useCashFlowThisMonth();
  const { totals: creditCardTotals, isLoading: creditCardsLoading } = useCreditCardTotals();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();

  const isLoading =
    accountsLoading ||
    transactionsLoading ||
    budgetsLoading ||
    categoriesLoading ||
    creditCardsLoading ||
    loansLoading ||
    emisLoading;

  const now = useMemo(() => new Date(), []);

  // --- Net Worth (current value only — see module doc comment) ---
  const netWorth = useMemo(() => ({ amount: netWorthAmount }), [netWorthAmount]);

  // --- Cash Flow (this month only, real; weekly buckets mirror the dashboard's exactly) ---
  const cashFlow = useMemo(() => {
    const weekTotals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
      const label = weekBucketLabel(t.dateTime.getDate());
      weekTotals.set(label, (weekTotals.get(label) ?? 0) + t.amount);
    }
    const weeks = WEEK_BUCKETS.map((label) => ({ label, value: weekTotals.get(label) ?? 0 }));
    return {
      income: cashFlowSummary.moneyIn,
      expenses: cashFlowSummary.moneyOut,
      net: cashFlowSummary.net,
      savingsRate: cashFlowSummary.moneyIn > 0 ? (cashFlowSummary.net / cashFlowSummary.moneyIn) * 100 : 0,
      weeks,
    };
  }, [transactions, now, cashFlowSummary]);

  // --- Assets by real Account.type (replaces the mock's fabricated asset categories) ---
  const assetsByAccountType = useMemo<ReportsBreakdownItem[]>(() => {
    const totals = new Map<AccountType, number>();
    for (const a of accounts as Account[]) {
      totals.set(a.type, (totals.get(a.type) ?? 0) + a.currentBalance);
    }
    return Array.from(totals.entries())
      .map(([type, value]) => ({ name: ACCOUNT_TYPE_LABEL[type], value }))
      .filter((row) => row.value !== 0)
      .sort((a, b) => b.value - a.value);
  }, [accounts]);

  // --- Liabilities: real credit-card outstanding + loan outstanding principal + EMI remaining balance ---
  const liabilitiesBreakdown = useMemo<ReportsBreakdownItem[]>(() => {
    const loanTotal = loanRows.reduce((sum, r) => sum + r.outstandingPrincipal, 0);
    const emiTotal = emiRows.reduce((sum, r) => sum + r.remainingBalance, 0);
    return [
      { name: "Credit Cards", value: creditCardTotals.utilized },
      { name: "Loans", value: loanTotal },
      { name: "EMIs", value: emiTotal },
    ].filter((row) => row.value > 0);
  }, [creditCardTotals, loanRows, emiRows]);

  const totalLiabilities = useMemo(
    () => liabilitiesBreakdown.reduce((sum, r) => sum + r.value, 0),
    [liabilitiesBreakdown],
  );

  // --- Category spending: this month's real expense Transactions, grouped by real Category,
  //     joined with a matching Budget when one exists (mirrors use-dashboard-data.ts's expensesByCategory
  //     grouping, extended with a real budget/txn-count join) ---
  const categorySpending = useMemo<ReportsCategorySpending[]>(() => {
    const totals = new Map<string, { amount: number; txns: number }>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
      const row = totals.get(t.categoryId) ?? { amount: 0, txns: 0 };
      row.amount += t.amount;
      row.txns += 1;
      totals.set(t.categoryId, row);
    }

    const budgetByCategoryId = new Map<string, Budget>();
    for (const b of budgets as Budget[]) {
      if (b.categoryId != null) budgetByCategoryId.set(b.categoryId, b);
    }

    return Array.from(totals.entries())
      .map(([categoryId, { amount, txns }]) => {
        // Budget.amount is the limit itself — no period resolution needed to read it;
        // `amount` above is already this calendar month's real category spend.
        const budget = budgetByCategoryId.get(categoryId)?.amount ?? null;
        return { categoryId, category: categoryNameFor(categoryId, categories as Category[]), amount, budget, txns };
      })
      .sort((a, b) => b.amount - a.amount);
  }, [transactions, budgets, categories, now]);

  // --- Spending heatmap: category x day-of-month week-bucket, real this-month expense Transactions ---
  const spendingHeatmap = useMemo(() => {
    const topCategories = categorySpending.slice(0, 5);
    const grid = new Map<string, number[]>();
    for (const row of topCategories) grid.set(row.categoryId, [0, 0, 0, 0]);

    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
      const bucketValues = grid.get(t.categoryId);
      if (!bucketValues) continue;
      const bucketIndex = WEEK_BUCKETS.indexOf(weekBucketLabel(t.dateTime.getDate()));
      bucketValues[bucketIndex] += t.amount;
    }

    return {
      categories: topCategories.map((c) => c.category),
      weeks: [...WEEK_BUCKETS],
      values: topCategories.map((c) => grid.get(c.categoryId) ?? [0, 0, 0, 0]),
    };
  }, [categorySpending, transactions, now]);

  return {
    isLoading,
    netWorth,
    cashFlow,
    assetsByAccountType,
    liabilitiesBreakdown,
    totalLiabilities,
    categorySpending,
    spendingHeatmap,
  };
}

export type ReportsData = ReturnType<typeof useReportsData>;
