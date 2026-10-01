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
import { liabilityTotals } from "@/lib/engines/loan-balance-sheet";
import { useCardUtilizationEmis } from "@/hooks/use-card-utilization-emis";
import { toLiveUtilizationStatement } from "@/features/credit-cards/hooks/use-credit-cards-data";
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
import {
  creditCardStanding,
  creditUtilizationPercent,
  lockedEmiPrincipalFor,
  sharedCreditLimitStanding,
  type UtilizationCard,
  type UtilizationEmi,
  type UtilizationStatement,
} from "@/lib/engines/credit-utilization";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import { myShare, type Expense } from "@/lib/models/expense";
import { useExpenses } from "@/hooks/use-expenses";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import { statementRemainingAmount, statementStatus } from "@/lib/models/credit-card";
import { unbilledSpendForCard } from "@/lib/repositories/credit-card-repository";
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
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { data: creditCards = [], isLoading: creditCardsLoading } = useCreditCards();
  const { data: sharedLimits = [], isLoading: sharedLimitsLoading } = useSharedCreditLimits();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { isLoading: emisLoading } = useEmis();
  const { isLoading: emiBreakdownsLoading } = useAllEmiPaymentBreakdowns();
  const { utilizationEmis: cardUtilizationEmis, isLoading: cardEmisLoading } = useCardUtilizationEmis();

  // Net Worth adds loan principal to account balances (Decision 6 — see `netWorthWithLoans`).
  const { netWorth: netWorthAmount, sheet: balanceSheet, isLoading: balanceSheetLoading } = useLoanBalanceSheet();
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
    balanceSheetLoading;

  const now = useMemo(() => new Date(), []);

  // Personal-spending figures (category split, budgets) count only MY share of an expense: an
  // expense paid for someone else (split, or fully assigned to a person) is a People receivable,
  // not my consumption. Unlinked transactions count in full.
  const personalAmount = useMemo(() => {
    const byTransactionId = new Map((expenses as Expense[]).filter((e) => e.deletedAt == null).map((e) => [e.transactionId, e]));
    return (t: Transaction) => {
      const expense = byTransactionId.get(t.id);
      return expense ? myShare(expense) : t.amount;
    };
  }, [expenses]);

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
    return {
      amount: netWorthAmount,
      changeAmount: 0,
      changePercent: 0,
      trend,
      assets: netWorthAmount + debt.total,
      debt: debt.total,
      loanDebt: debt.loanDebt,
    };
  }, [netWorthAmount, balanceSheet, accounts, creditCards, transactions, now]);

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
      if (t.type !== "expense" || isNonIncomeExpenseMovement(t) || t.deletedAt != null) continue;
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

  // --- Credit Card Utilization (lib/engines/credit-utilization.ts, per active card + shared limits) ---
  const utilization = useMemo(() => {
    const cardList = creditCards as CreditCardProfile[];
    const statementList = statements as Statement[];

    // Same card-linked EMI inputs (ownership + principal restored) as the Credit Cards page —
    // `useCardUtilizationEmis` — so the two can never disagree about locked EMI principal.
    const utilizationEmis: UtilizationEmi[] = cardUtilizationEmis;

    const transactionsByAccountId = new Map<string, Transaction[]>();
    for (const t of transactions as Transaction[]) {
      if (t.deletedAt != null) continue;
      const list = transactionsByAccountId.get(t.accountId) ?? [];
      list.push(t);
      transactionsByAccountId.set(t.accountId, list);
    }

    // Live statement totals (a deleted/edited transaction inside a closed period leaves the card's
    // liability), unpaid only — same projection as the Credit Cards page.
    const statementsForCard = (cardId: string): UtilizationStatement[] => {
      const card = cardList.find((c) => c.id === cardId);
      const cardTransactions = card ? (transactionsByAccountId.get(card.accountId) ?? []) : [];
      return statementList
        .filter((s) => s.cardId === cardId)
        .map((s) => toLiveUtilizationStatement(s, cardTransactions))
        .filter((s) => !s.isPaid);
    };
    // Unlike `statementsForCard` above (unpaid only, for `outstanding`'s carry-forward), the
    // "billed through" cutoff must consider every statement — a paid one still marks that
    // period's spend as already billed, so it must not be double-counted as unbilled again.
    const currentCycleFor = (card: CreditCardProfile) =>
      unbilledSpendForCard(
        transactionsByAccountId.get(card.accountId) ?? [],
        statementList.filter((s) => s.cardId === card.id),
      );

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
            currentCycleStatement: currentCycleFor(c),
            emis: utilizationEmis,
          })),
        });
        // Attribute this card's own outstanding share (not the pooled total) for display.
        const ownOutstanding = cardStatements.reduce((sum, s) => sum + s.remainingAmount, 0) + currentCycleFor(card).totalAmount;
        return { outstanding: ownOutstanding, available: standing.available };
      }

      const standing = creditCardStanding({
        card: utilCard,
        statements: cardStatements,
        currentCycleStatement: currentCycleFor(card),
        emis: utilizationEmis,
      });
      return { outstanding: standing.outstanding, available: standing.available };
    };

    const activeCards = cardList.filter((c) => c.status === "active");
    const rows = activeCards.map((card) => {
      const { outstanding } = standingFor(card);
      // Utilization is on exposure: statement outstanding + this card's locked EMI principal (Case B/C).
      const percent = creditUtilizationPercent(outstanding + lockedEmiPrincipalFor(utilizationEmis, card.id), card.creditLimit);
      return { id: card.id, name: card.cardHolderName ?? `Card •••• ${card.lastFourDigits ?? ""}`, outstanding, creditLimit: card.creditLimit, percent };
    });

    // Dedupe shared-limit totals: count each shared limit's own creditLimit once, standalone cards individually.
    const seenSharedLimits = new Set<string>();
    let totalOutstanding = 0;
    let totalLockedEmiPrincipal = 0;
    let totalCreditLimit = 0;
    for (const card of activeCards) {
      const { outstanding } = standingFor(card);
      totalOutstanding += outstanding;
      totalLockedEmiPrincipal += lockedEmiPrincipalFor(utilizationEmis, card.id);
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
      percent: creditUtilizationPercent(totalOutstanding + totalLockedEmiPrincipal, totalCreditLimit),
      cards: rows,
    };
  }, [creditCards, sharedLimits, statements, cardUtilizationEmis, transactions]);

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
