"use client";

/**
 * The ONE data layer behind Reports and Analytics. It subscribes to nothing new: every hook below is a shared,
 * cached live listener the Dashboard / Month Cycle / Net Worth already use (React Query + the shared watch
 * registry), so opening these pages adds no Firestore listeners or reads of their own, and any add / edit / delete /
 * reversal anywhere re-renders them through the same synchronisation path.
 *
 * All money logic is in pure engines: `buildPeriodReportSources` / `periodFigures` / `periodDetail`
 * (`lib/engines/period-report.ts`), the period model (`report-period.ts`), and the walk-back trends
 * (`net-worth-trend.ts`). Current-position figures (Net Worth, liabilities, People) come straight from
 * `useLoanBalanceSheet` / `useCreditCardTotals`, the same as the Dashboard.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useAllEmiPaymentBreakdowns, useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { cardFundedLoanCardId } from "@/lib/engines/credit-utilization";
import { caseAEmis } from "@/lib/engines/cycle-transaction-mapping";
import { useEmiInstallmentPayments } from "@/hooks/use-emi-installment-payments";
import { useExpenseInstallmentsBySchedule, useExpenses } from "@/hooks/use-expenses";
import { useCategories } from "@/hooks/use-categories";
import { useLoanBalanceSheet } from "@/hooks/use-loan-balance-sheet";
import { useLenderCharges } from "@/hooks/use-lender-charges";
import { useLoanScheduledPayments } from "@/hooks/use-loan-scheduled-payments";
import { useMySpendContext } from "@/hooks/use-my-spend-context";
import { useSpendTransactions, withBuiltInChargeCategory } from "@/hooks/use-lender-charge-spend";
import { useTransactions } from "@/hooks/use-transactions";
import { useCreditCardTotals } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { lenderChargeNetWorthEvents } from "@/lib/engines/lender-charge-accounting";
import { liabilityTotals, netWorthComposition } from "@/lib/engines/loan-balance-sheet";
import { accountBalancesAtCutoffs, debtPrincipalEvents, netWorthAtCutoffs, periodEndCutoff, personShareEvents } from "@/lib/engines/net-worth-trend";
import { personEmiObligations } from "@/lib/engines/person-emi-obligations";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import { usePersonPositions } from "@/features/people/hooks/use-people-data";
import { loanCollectionPrincipalByTransaction } from "@/features/reports/lib/loan-collection-principal";
import { buildPeriodReportSources, periodDetail, periodFigures, type PeriodDetail, type PeriodFigures, type PeriodReportSources } from "@/lib/engines/period-report";
import { cycleSelectionForDay, previousReportPeriod, resolveReportPeriod, trendPeriods, type ReportPeriod, type ReportPeriodSelection } from "@/lib/engines/report-period";
import { useGlobalCycle } from "@/features/month-cycle/hooks/use-global-cycle";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Emi } from "@/lib/models/emi";
import { isSplit, type Expense } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";

export interface ReportAccountInfo {
  id: string;
  name: string;
  type: Account["type"];
  isCard: boolean;
  last4: string | null;
}

export interface ReportCategoryInfo {
  id: string;
  name: string;
  iconKey: string;
}

export interface CurrentPosition {
  netWorth: number;
  assets: number;
  debt: number;
  heldForPeople: number;
  /** Cash-like account balances (card accounts excluded — their balance is card debt). */
  liquidBalance: number;
  liabilities: { name: string; value: number }[];
  totalLiabilities: number;
  /** Loan principal owed to me. */
  lentReceivable: number;
  peopleReceivable: number;
  /** Principal people owe me through not-yet-due installments of loans/EMIs I carry — inside assets, offsets liabilities. */
  assignedReceivable: number;
  /** Part of total liabilities that belongs to other people (their share of loans/cards in my name). */
  assignedDebt: number;
  peoplePayable: number;
  cardOutstanding: number;
  cardLimit: number;
  /** Outstanding + locked card-EMI principal (what the card limit is used by). */
  cardUsedCredit: number;
}

export interface TrendPoint {
  period: ReportPeriod;
  figures: PeriodFigures;
}

