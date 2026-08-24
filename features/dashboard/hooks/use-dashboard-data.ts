"use client";

/**
 * Composes the dashboard page's real data from the already-ported engines
 * and live Firestore-backed hooks — replaces `lib/mock/dashboard-data.ts` as
 * the dashboard's data source. Every figure below either comes straight out
 * of a ported engine function or is a direct field read/group-by over a
 * repository's data (grouping/sorting/date-labeling is not "business logic"
 * in the Flutter sense, so it's done here rather than in an engine file).
 *
 * Known, accepted gaps for this pass (not silently faked — called out here
 * instead of a TODO):
 *  - `financialHealth` (the 0-100 score on the hero card) has no ported
 *    engine or Flutter provider anywhere in this codebase yet, so it stays
 *    on `lib/mock/dashboard-data.ts` untouched — fabricating a score would
 *    violate "no invented calculations".
 *  - `aiInsight` is Milestone 12 (AI Insights) and out of scope — untouched.
 *  - Net worth's `changeAmount`/`changePercent` ("this month") need a
 *    month-old net-worth snapshot; no such history is stored anywhere yet
 *    (accounts only track `currentBalance`, not a balance history), so both
 *    are reported as 0 rather than invented.
 *  - `accountsOverview.changeThisMonth` has the same gap, same reason.
 *  - The "Needs Your Attention" row only surfaces bill/budget alerts — EMI
 *    and Savings-Goal repositories weren't in this pass's scope (only
 *    Budget/Bill/Category were named), so those two alert types are omitted
 *    rather than shown with fake data.
 *  - `combinedExpenses`-style split-expense shares (Expense records) aren't
 *    joined in anywhere below — every expense figure here is a plain
 *    Transaction total, per this task's explicit instruction to use what's
 *    available now rather than fake the Expense join.
 */

import { useMemo } from "react";
import { useAccounts, useNetWorth } from "@/hooks/use-accounts";
import { useBills } from "@/hooks/use-bills";
import { useBudgets } from "@/hooks/use-budgets";
import { useCategories } from "@/hooks/use-categories";
import {
  useAllCreditCardStatements,
  useAllEmiPaymentBreakdowns,
  useCreditCards,
  useEmis,
  useSharedCreditLimits,
} from "@/hooks/use-credit-cards";
import { useCashFlowThisMonth, useTransactions } from "@/hooks/use-transactions";
import { computeBudgetInsight, resolveBudgetPeriod } from "@/lib/engines/budget-insight";
import {
  creditCardStanding,
  creditUtilizationPercent,
  sharedCreditLimitStanding,
  type UtilizationCard,
  type UtilizationEmi,
  type UtilizationStatement,
} from "@/lib/engines/credit-utilization";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Budget } from "@/lib/models/budget";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import { statementRemainingAmount, statementStatus } from "@/lib/models/credit-card";
import type { Emi, EmiPaymentBreakdown } from "@/lib/models/emi";
import { effectiveMonth, isTransfer, signedAmount, type Transaction } from "@/lib/models/transaction";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ACCOUNT_ACCENTS = ["primary", "warning", "success", "info"] as const;
type AccountAccent = (typeof ACCOUNT_ACCENTS)[number];

const CATEGORY_COLORS = ["purple", "pink", "warning", "info", "success"] as const;
type CategoryColor = (typeof CATEGORY_COLORS)[number] | "muted";

function isThisMonth(date: Date, now: Date): boolean {
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

/** Day-of-month week buckets matching the reference design's "1-7 / 8-14 / 15-21 / 22-31" bars. */
function weekBucketLabel(dayOfMonth: number): string {
  if (dayOfMonth <= 7) return "1-7";
  if (dayOfMonth <= 14) return "8-14";
  if (dayOfMonth <= 21) return "15-21";
  return "22-31";
}

function formatShortDate(date: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / MS_PER_DAY);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" });
}

function categoryNameFor(categoryId: string, categories: Category[]): string {
  return categories.find((c) => c.id === categoryId)?.name ?? "Uncategorized";
}

export interface DashboardNeedsAttentionItem {
  id: string;
  type: "bill" | "budget";
  title: string;
  subtitle: string;
  amount: number;
  note: string;
  cta: string;
}

