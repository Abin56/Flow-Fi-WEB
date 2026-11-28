"use client";

/**
 * My Money — a read-only composition of existing live subscriptions and canonical engines. Nothing here
 * writes, stores a balance or re-derives a figure an engine already owns:
 *  - Card bills        → `cardBillsForCard` + `cardBillsDueInCycle` (per physical card — a shared-limit
 *                        sibling keeps its own statement), the same bills Month Cycle and Credit Cards read.
 *  - Loan / EMI dues   → `loanCycleDues` over each schedule's live `Installment`s (partial and advance
 *                        payments are already in `amountPaid`; carried overdue stays its own row).
 *  - Card-funded EMIs  → `emiPurchaseRepresentedOnCard` (the Bills / Net Worth rule): when the purchase is
 *                        on the card, the card bill carries the money and the installment is not counted again.
 *  - Shared shares     → `linkedPeopleForInstallments` / `linkedPeopleForCard` over the whole-history
 *                        People statements (the numbers the People Ledger and the payment gate read).
 *  - To collect        → `peopleDirectionSides` (gross per person) + statement rows for the reasons.
 *  - My spending       → `mySpendRows` / `summarizeMySpend` with the Month Cycle bucketing rule.
 *  - Completed         → recorded payments by payment date: card bill payment legs, Loan / EMI installment
 *                        payments, bill `PaymentRecord`s (a bill part with no record is shown undated).
 */

import { useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { useAllCreditCardStatements, useCreditCards } from "@/hooks/use-credit-cards";
import { useEmiInstallmentPayments } from "@/hooks/use-emi-installment-payments";
import { useLoanScheduledPayments } from "@/hooks/use-loan-scheduled-payments";
import { useMySpendContext } from "@/hooks/use-my-spend-context";
import { useSpendTransactions, withBuiltInChargeCategory } from "@/hooks/use-lender-charge-spend";
import { useTransactions } from "@/hooks/use-transactions";
import { useAllBillOccurrences } from "@/features/bills/hooks/use-bill-occurrence-history";
import { useBillRows } from "@/features/bills/hooks/use-bills-data";
import { useBillPayments } from "@/features/history/hooks/use-history-payment-sources";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { usePeopleLedgerEntries, usePeopleRows } from "@/features/people/hooks/use-people-data";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { useAllPersonDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { projectDueNow } from "@/lib/engines/person-due-now";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import { attentionItems, openRemainingByKey, useAllPersonFollowUps } from "@/features/people/hooks/use-person-follow-ups";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { useGlobalCycle } from "@/features/month-cycle/hooks/use-global-cycle";
import { peopleLedgerHref } from "@/lib/engines/linked-people-readiness";
import { adjacentCycleRange, cycleRangeFor, cycleRangeForMonth, isInCycle, mySpendBucketDate } from "@/lib/engines/month-cycle-range";
import { mySpendRows, summarizeMySpend } from "@/lib/engines/my-spend";
import type { PersonCycleStatement, StatementCategory, StatementCycle } from "@/lib/engines/person-cycle-statement";
import { peopleDirectionSides } from "@/lib/engines/person-position";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { accountSpendingForRange, accountSpendingRows } from "@/features/my-money/lib/account-spending";
import { buildCompletedEvents, buildCycleObligations, makeCardLookup } from "@/features/my-money/lib/cycle-obligations";
import { groupCompleted, spendComparison, summarizeToPay, summarizeYearSpend } from "@/features/my-money/lib/my-money";

/** Whole history — every installment share and its live `remainingNow` (same window the payment gate reads). */
const ALL_TIME: StatementCycle = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

const round2 = (v: number) => Math.round(v * 100) / 100;

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Plain-language reason a person owes me, by People statement category. */
const REASON_LABEL: Partial<Record<StatementCategory, string>> = {
  split: "Shared expense",
  emi: "Loan / EMI share",
  loan: "Loan",
  gave: "Money you gave",
  opening: "Opening balance",
  adjustment: "Adjustment",
};

export interface CollectItem {
  personId: string;
  name: string;
  /** Gross still owed to me today (People engine). */
  amount: number;
  /** The part of `amount` postponed to after this cycle (0 when none). `amount` itself is unchanged. */
  postponed: number;
  /** Already reimbursed against the obligations still open (partial repayments). */
  partlyReceived: number;
  reasons: string[];
  /** Earliest open follow-up reminder — the only "expected" date FlowFi holds for a person. */
  expected: { date: Date; status: "upcoming" | "dueToday" | "overdue" } | null;
  /** I also owe this person (gross) — shown so a net never hides it. */
  alsoOwe: number;
  href: string;
}

export interface SpendCategory {
  categoryId: string;
  name: string;
  iconKey: string;
  amount: number;
  percent: number;
}

export function useMyMoneyData() {
  const now = useMemo(() => new Date(), []);
  const startDay = useMonthCycleStartDay();
  const isCustomCycle = startDay > 1;

  // Selected period — held as a day inside it (null = today's), stepped from its own edges (Month Cycle's rule).
  // Follows the top-bar's global cycle until the user moves this page's own nav, which detaches it into a
  // local override (`nav.followGlobal` re-attaches it) — the same follow/override split as the Month Cycle page.
  const globalCycle = useGlobalCycle();
  const [localReferenceDay, setLocalReferenceDay] = useState<Date | null>(null);
  const [isFollowingGlobalCycle, setIsFollowingGlobalCycle] = useState(true);
  const referenceDay = isFollowingGlobalCycle ? globalCycle.referenceDay : localReferenceDay;
  const cycleRange = useMemo(() => cycleRangeFor(startDay, referenceDay ?? now), [startDay, referenceDay, now]);
  const previousRange = useMemo(() => adjacentCycleRange(startDay, cycleRange, -1), [startDay, cycleRange]);
  const isCurrent = isInCycle(now, cycleRange);
  const isPast = cycleRange.end.getTime() < now.getTime();
  const overrideLocally = (day: Date | null) => {
    setIsFollowingGlobalCycle(false);
    setLocalReferenceDay(day);
  };
  const nav = {
    previous: () => overrideLocally(adjacentCycleRange(startDay, cycleRange, -1).start),
    next: () => overrideLocally(adjacentCycleRange(startDay, cycleRange, 1).start),
    current: () => overrideLocally(null),
    pickMonth: (year: number, month: number) => overrideLocally(cycleRangeForMonth(startDay, year, month).start),
    isFollowingGlobalCycle,
    followGlobal: () => setIsFollowingGlobalCycle(true),
  };

  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { rows: billRows, cycles: billCycles, isLoading: billsLoading } = useBillRows();
  const { occurrences: billOccurrences, isLoading: occurrencesLoading } = useAllBillOccurrences();
  const { paymentsByBillId: billPaymentsByBillId, isLoading: billPaymentsLoading } = useBillPayments();
  const { payments: loanPayments, isLoading: loanPaymentsLoading } = useLoanScheduledPayments();
  const { payments: emiPayments, isLoading: emiPaymentsLoading } = useEmiInstallmentPayments();
  const { rows: peopleRows, isLoading: peopleLoading } = usePeopleRows();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const { statementsByPersonId, isLoading: peopleStatementsLoading } = usePeopleCycleStatements(ALL_TIME);
  const { followUpsByPersonId, isLoading: followUpsLoading } = useAllPersonFollowUps();
  const { deferralsByPerson } = useAllPersonDeferrals();
  const { ctx: mySpendCtx, isLoading: mySpendLoading } = useMySpendContext();

  const isLoading =
    transactionsLoading ||
    accountsLoading ||
    categoriesLoading ||
    cardsLoading ||
    statementsLoading ||
    loansLoading ||
    emisLoading ||
    billsLoading ||
    occurrencesLoading ||
    billPaymentsLoading ||
    loanPaymentsLoading ||
    emiPaymentsLoading ||
    peopleLoading ||
    entriesLoading ||
    peopleStatementsLoading ||
    followUpsLoading ||
    mySpendLoading;

  const txns = transactions as Transaction[];
  // Spend only: billed lender charges count once as an expense on their billed date (balances / payments use `txns`).
  const spendTxns = useSpendTransactions(txns);
  const spendCategories = useMemo(() => withBuiltInChargeCategory(categories as Category[], spendTxns), [categories, spendTxns]);
  const accountList = accounts as Account[];
  const cardList = useMemo(() => (cards as CreditCardProfile[]).filter((c) => c.deletedAt == null), [cards]);

  /** Card display label + the card-funded-EMI rule, shared by To pay and Completed (`cycle-obligations.ts`). */
  const cardLookup = useMemo(() => makeCardLookup({ accounts: accountList, cards: cardList, transactions: txns }), [accountList, cardList, txns]);

  const peopleStatements = useMemo(() => Object.values(statementsByPersonId) as PersonCycleStatement[], [statementsByPersonId]);

  // ── To pay: every obligation owed in the period — the same builder Bills uses, so the two pages cannot disagree ──
  const obligations = useMemo(
    () =>
      buildCycleObligations({
        cards: cardList,
        transactions: txns,
        statements: statements as Statement[],
        accounts: accountList,
        loanRows,
        emiRows,
        billRows,
        billCycles,
        cycleRange,
        now,
        lookup: cardLookup,
        people: { statements: peopleStatements, ledgerEntries: Object.values(entriesByPersonId).flat() },
      }),
    [cardList, txns, statements, accountList, cycleRange, now, entriesByPersonId, peopleStatements, cardLookup, loanRows, emiRows, billRows, billCycles],
  );

  const toPay = useMemo(() => summarizeToPay(obligations), [obligations]);

  // ── To collect: what people owe me today (not period-bound) ──
  const collect = useMemo(() => {
    const sides = peopleDirectionSides(peopleRows);
    const giveById = new Map(sides.toGive.map((g) => [g.row.id, g.amount]));
    const people = peopleRows.map((p) => ({ id: p.id, name: p.name })) as Pick<Person, "id" | "name">[];
    const reminders = attentionItems(people, followUpsByPersonId, (id) => openRemainingByKey(statementsByPersonId[id]), now);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

    const items: CollectItem[] = sides.toReceive.map(({ row, amount }) => {
      const statement = statementsByPersonId[row.id];
      // Obligations they still owe me today (future installment shares are not owed yet).
      const open = (statement?.rows ?? []).filter(
        (r) => r.kind === "obligation" && r.signedAmount > 0 && (r.remainingNow ?? 0) > 0.005 && r.date.getTime() <= todayEnd,
      );
      const byReason = new Map<string, number>();
      let partlyReceived = 0;
      for (const r of open) {
        const label = REASON_LABEL[r.category] ?? "Other";
        byReason.set(label, (byReason.get(label) ?? 0) + (r.remainingNow ?? 0));
        partlyReceived += Math.max(0, r.amount - (r.remainingNow ?? 0));
      }
      const reasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
      const reminder = reminders.find((x) => x.personId === row.id && x.status !== "resolved") ?? null;
      return {
        personId: row.id,
        name: row.name,
        amount,
        postponed:
          projectDueNow({ total: amount, rows: open, deferrals: deferralsByPerson[row.id] ?? [], cycle: cycleContaining(now, startDay), startDay, today: now })?.postponed ?? 0,
        partlyReceived: round2(partlyReceived),
        reasons,
        expected: reminder ? { date: reminder.followUp.remindOn, status: reminder.status as "upcoming" | "dueToday" | "overdue" } : null,
        alsoOwe: giveById.get(row.id) ?? 0,
        href: peopleLedgerHref(row.id),
      };
    });

    // Money that actually came in from people during the selected period (reimbursements + advances received).
    let collectedInPeriod = 0;
    for (const st of Object.values(statementsByPersonId)) {
      for (const r of st.rows) {
        if (!isInCycle(r.date, cycleRange)) continue;
        if (r.kind === "settlement" && r.category !== "advanceApplied" && r.signedAmount < 0) collectedInPeriod += -r.signedAmount;
        if (r.category === "advance" && r.advanceDelta < 0) collectedInPeriod += -r.advanceDelta;
      }
    }

    return {
      items,
      total: sides.totalToReceive,
      totalToGive: sides.totalToGive,
      giveCount: sides.toGive.length,
      advanceHeld: sides.advanceHeld,
      collectedInPeriod: round2(collectedInPeriod),
    };
  }, [peopleRows, followUpsByPersonId, statementsByPersonId, cycleRange, now, deferralsByPerson, startDay]);

  const accountSpendRows = useMemo(() => accountSpendingRows({
    transactions, accounts, cards, context: mySpendCtx, isCustomCycle,
  }), [transactions, accounts, cards, mySpendCtx, isCustomCycle]);

  // ── My spending: My Spend engine, Month Cycle bucketing ──
  const spending = useMemo(() => {
    const bucketDate = (t: Transaction) => mySpendBucketDate(t, isCustomCycle);
    const rows = mySpendRows({ transactions: spendTxns, ctx: mySpendCtx, bucketDate, range: cycleRange });
    const summary = summarizeMySpend(rows);
    const previous = summarizeMySpend(mySpendRows({ transactions: spendTxns, ctx: mySpendCtx, bucketDate, range: previousRange })).mySpend;
    const categoryById = new Map(spendCategories.map((c) => [c.id, c]));
    const sharedMine = round2(rows.filter((r) => r.othersAmount > 0).reduce((s, r) => s + r.myAmount, 0));
    const topCategories: SpendCategory[] = [...summary.byCategoryId.entries()]
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([categoryId, amount]) => ({
        categoryId,
        name: categoryById.get(categoryId)?.name ?? "Uncategorized",
        iconKey: categoryById.get(categoryId)?.iconKey ?? "other",
        amount,
        percent: summary.mySpend > 0 ? Math.round((amount / summary.mySpend) * 100) : 0,
      }));
    return {
      mySpend: summary.mySpend,
      sharedMine,
      othersShare: summary.othersShare,
      purchaseCount: rows.length,
      topCategories,
      comparison: spendComparison(summary.mySpend, previous, isPast),
      fromAccounts: accountSpendingForRange(accountSpendRows, cycleRange),
    };
  }, [spendTxns, mySpendCtx, isCustomCycle, cycleRange, previousRange, spendCategories, isPast, accountSpendRows]);

  // ── Spending this year: the same My Spend rows, bucketed into the year's twelve cycles (extra to the period view) ──
  // The year follows the selected period until the panel's own year stepper is used.
  const [yearOverride, setYearOverride] = useState<number | null>(null);
  const year = yearOverride ?? cycleRange.end.getFullYear();
  const yearSpending = useMemo(() => {
    const monthRanges = Array.from({ length: 12 }, (_, m) => cycleRangeForMonth(startDay, year, m));
    const bucketDate = (t: Transaction) => mySpendBucketDate(t, isCustomCycle);
    const yearEntries = (ranges: { start: Date; end: Date }[]) =>
      mySpendRows({ transactions: spendTxns, ctx: mySpendCtx, bucketDate, range: { start: ranges[0].start, end: ranges[11].end } }).map((r) => ({
        date: bucketDate(r.transaction),
        myAmount: r.myAmount,
        categoryId: r.transaction.categoryId,
      }));
    const summary = summarizeYearSpend(yearEntries(monthRanges), monthRanges, now);
    const previousRanges = Array.from({ length: 12 }, (_, m) => cycleRangeForMonth(startDay, year - 1, m));
    const previousTotal = summarizeYearSpend(yearEntries(previousRanges), previousRanges, now).total;
    const yearComplete = monthRanges[11].end.getTime() < now.getTime();
    const range = { start: monthRanges[0].start, end: monthRanges[11].end };
    const fromAccounts = accountSpendingForRange(accountSpendRows, range);
    const categoryById = new Map(spendCategories.map((c) => [c.id, c]));
    const topCategories: SpendCategory[] = [...summary.byCategoryId.entries()]
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([categoryId, amount]) => ({
        categoryId,
        name: categoryById.get(categoryId)?.name ?? "Uncategorized",
        iconKey: categoryById.get(categoryId)?.iconKey ?? "other",
        amount,
        percent: summary.total > 0 ? Math.round((amount / summary.total) * 100) : 0,
      }));
    return {
      year,
      isCurrentYear: year === now.getFullYear(),
      rangeLabel: `${shortDate(monthRanges[0].start)} ${monthRanges[0].start.getFullYear()} – ${shortDate(monthRanges[11].end)} ${monthRanges[11].end.getFullYear()}`,
      range,
      fromAccounts,
      monthlyFromAccounts: monthRanges.map((monthRange) => {
        const groups = accountSpendingForRange(accountSpendRows, monthRange);
        return { loanPayments: groups.loanPayments.amount, expenses: groups.expenses.amount };
      }),
      ...summary,
      topCategories,
      comparison: spendComparison(summary.total, previousTotal, yearComplete),
      nav: {
        previous: () => setYearOverride(year - 1),
        next: () => setYearOverride(year + 1),
        reset: () => setYearOverride(null),
        isOverridden: yearOverride != null && yearOverride !== cycleRange.end.getFullYear(),
      },
    };
  }, [year, yearOverride, cycleRange, startDay, isCustomCycle, spendTxns, mySpendCtx, spendCategories, now, accountSpendRows]);

  // ── Completed: payments made in the period ──
  const completed = useMemo(
    () =>
      groupCompleted(
        buildCompletedEvents({
          cards: cardList,
          transactions: txns,
          lookup: cardLookup,
          loanRows,
          loanPayments,
          emiRows,
          emiPayments,
          billRows,
          billOccurrences,
          billPaymentsByBillId,
        }),
        cycleRange,
      ),
    [cardList, txns, cardLookup, loanRows, loanPayments, emiRows, emiPayments, billRows, billOccurrences, billPaymentsByBillId, cycleRange],
  );

  const periodLabel = isCustomCycle
    ? `${shortDate(cycleRange.start)} – ${shortDate(cycleRange.end)}`
    : cycleRange.end.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return {
    isLoading,
    now,
    cycleRange,
    periodLabel,
    rangeLabel: `${shortDate(cycleRange.start)} – ${shortDate(cycleRange.end)}`,
    isCustomCycle,
    startDay,
    isCurrent,
    isPast,
    nav,
    obligations,
    toPay,
    collect,
    spending,
    yearSpending,
    completed,
  };
}

export type MyMoneyData = ReturnType<typeof useMyMoneyData>;
