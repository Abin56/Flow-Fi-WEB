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

function isThisMonth(date: Date, now: Date): boolean {
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
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

export function useMonthCycleData() {
  const now = useMemo(() => new Date(), []);

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

  const monthLabel = useMemo(() => now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }), [now]);
  const monthRangeLabel = useMemo(() => {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    return `${fmt(start)} – ${fmt(end)}`;
  }, [now]);
  const daysLeftInMonth = useMemo(() => {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return daysLeftIn(lastDay, now);
  }, [now]);

  // --- This month's combined spend / income, and the % change vs last month
  //     (ported `resolveFinancialView`/`amountFor`/`percentChange` from the
  //     Financial View engine — the same figures the Reports feature uses,
  //     not a re-derived formula). ---
  const financialView = useMemo(() => {
    const strategy: DateRangeStrategy = { kind: "reportsPeriod", isMonthGranular: true };
    const range: DateRange = {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    };
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

    return { spent, previousSpent, income, net, spentChangePercent };
  }, [now, transactions, expenses, billOccurrences, emiInstallments, loanInstallments, statements]);

  const savingsRatePercent = financialView.income > 0 ? Math.round((financialView.net / financialView.income) * 100) : 0;

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
      if (!due || !isThisMonth(due, now)) continue;
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
  }, [emiRows, now]);

  // --- Loan installments due this month ---
  const loansThisMonth = useMemo(() => {
    const items: MonthCycleUpcomingItem[] = [];
    let total = 0;
    for (const row of loanRows) {
      if (row.status === "closed") continue;
      if (!row.nextDueDate || !isThisMonth(row.nextDueDate, now)) continue;
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
  }, [loanRows, now]);

  // --- Credit card statements due this month, unpaid ---
  const cardsThisMonth = useMemo(() => {
    const cardById = new Map((creditCards as CreditCardProfile[]).map((c) => [c.id, c]));
    const items: MonthCycleUpcomingItem[] = [];
    let total = 0;
    for (const statement of statements as Statement[]) {
      if (statementStatus(statement) === "paid") continue;
      if (!isThisMonth(statement.dueDate, now)) continue;
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
  }, [creditCards, statements, now]);

  // --- Bills & reminders due this month, unpaid ---
  const billsThisMonth = useMemo(() => {
    const items: MonthCycleUpcomingItem[] = [];
    let total = 0;
    for (const row of billRows) {
      const occurrence = row.occurrence;
      if (!occurrence) continue;
      const status = billOccurrenceStatus(occurrence, now);
      if (status === "paid" || status === "skipped") continue;
      if (!isThisMonth(occurrence.dueDate, now)) continue;
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
  }, [billRows, now]);

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
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
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
  }, [transactions, accounts, now]);

  // --- Month summary at a glance ---
  const monthSummary = useMemo(() => {
    const accountById = new Map((accounts as Account[]).map((a) => [a.id, a]));

    const categoryTotals = new Map<string, number>();
    let transactionCount = 0;
    const txnCountByAccount = new Map<string, number>();

    for (const t of transactions as Transaction[]) {
      if (t.deletedAt != null || isTransfer(t)) continue;
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
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

    const daysElapsed = Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
    const avgDailySpend = daysElapsed > 0 ? financialView.spent / daysElapsed : 0;

    const pendingActionsCount = emiThisMonth.count + loansThisMonth.count + cardsThisMonth.count + billsThisMonth.count;

    return {
      highestSpendCategory: topCategory ? { name: topCategory[0], amount: topCategory[1], percentOfTotal: totalExpense > 0 ? Math.round((topCategory[1] / totalExpense) * 1000) / 10 : 0 } : null,
      mostUsedAccount: topAccount ? { name: topAccount.name, transactionCount: topAccountEntry![1], amount: topAccountSpend } : null,
      totalTransactions: transactionCount,
      avgDailySpend,
      pendingActionsCount,
    };
  }, [transactions, categories, accounts, accountSpends, now, financialView.spent, emiThisMonth.count, loansThisMonth.count, cardsThisMonth.count, billsThisMonth.count]);

  return {
    isLoading,
    now,
    monthLabel,
    monthRangeLabel,
    daysLeftInMonth,
    financialView,
    savingsRatePercent,
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
