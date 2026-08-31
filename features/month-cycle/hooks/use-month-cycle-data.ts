"use client";

/**
 * Composes the Month Cycle page's real data entirely from already-ported
 * feature hooks/engines — this file invents no new math. Every figure below
 * is either read straight from an existing aggregate hook
 * (`usePeopleStats`, `useCreditCardTotals`, `useAccountsStats`), a direct
 * filter/group-by over an existing feature's row hook (`useEmiRows`,
 * `useLoanRows`, `usePeopleRows`, `useBillRows`, `useAllCreditCardStatements`,
 * `useTransactions`), or the ported `resolveFinancialView`/`computeBudgetInsight`
 * engines (`lib/engines/dashboard-aggregation.ts`, `lib/engines/budget-insight.ts`)
 * — mirroring `features/dashboard/hooks/use-dashboard-data.ts`'s composition
 * style, including its "this month" vs "vs last month" split.
 *
 * "This month" always means the current calendar month (an EMI/loan/
 * statement/bill whose next due date falls in a different month is not
 * counted in the month totals below, even though it may still be "active").
 *
 * Known, accepted gap (documented, not silently faked): `Person`/`LedgerEntry`
 * carry no due-date/reminder concept (see `use-people-data.ts`'s own doc
 * comment), so the People Ledger below shows each person's last activity
 * timestamp instead of a fabricated "due in Xd" countdown.
 */

import { useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useAllCreditCardStatements, useCreditCards } from "@/hooks/use-credit-cards";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useExpenses } from "@/hooks/use-expenses";
import { useAllLoanInstallments } from "@/hooks/use-loans";
import { useBudgets } from "@/hooks/use-budgets";
import { useCategories } from "@/hooks/use-categories";
import { useTransactions } from "@/hooks/use-transactions";
import { useAllBillOccurrences } from "@/features/bills/hooks/use-bill-occurrence-history";
import { useBillRows } from "@/features/bills/hooks/use-bills-data";
import { useAccountsStats } from "@/features/accounts/hooks/use-accounts-data";
import { useCreditCardTotals } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { usePeopleRows, usePeopleStats } from "@/features/people/hooks/use-people-data";
import { useUserPreferences } from "@/features/settings/hooks/use-user-preferences";
import { CycleAnchor } from "@/lib/engines/cycle-engine";
import {
  amountFor,
  percentChange,
  previousRangeFor,
  type DashboardBillOccurrence,
  type DashboardExpense,
  type DashboardInstallment,
  type DashboardStatement,
  type DashboardTransaction,
  type DateRange,
  type DateRangeStrategy,
  type FinancialViewInputs,
} from "@/lib/engines/dashboard-aggregation";
import { computeBudgetInsight, resolveBudgetPeriod } from "@/lib/engines/budget-insight";
import type { Account } from "@/lib/models/account";
import { billOccurrenceRemainingAmount, billOccurrenceStatus, type Bill } from "@/lib/models/bill";
import type { Budget } from "@/lib/models/budget";
import type { Category } from "@/lib/models/category";
import { statementRemainingAmount, statementStatus, type CreditCardProfile, type Statement } from "@/lib/models/credit-card";
import { isSplit, myShare, type Expense } from "@/lib/models/expense";
import { effectiveMonth, isTransfer, type Transaction } from "@/lib/models/transaction";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The user's configured Month Cycle window containing `now` — a plain
 * calendar month when `startDay` is 1 (every existing user's default,
 * unchanged), otherwise the `startDay`-to-`startDay`-minus-a-day-next-month
 * window built on the same `CycleAnchor` engine credit card statement cycles
 * already use (anchored one day early, at `startDay - 1`, since the engine's
 * anchor day is defined as the cycle's *closing* day — anchoring at
 * `startDay - 1` makes `startDay` itself the first day of the next cycle).
 */
function cycleRangeFor(startDay: number, now: Date): { start: Date; end: Date } {
  if (startDay <= 1) {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    };
  }
  const period = new CycleAnchor(startDay - 1).currentCycleFor(now);
  return {
    start: new Date(period.start.getFullYear(), period.start.getMonth(), period.start.getDate()),
    end: new Date(period.end.getFullYear(), period.end.getMonth(), period.end.getDate(), 23, 59, 59, 999),
  };
}