export function useDashboardData() {
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: budgets = [], isLoading: budgetsLoading } = useBudgets();
  const { data: bills = [], isLoading: billsLoading } = useBills();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: creditCards = [], isLoading: creditCardsLoading } = useCreditCards();
  const { data: sharedLimits = [], isLoading: sharedLimitsLoading } = useSharedCreditLimits();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: emiPaymentBreakdowns = [], isLoading: emiBreakdownsLoading } = useAllEmiPaymentBreakdowns();

  const netWorthAmount = useNetWorth();
  const cashFlowSummary = useCashFlowThisMonth();

  const isLoading =
    accountsLoading ||
    transactionsLoading ||
    budgetsLoading ||
    billsLoading ||
    categoriesLoading ||
    creditCardsLoading ||
    sharedLimitsLoading ||
    statementsLoading ||
    emisLoading ||
    emiBreakdownsLoading;

  const now = useMemo(() => new Date(), []);

  // --- Net Worth (lib/engines/net-worth.ts:calculateNetWorth via useNetWorth) ---
  const netWorth = useMemo(
    () => ({ amount: netWorthAmount, changeAmount: 0, changePercent: 0 }),
    [netWorthAmount],
  );

  // --- Cash Flow (lib/engines/cash-flow.ts:cashFlowThisMonth via useCashFlowThisMonth) ---
  const cashFlow = useMemo(() => {
    const weekTotals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
      const label = weekBucketLabel(t.dateTime.getDate());
      const delta = signedAmount(t);
      weekTotals.set(label, (weekTotals.get(label) ?? 0) + delta);
    }
    const weeks = ["1-7", "8-14", "15-21", "22-31"].map((label) => ({
      label,
      value: weekTotals.get(label) ?? 0,
    }));
    return {
      income: cashFlowSummary.moneyIn,
      expenses: cashFlowSummary.moneyOut,
      net: cashFlowSummary.net,
      weeks,
    };
  }, [transactions, now, cashFlowSummary]);

  // --- Accounts Overview (direct Account field reads + calculateNetWorth) ---
  const accountsOverview = useMemo(() => {
    const list = accounts as Account[];
    return {
      totalBalance: netWorthAmount,
      changeThisMonth: 0,
      accounts: list.map((account, index) => ({
        id: account.id,
        name: account.name,
        mask: account.accountNumberLast4,
        balance: account.currentBalance,
        accent: ACCOUNT_ACCENTS[index % ACCOUNT_ACCENTS.length] as AccountAccent,
      })),
    };
  }, [accounts, netWorthAmount]);

  // --- Expenses by Category (direct Transaction/Category field reads + grouping) ---
  const expensesByCategory = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
      const name = categoryNameFor(t.categoryId, categories as Category[]);
      totals.set(name, (totals.get(name) ?? 0) + t.amount);
    }
    const sorted = Array.from(totals.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);

    const top = sorted.slice(0, 5);
    const rest = sorted.slice(5);
    const restTotal = rest.reduce((sum, r) => sum + r.amount, 0);

    const total = sorted.reduce((sum, r) => sum + r.amount, 0);
    const pct = (amount: number) => (total === 0 ? 0 : Math.round((amount / total) * 100));

    const items: { category: string; amount: number; percent: number; color: CategoryColor }[] = top.map(
      (row, index) => ({
        category: row.category,
        amount: row.amount,
        percent: pct(row.amount),
        color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
      }),
    );
    if (restTotal > 0) {
      items.push({ category: "Others", amount: restTotal, percent: pct(restTotal), color: "muted" });
    }

    return { total, items };
  }, [transactions, categories, now]);

  // --- Budgets Overview (lib/engines/budget-insight.ts:resolveBudgetPeriod/computeBudgetInsight) ---
  const budgetsOverview = useMemo(() => {
    const budgetList = budgets as Budget[];
    const overall = budgetList.find((b) => b.type === "monthly" && b.categoryId == null);

    const spentInPeriod = (categoryId: string | null, periodStart: Date, periodEnd: Date) =>
      (transactions as Transaction[])
        .filter(
          (t) =>
            t.type === "expense" &&
            !isTransfer(t) &&
            t.deletedAt == null &&
            (categoryId == null || t.categoryId === categoryId) &&
            t.dateTime.getTime() >= periodStart.getTime() &&
            t.dateTime.getTime() <= periodEnd.getTime(),
        )
        .reduce((sum, t) => sum + t.amount, 0);

    let monthlyBudget = 0;
    let spent = 0;
    if (overall) {
      const period = resolveBudgetPeriod({ type: overall.type, categoryId: overall.categoryId }, now);
      spent = spentInPeriod(null, period.periodStart, period.periodEnd);
      monthlyBudget = overall.amount;
    }

    const categoryBudgets = budgetList.filter((b) => b.categoryId != null);
    const categoryRows = categoryBudgets.map((budget) => {
      const period = resolveBudgetPeriod({ type: budget.type, categoryId: budget.categoryId }, now);
      const categorySpent = spentInPeriod(budget.categoryId, period.periodStart, period.periodEnd);
      const insight = computeBudgetInsight({
        limit: budget.amount,
        spent: categorySpent,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        now,
      });
      return {
        id: budget.id,
        category: categoryNameFor(budget.categoryId as string, categories as Category[]),
        spent: insight.spent,
        limit: insight.limit,
        alertLevel: insight.alertLevel,
      };
    });

    return { monthlyBudget, spent, categories: categoryRows };
  }, [budgets, transactions, categories, now]);

  // --- Recent Transactions (direct Transaction field reads; signedAmount matches mock's +income/-expense convention) ---
  const recentTransactions = useMemo(() => {
    return (transactions as Transaction[])
      .filter((t) => t.deletedAt == null)
      .slice()
      .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime())
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        merchant: t.description || categoryNameFor(t.categoryId, categories as Category[]),
        category: categoryNameFor(t.categoryId, categories as Category[]),
        date: formatShortDate(t.dateTime, now),
        amount: signedAmount(t),
      }));
  }, [transactions, categories, now]);

  // --- Upcoming Bills (direct Bill.nextDueDate field read — see createBillRepository's doc comment for why
  //     per-occurrence due dates aren't used here) ---
  const upcomingBills = useMemo(() => {
    return (bills as Bill[])
      .slice()
      .sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime())
      .slice(0, 4)
      .map((bill) => {
        const daysLeft = Math.ceil((bill.nextDueDate.getTime() - now.getTime()) / MS_PER_DAY);
        return {
          id: bill.id,
          name: bill.name,
          date: formatLongDate(bill.nextDueDate),
          daysLeft,
        };
      });
  }, [bills, now]);

  // --- Credit Card Utilization (lib/engines/credit-utilization.ts, per active card + shared limits) ---
  const utilization = useMemo(() => {
    const cardList = creditCards as CreditCardProfile[];
    const statementList = statements as Statement[];
    const emiList = emis as Emi[];
    const breakdownList = emiPaymentBreakdowns as EmiPaymentBreakdown[];

    const utilizationEmis: UtilizationEmi[] = emiList.map((emi) => ({
      linkedCreditCardId: emi.linkedCreditCardId,
      isClosed: emi.isClosed,
      principalAmount: emi.principalAmount,
      principalPaid: breakdownList
        .filter((b) => b.scheduleId === emi.scheduleId)
        .reduce((sum, b) => sum + b.principalPaid, 0),
    }));

    const statementsForCard = (cardId: string): UtilizationStatement[] =>
      statementList
        .filter((s) => s.cardId === cardId && statementStatus(s) !== "paid")
        .map((s) => ({
          id: s.id,
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          dueDate: s.dueDate,
          totalAmount: s.totalAmount,
          amountPaid: s.amountPaid,
          remainingAmount: statementRemainingAmount(s),
          isPaid: statementStatus(s) === "paid",
        }));

    const standingFor = (card: CreditCardProfile): { outstanding: number; available: number } => {
      const utilCard: UtilizationCard = {
        id: card.id,
        statementDay: card.statementDay,
        creditLimit: card.creditLimit,
        sharedLimitId: card.sharedLimitId,
      };
      const cardStatements = statementsForCard(card.id);

      if (card.sharedLimitId) {
        const sharedLimit = (sharedLimits as { id: string; creditLimit: number }[]).find(
          (l) => l.id === card.sharedLimitId,
        );
        if (!sharedLimit) return { outstanding: 0, available: card.creditLimit };
        const siblingCards = cardList.filter((c) => c.sharedLimitId === card.sharedLimitId);
        const standing = sharedCreditLimitStanding({
          sharedLimit,
          perCard: siblingCards.map((c) => ({
            card: { id: c.id, statementDay: c.statementDay, creditLimit: c.creditLimit, sharedLimitId: c.sharedLimitId },
            statements: statementsForCard(c.id),
            currentCycleStatement: null,
            emis: utilizationEmis,
          })),
        });
        // Attribute this card's own outstanding share (not the pooled total) for display.
        const ownOutstanding = cardStatements.reduce((sum, s) => sum + s.remainingAmount, 0);
        return { outstanding: ownOutstanding, available: standing.available };
      }

      const standing = creditCardStanding({
        card: utilCard,
        statements: cardStatements,
        currentCycleStatement: null,
        emis: utilizationEmis,
      });
      return { outstanding: standing.outstanding, available: standing.available };
    };

    const activeCards = cardList.filter((c) => c.status === "active");
    const rows = activeCards.map((card) => {
      const { outstanding } = standingFor(card);
      const percent = creditUtilizationPercent(outstanding, card.creditLimit);
      return { id: card.id, name: card.cardHolderName ?? `Card •••• ${card.lastFourDigits ?? ""}`, outstanding, creditLimit: card.creditLimit, percent };
    });

    // Dedupe shared-limit totals: count each shared limit's own creditLimit once, standalone cards individually.
    const seenSharedLimits = new Set<string>();
    let totalOutstanding = 0;
    let totalCreditLimit = 0;
    for (const card of activeCards) {
      const { outstanding } = standingFor(card);
      totalOutstanding += outstanding;
      if (card.sharedLimitId) {
        if (!seenSharedLimits.has(card.sharedLimitId)) {
          seenSharedLimits.add(card.sharedLimitId);
          const sharedLimit = (sharedLimits as { id: string; creditLimit: number }[]).find(
            (l) => l.id === card.sharedLimitId,
          );
          totalCreditLimit += sharedLimit?.creditLimit ?? 0;
        }
      } else {
        totalCreditLimit += card.creditLimit;
      }
    }

    return {
      totalOutstanding,
      totalCreditLimit,
      percent: creditUtilizationPercent(totalOutstanding, totalCreditLimit),
      cards: rows,
    };
  }, [creditCards, sharedLimits, statements, emis, emiPaymentBreakdowns]);

  // --- Upcoming Payments (Bill.nextDueDate + unpaid Statement.dueDate, merged and sorted soonest-first) ---
  const upcomingPayments = useMemo(() => {
    const billItems = (bills as Bill[]).map((bill) => {
      const daysLeft = Math.ceil((bill.nextDueDate.getTime() - now.getTime()) / MS_PER_DAY);
      return {
        id: `bill-${bill.id}`,
        type: "bill" as const,
        title: bill.name,
        subtitle: "Bill",
        amount: bill.amount,
        date: formatLongDate(bill.nextDueDate),
        daysLeft,
        dueDate: bill.nextDueDate,
      };
    });

    const cardById = new Map((creditCards as CreditCardProfile[]).map((c) => [c.id, c]));
    const statementItems = (statements as Statement[])
      .filter((s) => statementStatus(s) !== "paid")
      .map((statement) => {
        const card = cardById.get(statement.cardId);
        const daysLeft = Math.ceil((statement.dueDate.getTime() - now.getTime()) / MS_PER_DAY);
        return {
          id: `statement-${statement.id}`,
          type: "statement" as const,
          title: card ? `Card •••• ${card.lastFourDigits ?? ""}` : "Credit Card",
          subtitle: "Statement",
          amount: statementRemainingAmount(statement),
          date: formatLongDate(statement.dueDate),
          daysLeft,
          dueDate: statement.dueDate,
        };
      });

    return [...billItems, ...statementItems]
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
      .slice(0, 5)
      .map(({ dueDate: _dueDate, ...item }) => item);
  }, [bills, creditCards, statements, now]);

  // --- Needs Your Attention (bill/budget alerts only — see gap note above) ---
  const needsAttention = useMemo(() => {
    const items: DashboardNeedsAttentionItem[] = [];

    const nextBill = upcomingBills[0];
    if (nextBill) {
      items.push({
        id: `attn-bill-${nextBill.id}`,
        type: "bill",
        title: "Upcoming Bill",
        subtitle: nextBill.name,
        amount: (bills as Bill[]).find((b) => b.id === nextBill.id)?.amount ?? 0,
        note: nextBill.daysLeft <= 0 ? "Due today" : `Due in ${nextBill.daysLeft} day${nextBill.daysLeft === 1 ? "" : "s"}`,
        cta: "Pay Now",
      });
    }

    const worstBudget = budgetsOverview.categories
      .filter((c) => c.alertLevel === "over" || c.alertLevel === "at100" || c.alertLevel === "at90")
      .sort((a, b) => b.spent / b.limit - a.spent / a.limit)[0];
    if (worstBudget) {
      const overPercent = Math.round((worstBudget.spent / worstBudget.limit) * 100 - 100);
      items.push({
        id: `attn-budget-${worstBudget.id}`,
        type: "budget",
        title: "Budget Alert",
        subtitle: worstBudget.category,
        amount: worstBudget.spent,
        note: overPercent > 0 ? `${overPercent}% over budget` : "Nearing budget limit",
        cta: "View",
      });
    }

    return items;
  }, [upcomingBills, bills, budgetsOverview]);

  return {
    isLoading,
    netWorth,
    cashFlow,
    accountsOverview,
    expensesByCategory,
    budgetsOverview,
    recentTransactions,
    upcomingBills,
    upcomingPayments,
    utilization,
    needsAttention,
  };
}