const SELECTION_KEY = "flowfi.reports.period";

function readSelection(scope: string): ReportPeriodSelection {
  try {
    const raw = sessionStorage.getItem(`${SELECTION_KEY}.${scope}`);
    if (!raw) return { kind: "cycle", offset: 0 };
    const parsed = JSON.parse(raw) as ReportPeriodSelection;
    if (parsed.kind === "range") return { kind: "range", start: new Date(parsed.start), end: new Date(parsed.end) };
    if (parsed.kind === "cycle" && Number.isInteger(parsed.offset)) return parsed;
    if (parsed.kind === "month" && Number.isInteger(parsed.year) && Number.isInteger(parsed.month)) return parsed;
  } catch {
    // Storage unavailable / corrupt → default.
  }
  return { kind: "cycle", offset: 0 };
}

/** The selected period (per page), remembered for the tab session only — a convenience, never data. */
export function useReportPeriodSelection(scope: "reports" | "analytics") {
  const [selection, setSelectionState] = useState<ReportPeriodSelection>(() => (typeof window === "undefined" ? { kind: "cycle", offset: 0 } : readSelection(scope)));
  const setSelection = useCallback(
    (next: ReportPeriodSelection) => {
      setSelectionState(next);
      try {
        sessionStorage.setItem(`${SELECTION_KEY}.${scope}`, JSON.stringify(next));
      } catch {
        // ignore
      }
    },
    [scope],
  );
  return [selection, setSelection] as const;
}

/**
 * `useReportPeriodSelection`, but defaulting to following the top-bar's global Month Cycle (recomputed as the
 * equivalent `{kind:"cycle", offset}` every render, never written back to the page's own stored selection)
 * until the user picks a period HERE, which detaches it into the page's own selection — `followGlobalCycle()`
 * (3rd/4th return values) re-attaches it. Same follow/override split as Month Cycle, My Money and People Ledger.
 */
export function useSyncedReportPeriod(scope: "reports" | "analytics"): [ReportPeriodSelection, (next: ReportPeriodSelection) => void, boolean, () => void] {
  const [storedSelection, setStoredSelection] = useReportPeriodSelection(scope);
  const [isFollowingGlobalCycle, setIsFollowingGlobalCycle] = useState(true);
  const globalCycle = useGlobalCycle();

  const selection = isFollowingGlobalCycle
    ? cycleSelectionForDay(globalCycle.referenceDay ?? globalCycle.now, globalCycle.monthCycleStartDay, globalCycle.now)
    : storedSelection;
  const setSelection = (next: ReportPeriodSelection) => {
    setIsFollowingGlobalCycle(false);
    setStoredSelection(next);
  };

  return [selection, setSelection, isFollowingGlobalCycle, () => setIsFollowingGlobalCycle(true)];
}

export interface ReportFilters {
  /** Restrict transaction-based figures to these accounts (empty = all). */
  accountIds?: readonly string[];
}