function isInCycle(date: Date, range: { start: Date; end: Date }): boolean {
  return date.getTime() >= range.start.getTime() && date.getTime() <= range.end.getTime();
}

/**
 * The date a transaction should be bucketed under for "this cycle" totals —
 * `effectiveMonth` (collapsed to the 1st of its month) for the legacy
 * calendar-month cycle, matching every pre-existing behavior exactly; a
 * custom mid-month cycle needs the real day instead, or a transaction from
 * the wrong half of either calendar month would leak across the boundary.
 */
function bucketDateFor(t: Transaction, isCustomCycle: boolean): Date {
  return isCustomCycle ? (t.accountingMonth ?? t.dateTime) : effectiveMonth(t);
}

function daysLeftIn(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / MS_PER_DAY);
}

function categoryNameFor(categoryId: string, categories: Category[]): string {
  return categories.find((c) => c.id === categoryId)?.name ?? "Uncategorized";
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { month: "short", day: "2-digit" });
}

function dueInDaysLabel(daysLeft: number): string {
  if (daysLeft < 0) return `${Math.abs(daysLeft)}d overdue`;
  if (daysLeft === 0) return "Due today";
  return `Due in ${daysLeft}d`;
}

function daysSinceLastActivity(activity: { rawDate: Date }[], now: Date): number | null {
  const latest = activity[0]?.rawDate;
  if (!latest) return null;
  return Math.max(0, Math.floor((now.getTime() - latest.getTime()) / MS_PER_DAY));
}

export interface MonthCycleUpcomingItem {
  id: string;
  title: string;
  subtitle: string;
  amount: number;
  dueDate: Date;
  daysLeft: number;
  /** Section-specific due text, e.g. "Due in 5d" (EMI), "Next EMI on 25 Aug" (Loans), "Due on 28 Aug" (Card/Bill). */
  metaLabel: string;
}

export interface MonthCyclePersonItem {
  id: string;
  name: string;
  note: string;
  amount: number;
  /** Days since this person's most recent ledger activity — null when there is no activity to date from
   *  (`Person`/`LedgerEntry` carry no due-date concept, so this is the closest real "since"/"ago" figure). */
  daysSince: number | null;
}

export interface MonthCycleAccountSpend {
  id: string;
  name: string;
  mask: string | null;
  amount: number;
  percentOfTotal: number;
}

/** One expense transaction backing this cycle's "Total Spent"/"My Expenses" figure. */
export interface MonthCycleExpenseRow {
  id: string;
  description: string;
  category: string;
  account: string;
  date: Date;
  /** The transaction's full amount — what counts toward "Combined Expenses". */
  fullAmount: number;
  /** My share only (equals `fullAmount` for a non-split expense) — what counts toward "My Expenses". */
  myAmount: number;
  isSplit: boolean;
}

