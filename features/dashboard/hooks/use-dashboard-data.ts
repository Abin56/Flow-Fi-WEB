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
 *  - The "Needs Your Attention" row only surfaces bill alerts (Budgets are no longer on the Dashboard) — EMI
 *    and Savings-Goal repositories weren't in this pass's scope (only
 *    Budget/Bill/Category were named), so those two alert types are omitted
 *    rather than shown with fake data.
 *  - `combinedExpenses`-style split-expense shares (Expense records) aren't
 *    joined in anywhere below — every expense figure here is a plain
 *    Transaction total, per this task's explicit instruction to use what's
 *    available now rather than fake the Expense join.
 */

import { useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useLoanBalanceSheet } from "@/hooks/use-loan-balance-sheet";
import { liabilityTotals, netWorthComposition } from "@/lib/engines/loan-balance-sheet";
import { useCardUtilizationEmis } from "@/hooks/use-card-utilization-emis";
import {
  creditCardTotalsFrom,
  useCreditCardStandings,
  type CreditCardStandingView,
} from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useBills } from "@/hooks/use-bills";
import { useCategories } from "@/hooks/use-categories";
import {
  useAllCreditCardStatements,
  useAllEmiPaymentBreakdowns,
  useCreditCards,
  useEmis,
  useSharedCreditLimits,
} from "@/hooks/use-credit-cards";
import { useCashFlowThisMonth, useTransactions } from "@/hooks/use-transactions";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import { useExpenses } from "@/hooks/use-expenses";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import { statementRemainingAmount, statementStatus } from "@/lib/models/credit-card";
import { useMySpendContext } from "@/hooks/use-my-spend-context";
import { myConsumptionAmount } from "@/lib/engines/my-spend";

import { compareTransactionsNewestFirst, effectiveMonth, isLoanPrincipalDisbursement, isNonIncomeExpenseMovement, signedAmount, type Transaction } from "@/lib/models/transaction";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ACCOUNT_ACCENTS = ["primary", "warning", "success", "info"] as const;
type AccountAccent = (typeof ACCOUNT_ACCENTS)[number];

const CATEGORY_COLORS = ["purple", "pink", "warning", "info", "success"] as const;
type CategoryColor = (typeof CATEGORY_COLORS)[number] | "muted";