export function useFinancialReportData(filters: ReportFilters = {}) {
  const startDay = useMonthCycleStartDay();
  // "Today" for period resolution. Stable within a day (so memoised figures don't churn), but it rolls over when the
  // date changes — a page left open past midnight moves "This cycle / This month" into the new period.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = new Date();
      setNow((prev) => (prev.toDateString() === next.toDateString() ? prev : next));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const { data: transactions = [], isLoading: txLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: creditCards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { installmentsByScheduleId } = useExpenseInstallmentsBySchedule();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { payments: emiPayments, isLoading: emiPaymentsLoading } = useEmiInstallmentPayments();
  const { payments: loanPayments, isLoading: loanPaymentsLoading } = useLoanScheduledPayments();
  const { ctx: mySpendCtx, isLoading: mySpendLoading } = useMySpendContext();
  const spendTransactions = useSpendTransactions(transactions as Transaction[]);
  const { charges: lenderCharges } = useLenderCharges();
  const balance = useLoanBalanceSheet();
  const { totals: cardTotals, isLoading: cardTotalsLoading } = useCreditCardTotals();
  // Already-open shared listeners (the balance sheet reads the same rows) — used only for the Net Worth history.
  const { rows: loanRows } = useLoanRows();
  const { rows: emiRows } = useEmiRows();
  const { data: emiBreakdowns = [] } = useAllEmiPaymentBreakdowns();
  // Same shared listener the balance sheet reads; only its person ids are used here (Person-linked EMI shares).
  const { positionsByPersonId } = usePersonPositions();

  const isLoading =
    txLoading ||
    accountsLoading ||
    cardsLoading ||
    emisLoading ||
    expensesLoading ||
    categoriesLoading ||
    emiPaymentsLoading ||
    loanPaymentsLoading ||
    mySpendLoading ||
    balance.isLoading ||
    cardTotalsLoading;

  const cardAccountIds = useMemo(() => new Set((creditCards as CreditCardProfile[]).map((c) => c.accountId)), [creditCards]);

  const accountInfo = useMemo(() => {
    const map = new Map<string, ReportAccountInfo>();
    for (const a of accounts as Account[]) {
      map.set(a.id, { id: a.id, name: a.name, type: a.type, isCard: cardAccountIds.has(a.id), last4: a.accountNumberLast4 });
    }
    return map;
  }, [accounts, cardAccountIds]);

  const spendCategories = useMemo(() => withBuiltInChargeCategory(categories as Category[], spendTransactions), [categories, spendTransactions]);
  const categoryInfo = useMemo(() => {
    const map = new Map<string, ReportCategoryInfo>();
    for (const c of spendCategories) map.set(c.id, { id: c.id, name: c.name, iconKey: c.iconKey });
    return map;
  }, [spendCategories]);
  const categoryName = useCallback((id: string) => categoryInfo.get(id)?.name ?? "Uncategorized", [categoryInfo]);

  // Principal part of each repayment I COLLECTED on money I lent, by its transaction id — `debtPrincipalEvents` (the balance
  // sheet's own principal rule) replayed up to each payment, so a collection that includes interest keeps that interest
  // as earned income. Never a second formula: each payment's principal = replay(up to it) − replay(before it).
  const loanCollectionPrincipal = useMemo(
    () =>
      loanCollectionPrincipalByTransaction({
        givenScheduleIds: loanRows.filter((r) => r.direction === "given").map((r) => r.loan.scheduleId),
        installments: loanRows.flatMap((r) => r.installments),
        loanPayments,
      }),
    [loanRows, loanPayments],
  );

  // Account filter (Analytics): only transaction-based rows are tied to an account. EMI / Loan schedule payments
  // and split collections are not, so they are left out while a filter is on (the UI says so).
  const accountKey = (filters.accountIds ?? []).slice().sort().join(",");
  const sources: PeriodReportSources = useMemo(() => {
    const only = accountKey ? new Set(accountKey.split(",")) : null;
    const txAccount = new Map((transactions as Transaction[]).map((t) => [t.id, t.accountId]));
    const tx = only ? (transactions as Transaction[]).filter((t) => only.has(t.accountId)) : (transactions as Transaction[]);
    const spend = only ? spendTransactions.filter((t) => only.has(t.accountId)) : spendTransactions;
    return buildPeriodReportSources({
      transactions: tx,
      spendTransactions: spend,
      mySpendCtx,
      creditCards: creditCards as CreditCardProfile[],
      emis: emis as Emi[],
      expenses: expenses as Expense[],
      // An EMI payment that posted a Transaction belongs to that Transaction's account; one that posted none (a legacy
      // remainder) can't be attributed and is left out while a filter is on.
      emiPayments: only ? emiPayments.filter((p) => p.transactionId != null && only.has(txAccount.get(p.transactionId) ?? "")) : emiPayments,
      loanPayments: only ? [] : loanPayments,
      installmentsByScheduleId: only ? {} : (installmentsByScheduleId as Record<string, Installment[]>),
      accounts: (accounts as Account[]).filter((a) => !only || only.has(a.id)).map((a) => ({ id: a.id, currentBalance: a.currentBalance })),
      loanCollectionPrincipal,
    });
  }, [loanCollectionPrincipal, accountKey, transactions, spendTransactions, mySpendCtx, creditCards, emis, expenses, emiPayments, loanPayments, installmentsByScheduleId, accounts]);

  const resolve = useCallback((selection: ReportPeriodSelection) => resolveReportPeriod(selection, startDay, now), [startDay, now]);
  const previousOf = useCallback((p: ReportPeriod) => previousReportPeriod(p, startDay, now), [startDay, now]);
  const trendOf = useCallback((p: ReportPeriod, count: number) => trendPeriods(p, startDay, count, now), [startDay, now]);
  const figuresFor = useCallback((p: ReportPeriod) => periodFigures(sources, p), [sources]);
  const detailFor = useCallback((p: ReportPeriod): PeriodDetail => periodDetail(sources, p), [sources]);

  const lenderChargeEvents = useMemo(() => lenderChargeNetWorthEvents(lenderCharges), [lenderCharges]);

  // Debt-aware Net Worth history: each loan / EMI payment moves Net Worth by its interest / charges only (principal is
  // walked back through the balance sheet's own principal rules), and a split expense by my share only.
  const debtEvents = useMemo(() => {
    const trackedCardIds = new Set((creditCards as CreditCardProfile[]).map((c) => c.id));
    const caseAIds = new Set(caseAEmis(emis as Emi[], creditCards as CreditCardProfile[], transactions as Transaction[]).map((e) => e.id));
    const principal = debtPrincipalEvents({
      loans: loanRows.map((r) => {
        const cardId = cardFundedLoanCardId(r.loan);
        return { scheduleId: r.loan.scheduleId, direction: r.direction, ownedByTrackedCard: cardId != null && trackedCardIds.has(cardId) };
      }),
      emis: emiRows.map((r) => ({ scheduleId: r.emi.scheduleId, ownership: r.linkedCard == null ? ("own" as const) : caseAIds.has(r.emi.id) ? ("cardRepresented" as const) : ("cardLock" as const) })),
      installments: [...loanRows.flatMap((r) => r.installments), ...emiRows.flatMap((r) => r.installments)],
      loanPayments: loanPayments.flatMap((p) => (p.scheduleId ? [{ ...p, scheduleId: p.scheduleId }] : [])),
      emiPayments,
      breakdowns: emiBreakdowns,
    });
    // Person-linked EMI / Loan shares enter Net Worth on the first day of the cycle containing their due date — the
    // People position's own rule (`emiReceivableThrough` with the current-cycle cutoff), replayed per obligation.
    const installments = [...emiRows.flatMap((r) => r.installments), ...loanRows.flatMap((r) => r.installments)];
    const loans = loanRows.map((r) => r.loan);
    const shares = Object.keys(positionsByPersonId).flatMap((personId) =>
      personShareEvents(
        personEmiObligations({ personId, emis: emis as Emi[], loans, installments, now }),
        (d) => cycleContaining(d, startDay).start,
        now,
      ),
    );
    return [...principal, ...shares];
  }, [creditCards, emis, transactions, loanRows, emiRows, loanPayments, emiPayments, emiBreakdowns, positionsByPersonId, now, startDay]);
  const receivableShares = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of expenses as Expense[]) {
      if (e.deletedAt != null || !isSplit(e)) continue;
      const tracked = e.participants.filter((p) => !p.isMe && p.personId != null).reduce((s, p) => s + p.share, 0);
      if (tracked > 0) map.set(e.transactionId, tracked);
    }
    return map;
  }, [expenses]);

  /** Net Worth at the END of each period (walked back from today's real Net Worth). Future periods: today's. */
  const netWorthAtEnds = useCallback(
    (periods: readonly ReportPeriod[]) => {
      const cutoffs = periods.map((p) => periodEndCutoff(p.end, now));
      return netWorthAtCutoffs({ transactions: transactions as Transaction[], netWorthNow: balance.netWorth, lenderChargeEvents, cutoffs, debtEvents, receivableShareByTransactionId: receivableShares });
    },
    [transactions, balance.netWorth, lenderChargeEvents, now, debtEvents, receivableShares],
  );

  /** Each account's balance at the END of each period. */
  const accountBalancesAtEnds = useCallback(
    (periods: readonly ReportPeriod[]) => {
      const cutoffs = periods.map((p) => periodEndCutoff(p.end, now));
      return accountBalancesAtCutoffs({ accounts: accounts as Account[], transactions: transactions as Transaction[], cutoffs });
    },
    [accounts, transactions, now],
  );

  // The earliest real record (a live transaction or a recorded payment). Periods that END before it have no records — a
  // chart shows them as "no records yet", never as genuine ₹0 months, and they never enter averages or comparisons.
  const firstRecordDate = useMemo(() => {
    let min = Infinity;
    for (const t of transactions as Transaction[]) if (t.deletedAt == null) min = Math.min(min, t.dateTime.getTime());
    for (const p of emiPayments) min = Math.min(min, p.date.getTime());
    for (const p of loanPayments) if (p.deletedAt == null) min = Math.min(min, p.date.getTime());
    return Number.isFinite(min) ? new Date(min) : null;
  }, [transactions, emiPayments, loanPayments]);

  // --- Current position: exactly the Dashboard / Net Worth figures. ---
  const position: CurrentPosition = useMemo(() => {
    const cardDebt = -(accounts as Account[]).filter((a) => cardAccountIds.has(a.id)).reduce((s, a) => s + a.currentBalance, 0);
    const debt = liabilityTotals(balance.sheet, cardDebt);
    const composition = netWorthComposition(balance.netWorth, { total: debt.total + balance.unpaidLenderCharges }, { payable: balance.peoplePayable, advanceHeld: balance.peopleAdvanceHeld });
    const liquidBalance = (accounts as Account[]).filter((a) => !cardAccountIds.has(a.id)).reduce((s, a) => s + a.currentBalance, 0);
    const liabilities = [
      { name: "Credit cards", value: debt.creditCards },
      { name: "Loans I owe", value: debt.loans },
      { name: "EMIs", value: debt.emis },
      { name: "Owed to people", value: balance.peoplePayable },
      { name: "Unpaid lender charges", value: balance.unpaidLenderCharges },
    ].filter((l) => l.value > 0.005);
    return {
      netWorth: balance.netWorth,
      assets: composition.assets,
      debt: composition.debt,
      heldForPeople: composition.heldForPeople,
      liquidBalance: Math.round(liquidBalance * 100) / 100,
      liabilities,
      totalLiabilities: composition.debt,
      lentReceivable: balance.sheet.lentPrincipal,
      peopleReceivable: balance.peopleReceivable,
      assignedReceivable: balance.assignedReceivable,
      assignedDebt: Math.min(balance.assignedDebt, composition.debt),
      peoplePayable: balance.peoplePayable,
      cardOutstanding: cardTotals.utilized,
      cardLimit: cardTotals.creditLimit,
      cardUsedCredit: cardTotals.usedCredit,
    };
  }, [accounts, cardAccountIds, balance, cardTotals]);

  return {
    isLoading,
    now,
    startDay,
    isCustomCycle: startDay > 1,
    sources,
    accountInfo,
    categoryInfo,
    categoryName,
    resolve,
    previousOf,
    trendOf,
    figuresFor,
    detailFor,
    netWorthAtEnds,
    accountBalancesAtEnds,
    position,
    hasData: (transactions as Transaction[]).length > 0,
    firstRecordDate,
    /** Whether a period has any records at all — false for periods that end before the first record (shown as "no records", never ₹0). */
    hasRecordsIn: (p: ReportPeriod) => firstRecordDate != null && p.end.getTime() >= firstRecordDate.getTime(),
    /** Payments the account filter can't attribute to an account (legacy loan payments with no Transaction, EMI remainders). */
    unattributedPaymentCount: loanPayments.filter((p) => p.deletedAt == null && p.transactionId == null).length + emiPayments.filter((p) => p.transactionId == null && !p.recordedEarlier).length,
  };
}

export type FinancialReportData = ReturnType<typeof useFinancialReportData>;