export function useMonthCycleData() {
  const now = useMemo(() => new Date(), []);
  const { preferences } = useUserPreferences();
  const monthCycleStartDay = preferences.monthCycleStartDay;
  const cycleRange = useMemo(() => cycleRangeFor(monthCycleStartDay, now), [monthCycleStartDay, now]);
  const isCustomCycle = monthCycleStartDay > 1;

  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: creditCards = [], isLoading: creditCardsLoading } = useCreditCards();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { data: emiInstallments = [], isLoading: emiInstallmentsLoading } = useAllEmiInstallments();
  const { data: loanInstallments = [], isLoading: loanInstallmentsLoading } = useAllLoanInstallments();
  const { occurrences: billOccurrences = [], isLoading: billOccurrencesLoading } = useAllBillOccurrences();
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: budgets = [], isLoading: budgetsLoading } = useBudgets();

  const { rows: emiRows, isLoading: emiLoading } = useEmiRows();
  const { rows: loanRows, isLoading: loanLoading } = useLoanRows();
  const { rows: billRows, isLoading: billRowsLoading } = useBillRows();
  const { rows: peopleRows, isLoading: peopleRowsLoading } = usePeopleRows();
  const { stats: peopleStats, isLoading: peopleStatsLoading } = usePeopleStats();
  const { totals: cardTotals, isLoading: cardTotalsLoading } = useCreditCardTotals();
  const { stats: accountsStats, isLoading: accountsStatsLoading } = useAccountsStats();

  const isLoading =
    transactionsLoading ||
    accountsLoading ||
    creditCardsLoading ||
    statementsLoading ||
    emiInstallmentsLoading ||
    loanInstallmentsLoading ||
    billOccurrencesLoading ||
    expensesLoading ||
    categoriesLoading ||
    budgetsLoading ||
    emiLoading ||
    loanLoading ||
    billRowsLoading ||
    peopleRowsLoading ||
    peopleStatsLoading ||
    cardTotalsLoading ||
    accountsStatsLoading;

  const monthRangeLabel = useMemo(() => {
    const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    return `${fmt(cycleRange.start)} – ${fmt(cycleRange.end)}`;
  }, [cycleRange]);
  const monthLabel = useMemo(
    () =>
      isCustomCycle
        ? monthRangeLabel
        : cycleRange.end.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
    [isCustomCycle, monthRangeLabel, cycleRange],
  );
  const daysLeftInMonth = useMemo(() => daysLeftIn(cycleRange.end, now), [cycleRange, now]);

  // --- This month's combined spend / income, and the % change vs last month
  //     (ported `resolveFinancialView`/`amountFor`/`percentChange` from the
  //     Financial View engine — the same figures the Reports feature uses,
  //     not a re-derived formula). ---
  const financialView = useMemo(() => {
    // `isMonthGranular` buckets transactions by `effectiveMonth` (collapsed to the 1st of
    // their calendar month) — correct only for the plain-calendar-month cycle. A custom
    // cycle spans parts of two calendar months, so it must bucket by the transaction's
    // real `dateTime` instead, or spend from the wrong half of either month would leak in.
    const strategy: DateRangeStrategy = { kind: "reportsPeriod", isMonthGranular: !isCustomCycle };
    const range: DateRange = cycleRange;
    const previousRange = previousRangeFor(strategy, range)!;

    const dashboardTransactions: DashboardTransaction[] = (transactions as Transaction[]).map((t) => ({
      id: t.id,
      type: t.type === "income" ? "income" : "expense",
      amount: t.amount,
      dateTime: t.dateTime,
      effectiveMonth: effectiveMonth(t),
      isTransfer: isTransfer(t),
    }));
    const dashboardExpenses: DashboardExpense[] = (expenses as Expense[]).map((e) => ({
      transactionId: e.transactionId,
      totalAmount: e.totalAmount,
      isSplit: isSplit(e),
      myShare: myShare(e),
    }));
    const dashboardBillOccurrences: DashboardBillOccurrence[] = billOccurrences.map((o) => ({
      dueDate: o.dueDate,
      amountPaid: o.amountPaid,
    }));
    const dashboardEmiInstallments: DashboardInstallment[] = emiInstallments.map((i) => ({
      dueDate: i.dueDate,
      amountPaid: i.amountPaid,
    }));
    const dashboardLoanInstallments: DashboardInstallment[] = loanInstallments.map((i) => ({
      dueDate: i.dueDate,
      amountPaid: i.amountPaid,
    }));
    const dashboardStatements: DashboardStatement[] = (statements as Statement[]).map((s) => ({
      dueDate: s.dueDate,
      amountPaid: s.amountPaid,
    }));

    const inputs: FinancialViewInputs = {
      transactions: dashboardTransactions,
      expenses: dashboardExpenses,
      billOccurrences: dashboardBillOccurrences,
      emiInstallments: dashboardEmiInstallments,
      loanInstallments: dashboardLoanInstallments,
      creditCardStatements: dashboardStatements,
    };

    const spent = amountFor("combinedExpenses", strategy, range, inputs);
    const previousSpent = amountFor("combinedExpenses", strategy, previousRange, inputs);
    const income = amountFor("income", strategy, range, inputs);
    const net = income - spent;
    const spentChangePercent = percentChange(spent, previousSpent);

    // "My Expenses" — my own share only (excludes what a split expense's other participants owe),
    // the same `myExpenses` module `combinedExpenses` itself is built from. Computed alongside
    // `spent` so the Month Cycle hero can offer both views without a second data pass.
    const mySpent = amountFor("myExpenses", strategy, range, inputs);
    const myPreviousSpent = amountFor("myExpenses", strategy, previousRange, inputs);
    const myNet = income - mySpent;
    const mySpentChangePercent = percentChange(mySpent, myPreviousSpent);

    return { spent, previousSpent, income, net, spentChangePercent, mySpent, myPreviousSpent, myNet, mySpentChangePercent };
  }, [isCustomCycle, cycleRange, transactions, expenses, billOccurrences, emiInstallments, loanInstallments, statements]);

  const savingsRatePercent = financialView.income > 0 ? Math.round((financialView.net / financialView.income) * 100) : 0;

  // --- The actual transactions behind `financialView.spent`/`mySpent` — same expense-in-range
  //     filter and Expense join `myExpenses()`/`combinedExpenses()` sum over, projected to rows
  //     so the hero's "Total Spent"/"My Expenses" figure can be drilled into. ---
  const expenseRows = useMemo(() => {
    const accountById = new Map((accounts as Account[]).map((a) => [a.id, a]));
    const expenseByTransactionId = new Map((expenses as Expense[]).map((e) => [e.transactionId, e]));

    const rows: MonthCycleExpenseRow[] = [];
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      if (!isInCycle(bucketDateFor(t, isCustomCycle), cycleRange)) continue;

      const expense = expenseByTransactionId.get(t.id);
      const split = expense != null && isSplit(expense);
      const account = accountById.get(t.accountId);
      rows.push({
        id: t.id,
        description: t.description || categoryNameFor(t.categoryId, categories as Category[]),
        category: categoryNameFor(t.categoryId, categories as Category[]),
        account: account?.name ?? "Unknown Account",
        date: t.dateTime,
        fullAmount: t.amount,
        myAmount: expense ? myShare(expense) : t.amount,
        isSplit: split,
      });
    }
    rows.sort((a, b) => b.date.getTime() - a.date.getTime());
    return rows;
  }, [transactions, expenses, accounts, categories, cycleRange, isCustomCycle]);

  // --- Overall monthly budget (categoryId == null, type == "monthly") ---
  const budgetOverview = useMemo(() => {
    const overall = (budgets as Budget[]).find((b) => b.type === "monthly" && b.categoryId == null);
    if (!overall) return null;
    const period = resolveBudgetPeriod({ type: overall.type, categoryId: overall.categoryId }, now);
    const insight = computeBudgetInsight({
      limit: overall.amount,
      spent: financialView.spent,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      now,
    });
    return insight;
  }, [budgets, financialView.spent, now]);

  // --- EMIs due this month (active/overdue only, next installment due in the current calendar month) ---
  const emiThisMonth = useMemo(() => {
    const items: MonthCycleUpcomingItem[] = [];
    let total = 0;
    for (const row of emiRows) {
      if (row.status === "closed" || row.status === "completed") continue;
      const due = row.nextInstallment?.dueDate;
      if (!due || !isInCycle(due, cycleRange)) continue;
      const amount = row.nextInstallment ? row.nextInstallment.amountDue - row.nextInstallment.amountPaid : 0;
      total += amount;
      items.push({
        id: row.emi.id,
        title: row.emi.name,
        subtitle: row.emi.lenderName ?? "EMI",
        amount,
        dueDate: due,
        daysLeft: daysLeftIn(due, now),
        metaLabel: dueInDaysLabel(daysLeftIn(due, now)),
      });
    }
    items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    return { items, total, count: items.length };
  }, [emiRows, now, cycleRange]);

  // --- Loan installments due this month ---
  const loansThisMonth = useMemo(() => {
    const items: MonthCycleUpcomingItem[] = [];
    let total = 0;
    for (const row of loanRows) {
      if (row.status === "closed") continue;
      if (!row.nextDueDate || !isInCycle(row.nextDueDate, cycleRange)) continue;
      total += row.emiAmount;
      items.push({
        id: row.loan.id,
        title: row.loan.name ?? row.lenderName,
        subtitle: row.lenderName,
        amount: row.emiAmount,
        dueDate: row.nextDueDate,
        daysLeft: daysLeftIn(row.nextDueDate, now),
        metaLabel: `Next EMI on ${formatShortDate(row.nextDueDate)}`,
      });
    }
    items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    return { items, total, count: items.length };
  }, [loanRows, now, cycleRange]);

  // --- Credit card statements due this month, unpaid ---
  const cardsThisMonth = useMemo(() => {
    const cardById = new Map((creditCards as CreditCardProfile[]).map((c) => [c.id, c]));
    const items: MonthCycleUpcomingItem[] = [];
    let total = 0;
    for (const statement of statements as Statement[]) {
      if (statementStatus(statement) === "paid") continue;
      if (!isInCycle(statement.dueDate, cycleRange)) continue;
      const remaining = statementRemainingAmount(statement);
      total += remaining;
      const card = cardById.get(statement.cardId);
      items.push({
        id: statement.id,
        title: card ? `Card •••• ${card.lastFourDigits ?? ""}` : "Credit Card",
        subtitle: "Statement due",
        amount: remaining,
        dueDate: statement.dueDate,
        daysLeft: daysLeftIn(statement.dueDate, now),
        metaLabel: `Due on ${formatShortDate(statement.dueDate)}`,
      });
    }
    items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    return { items, total, count: items.length };
  }, [creditCards, statements, now, cycleRange]);

  // --- Bills & reminders due this month, unpaid ---
  const billsThisMonth = useMemo(() => {
    const items: MonthCycleUpcomingItem[] = [];
    let total = 0;
    for (const row of billRows) {
      const occurrence = row.occurrence;
      if (!occurrence) continue;
      const status = billOccurrenceStatus(occurrence, now);
      if (status === "paid" || status === "skipped") continue;
      if (!isInCycle(occurrence.dueDate, cycleRange)) continue;
      const remaining = billOccurrenceRemainingAmount(occurrence);
      total += remaining;
      items.push({
        id: (row.bill as Bill).id,
        title: row.bill.name,
        subtitle: row.category?.name ?? "Bill",
        amount: remaining,
        dueDate: occurrence.dueDate,
        daysLeft: daysLeftIn(occurrence.dueDate, now),
        metaLabel: `Due on ${formatShortDate(occurrence.dueDate)}`,
      });
    }
    items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    return { items, total, count: items.length };
  }, [billRows, now, cycleRange]);

  // --- People: who you need to give money to / whose handover to you is pending ---
  const peopleYouNeedToGive = useMemo(() => {
    return peopleRows
      .filter((p) => p.youOwe > 0)
      .sort((a, b) => b.youOwe - a.youOwe)
      .slice(0, 6)
      .map((p) => ({
        id: p.id,
        name: p.name,
        note: p.notes || p.activity[0]?.description || "",
        amount: p.youOwe,
        daysSince: daysSinceLastActivity(p.activity, now),
      }));
  }, [peopleRows, now]);

  const peopleHandoverPending = useMemo(() => {
    return peopleRows
      .filter((p) => p.youAreOwed > 0)
      .sort((a, b) => b.youAreOwed - a.youAreOwed)
      .slice(0, 6)
      .map((p) => ({
        id: p.id,
        name: p.name,
        note: p.notes || p.activity[0]?.description || "",
        amount: p.youAreOwed,
        daysSince: daysSinceLastActivity(p.activity, now),
      }));
  }, [peopleRows, now]);

  // --- Account spend this month (direct Transaction field reads, grouped by account) ---
  const accountSpends = useMemo(() => {
    const accountById = new Map((accounts as Account[]).map((a) => [a.id, a]));
    const totals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      if (!isInCycle(bucketDateFor(t, isCustomCycle), cycleRange)) continue;
      totals.set(t.accountId, (totals.get(t.accountId) ?? 0) + t.amount);
    }
    const grandTotal = Array.from(totals.values()).reduce((sum, v) => sum + v, 0);
    const rows: MonthCycleAccountSpend[] = Array.from(totals.entries())
      .map(([accountId, amount]) => {
        const account = accountById.get(accountId);
        return {
          id: accountId,
          name: account?.name ?? "Unknown Account",
          mask: account?.accountNumberLast4 ?? null,
          amount,
          percentOfTotal: grandTotal > 0 ? Math.round((amount / grandTotal) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);
    return rows;
  }, [transactions, accounts, cycleRange, isCustomCycle]);

  // --- Month summary at a glance ---
  const monthSummary = useMemo(() => {
    const accountById = new Map((accounts as Account[]).map((a) => [a.id, a]));

    const categoryTotals = new Map<string, number>();
    let transactionCount = 0;
    const txnCountByAccount = new Map<string, number>();

    for (const t of transactions as Transaction[]) {
      if (t.deletedAt != null || isTransfer(t)) continue;
      if (!isInCycle(bucketDateFor(t, isCustomCycle), cycleRange)) continue;
      transactionCount += 1;
      txnCountByAccount.set(t.accountId, (txnCountByAccount.get(t.accountId) ?? 0) + 1);
      if (t.type === "expense") {
        const name = categoryNameFor(t.categoryId, categories as Category[]);
        categoryTotals.set(name, (categoryTotals.get(name) ?? 0) + t.amount);
      }
    }

    const totalExpense = Array.from(categoryTotals.values()).reduce((sum, v) => sum + v, 0);
    const topCategory = Array.from(categoryTotals.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;

    const topAccountEntry = Array.from(txnCountByAccount.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
    const topAccount = topAccountEntry ? accountById.get(topAccountEntry[0]) : undefined;
    const topAccountSpend = topAccountEntry ? (accountSpends.find((a) => a.id === topAccountEntry[0])?.amount ?? 0) : 0;

    const cycleLengthDays = Math.round((cycleRange.end.getTime() - cycleRange.start.getTime()) / MS_PER_DAY) + 1;
    const daysElapsed = Math.min(cycleLengthDays, Math.floor((now.getTime() - cycleRange.start.getTime()) / MS_PER_DAY) + 1);
    const avgDailySpend = daysElapsed > 0 ? financialView.spent / daysElapsed : 0;

    const pendingActionsCount = emiThisMonth.count + loansThisMonth.count + cardsThisMonth.count + billsThisMonth.count;

    return {
      highestSpendCategory: topCategory ? { name: topCategory[0], amount: topCategory[1], percentOfTotal: totalExpense > 0 ? Math.round((topCategory[1] / totalExpense) * 1000) / 10 : 0 } : null,
      mostUsedAccount: topAccount ? { name: topAccount.name, transactionCount: topAccountEntry![1], amount: topAccountSpend } : null,
      totalTransactions: transactionCount,
      avgDailySpend,
      pendingActionsCount,
    };
  }, [
    transactions,
    categories,
    accounts,
    accountSpends,
    now,
    cycleRange,
    isCustomCycle,
    financialView.spent,
    emiThisMonth.count,
    loansThisMonth.count,
    cardsThisMonth.count,
    billsThisMonth.count,
  ]);

  return {
    isLoading,
    now,
    monthLabel,
    monthRangeLabel,
    daysLeftInMonth,
    isCustomCycle,
    monthCycleStartDay,
    financialView,
    savingsRatePercent,
    expenseRows,
    budgetOverview,
    emi: emiThisMonth,
    loans: loansThisMonth,
    cards: cardsThisMonth,
    bills: billsThisMonth,
    cardTotals,
    peopleStats,
    peopleYouNeedToGive,
    peopleHandoverPending,
    accountSpends,
    accountsStats,
    monthSummary,
  };
}