function isThisMonth(date: Date, now: Date): boolean {
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
  const { data: bills = [], isLoading: billsLoading } = useBills();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { isLoading: expensesLoading } = useExpenses();
  const { data: creditCards = [], isLoading: creditCardsLoading } = useCreditCards();
  const { isLoading: sharedLimitsLoading } = useSharedCreditLimits();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { isLoading: emisLoading } = useEmis();
  const { isLoading: emiBreakdownsLoading } = useAllEmiPaymentBreakdowns();
  const { isLoading: cardEmisLoading } = useCardUtilizationEmis();
  const { standings: cardStandings, isLoading: cardStandingsLoading } = useCreditCardStandings();

  // Net Worth adds loan principal to account balances (Decision 6 — see `netWorthWithLoans`).
  const { netWorth: netWorthAmount, sheet: balanceSheet, peoplePayable, peopleAdvanceHeld, isLoading: balanceSheetLoading } = useLoanBalanceSheet();
  const cashFlowSummary = useCashFlowThisMonth();

  const isLoading =
    accountsLoading ||
    transactionsLoading ||
    billsLoading ||
    categoriesLoading ||
    expensesLoading ||
    creditCardsLoading ||
    sharedLimitsLoading ||
    statementsLoading ||
    emisLoading ||
    emiBreakdownsLoading ||
    cardEmisLoading ||
    cardStandingsLoading ||
    balanceSheetLoading;

  const now = useMemo(() => new Date(), []);

  // Personal-spending figures (category split, budgets) count only MY share of an expense: an
  // expense paid for someone else (split, or fully assigned to a person) is a People receivable,
  // not my consumption. Unlinked transactions count in full.
  // Shared classifier (`lib/engines/my-spend.ts`) — the same answer Month Cycle, Reports and Budgets use.
  const { ctx: mySpendCtx } = useMySpendContext();
  const personalAmount = useMemo(() => (t: Transaction) => myConsumptionAmount(t, mySpendCtx), [mySpendCtx]);

  // --- Net Worth (lib/engines/loan-balance-sheet.ts:netWorthWithLoans via useLoanBalanceSheet) ---
  // `trend`: direct port of `NetWorthWidgetCard._weeklyTrend` (Finance_App's
  // `net_worth_widget_card.dart`) — cumulative net (income - expense) for each
  // of the last 7 days, oldest first, over `calculableTransactions`
  // (excludeFromCalculations filtered, transfers deliberately NOT excluded:
  // a transfer's two legs net to zero across total net worth automatically).
  const netWorth = useMemo(() => {
    const calculable = (transactions as Transaction[]).filter(
      (t) => t.deletedAt == null && !t.excludeFromCalculations && !isLoanPrincipalDisbursement(t),
    );
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let running = 0;
    const trend: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      running += calculable
        .filter((t) => isSameDay(t.dateTime, day))
        .reduce((sum, t) => sum + signedAmount(t), 0);
      trend.push(running);
    }
    // Assets / Debt so borrowing is visible even when Net Worth doesn't move (borrowed money in the bank
    // raises assets and debt together). Debt is the shared `liabilityTotals` (remaining principal, card
    // debt counted once); the card part is the card accounts' own balances — the same figure Net Worth
    // already includes — so Assets − Debt always equals the headline exactly.
    const cardAccountIds = new Set((creditCards as CreditCardProfile[]).map((c) => c.accountId));
    const cardDebt = -(accounts as Account[]).filter((a) => cardAccountIds.has(a.id)).reduce((s, a) => s + a.currentBalance, 0);
    const debt = liabilityTotals(balanceSheet, cardDebt);
    // Money owed to people directly (e.g. borrowed from a person) is a liability Net Worth already
    // subtracts (People direct balance) — counting it here keeps Assets − Debt equal to Net Worth while
    // showing the borrowed cash as an asset and the obligation as debt.
    // Money a person paid me ahead (unapplied advance) is cash I hold — neither debt nor wealth — so it is its
    // own line: Assets − Debt − Held for people = Net Worth (`netWorthComposition`).
    const composition = netWorthComposition(netWorthAmount, debt, { payable: peoplePayable, advanceHeld: peopleAdvanceHeld });
    return {
      amount: netWorthAmount,
      changeAmount: 0,
      changePercent: 0,
      trend,
      assets: composition.assets,
      debt: composition.debt,
      heldForPeople: composition.heldForPeople,
      peopleDebt: peoplePayable,
      loanDebt: debt.loanDebt,
    };
  }, [netWorthAmount, balanceSheet, peoplePayable, peopleAdvanceHeld, accounts, creditCards, transactions, now]);

  // --- Cash Flow (lib/engines/cash-flow.ts:cashFlowThisMonth via useCashFlowThisMonth) ---
  const cashFlow = useMemo(() => {
    // Same cash boundary as `cashFlowThisMonth`: card purchases don't move cash; a transfer
    // paying a card does (counted on its non-card, outgoing leg).
    const cardAccountIds = new Set((creditCards as CreditCardProfile[]).map((c) => c.accountId));
    const cardPaymentTransferIds = new Set(
      (transactions as Transaction[])
        .filter((t) => t.transferId != null && t.type === "income" && cardAccountIds.has(t.accountId))
        .map((t) => t.transferId as string),
    );
    const weekTotals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.deletedAt != null || cardAccountIds.has(t.accountId)) continue;
      const isCardPayment = t.transferId != null && t.type === "expense" && cardPaymentTransferIds.has(t.transferId);
      if (isNonIncomeExpenseMovement(t) && !isCardPayment) continue;
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
  }, [transactions, creditCards, now, cashFlowSummary]);

  // --- Accounts Overview (direct Account field reads + calculateNetWorth) ---
  const accountsOverview = useMemo(() => {
    const list = accounts as Account[];
    // Money actually held: card accounts carry a liability (negative balance), not cash — that
    // liability belongs in Net Worth and Credit Card outstanding, not in "Total balance".
    const cardAccountIds = new Set((creditCards as CreditCardProfile[]).map((c) => c.accountId));
    const cashTotal = list.filter((a) => !cardAccountIds.has(a.id)).reduce((sum, a) => sum + a.currentBalance, 0);
    return {
      totalBalance: cashTotal,
      changeThisMonth: 0,
      accounts: list.map((account, index) => ({
        id: account.id,
        name: account.name,
        bankId: account.bankId,
        mask: account.accountNumberLast4,
        balance: account.currentBalance,
        accent: ACCOUNT_ACCENTS[index % ACCOUNT_ACCENTS.length] as AccountAccent,
      })),
    };
  }, [accounts, creditCards]);

  // --- Expenses by Category (direct Transaction/Category field reads + grouping) ---
  const expensesByCategory = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      const effective = effectiveMonth(t);
      if (!isThisMonth(effective, now)) continue;
      const amount = personalAmount(t);
      if (amount === 0) continue; // fully someone else's — not my spending
      const name = categoryNameFor(t.categoryId, categories as Category[]);
      totals.set(name, (totals.get(name) ?? 0) + amount);
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
  }, [transactions, categories, now, personalAmount]);

  // --- Recent Transactions (direct Transaction field reads; signedAmount matches mock's +income/-expense convention) ---
  const recentTransactions = useMemo(() => {
    return (transactions as Transaction[])
      .filter((t) => t.deletedAt == null)
      .slice()
      .sort(compareTransactionsNewestFirst)
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

  // --- Credit Card Utilization — the SAME standings the Credit Cards page uses (one facility = one row) ---
  const utilization = useMemo(() => {
    // A shared facility is one credit line: one row, its pooled outstanding against its ONE
    // `SharedCreditLimit.creditLimit` (never a per-sibling ₹0 or own limit), counted once in the total.
    const rows: { id: string; name: string; outstanding: number; creditLimit: number; percent: number }[] = [];
    const seenSharedLimitIds = new Set<string>();
    const shown: CreditCardStandingView[] = [];
    for (const s of cardStandings) {
      if (s.sharedLimit != null) {
        const sharedLimitId = s.sharedLimit.id;
        if (seenSharedLimitIds.has(sharedLimitId)) continue;
        const members = cardStandings.filter((m) => m.sharedLimit?.id === sharedLimitId);
        if (!members.some((m) => m.card.status === "active")) continue;
        seenSharedLimitIds.add(sharedLimitId);
        shown.push(s);
        rows.push({
          id: sharedLimitId,
          name: `${s.sharedLimit.name} · shared (${members.length} cards)`,
          outstanding: s.outstanding,
          creditLimit: s.effectiveCreditLimit,
          percent: s.utilizationPercent,
        });
        continue;
      }
      if (s.card.status !== "active") continue;
      shown.push(s);
      rows.push({
        id: s.card.id,
        name: s.card.cardHolderName ?? `Card •••• ${s.card.lastFourDigits ?? ""}`,
        outstanding: s.outstanding,
        creditLimit: s.effectiveCreditLimit,
        percent: s.utilizationPercent,
      });
    }
    const totals = creditCardTotalsFrom(shown);
    return {
      totalOutstanding: totals.utilized,
      totalCreditLimit: totals.creditLimit,
      percent: totals.utilizationPercent,
      cards: rows,
    };
  }, [cardStandings]);

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

  // --- Needs Your Attention (bill alerts only — see gap note above) ---
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

    return items;
  }, [upcomingBills, bills]);

  return {
    isLoading,
    netWorth,
    cashFlow,
    accountsOverview,
    expensesByCategory,
    recentTransactions,
    upcomingBills,
    upcomingPayments,
    utilization,
    needsAttention,
  };
}
