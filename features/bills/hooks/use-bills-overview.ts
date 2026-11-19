"use client";

/**
 * Live inputs for the Bills dashboard — a read-only composition. It writes nothing, stores nothing and creates no
 * Bill / Transaction / Person to represent an obligation. Every figure comes from the same builder My Money uses
 * (`buildCycleObligations` / `buildCompletedEvents`, which in turn call the Month Cycle engines), fed by the same
 * live subscriptions, so Bills, My Money and Month Cycle read one set of numbers:
 *  - Selected cycle  → `cycleRangeFor(Settings → Month cycle start day)`, stepped with `adjacentCycleRange`.
 *  - Owed in cycle   → the cycle's own obligations + anything earlier still unpaid (carried forward).
 *  - Upcoming        → the NEXT cycle's own obligations (carried ones excluded — they are already above).
 *  - Paid            → recorded payments dated inside the cycle.
 * Bill rows are passed in (the page already holds them), so the bill-cycle read is not duplicated.
 */

import { useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useAllCreditCardStatements, useCreditCards } from "@/hooks/use-credit-cards";
import { useEmiInstallmentPayments } from "@/hooks/use-emi-installment-payments";
import { useLoanScheduledPayments } from "@/hooks/use-loan-scheduled-payments";
import { useTransactions } from "@/hooks/use-transactions";
import { useAllBillOccurrences } from "@/features/bills/hooks/use-bill-occurrence-history";
import type { BillCycleRef, BillRow } from "@/features/bills/hooks/use-bills-data";
import { buildBillsOverview } from "@/features/bills/lib/bills-overview";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useBillPayments } from "@/features/history/hooks/use-history-payment-sources";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { buildCompletedEvents, buildCycleObligations, makeCardLookup } from "@/features/my-money/lib/cycle-obligations";
import { groupCompleted } from "@/features/my-money/lib/my-money";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { adjacentCycleRange, cycleRangeFor, cycleRangeForMonth, isInCycle } from "@/lib/engines/month-cycle-range";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export interface BillsOverviewInput {
  billRows: readonly BillRow[];
  billCycles: readonly BillCycleRef[];
  /** The page's own bill loading flag — the overview waits for it too. */
  billsLoading: boolean;
}

export function useBillsOverview({ billRows, billCycles, billsLoading }: BillsOverviewInput) {
  const now = useMemo(() => new Date(), []);
  const startDay = useMonthCycleStartDay();
  const isCustomCycle = startDay > 1;

  // Selected period — held as a day inside it (null = today's), stepped from its own edges (Month Cycle's rule).
  const [referenceDay, setReferenceDay] = useState<Date | null>(null);
  const cycleRange = useMemo(() => cycleRangeFor(startDay, referenceDay ?? now), [startDay, referenceDay, now]);
  const nextRange = useMemo(() => adjacentCycleRange(startDay, cycleRange, 1), [startDay, cycleRange]);
  const isCurrent = isInCycle(now, cycleRange);
  const nav = {
    previous: () => setReferenceDay(adjacentCycleRange(startDay, cycleRange, -1).start),
    next: () => setReferenceDay(adjacentCycleRange(startDay, cycleRange, 1).start),
    current: () => setReferenceDay(null),
    pickMonth: (year: number, month: number) => setReferenceDay(cycleRangeForMonth(startDay, year, month).start),
  };

  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { occurrences: billOccurrences, isLoading: occurrencesLoading } = useAllBillOccurrences();
  const { paymentsByBillId: billPaymentsByBillId, isLoading: billPaymentsLoading } = useBillPayments();
  const { payments: loanPayments, isLoading: loanPaymentsLoading } = useLoanScheduledPayments();
  const { payments: emiPayments, isLoading: emiPaymentsLoading } = useEmiInstallmentPayments();

  const isLoading =
    billsLoading ||
    transactionsLoading ||
    accountsLoading ||
    cardsLoading ||
    statementsLoading ||
    loansLoading ||
    emisLoading ||
    occurrencesLoading ||
    billPaymentsLoading ||
    loanPaymentsLoading ||
    emiPaymentsLoading;

  const txns = transactions as Transaction[];
  const accountList = accounts as Account[];
  const cardList = useMemo(() => (cards as CreditCardProfile[]).filter((c) => c.deletedAt == null), [cards]);
  const lookup = useMemo(() => makeCardLookup({ accounts: accountList, cards: cardList, transactions: txns }), [accountList, cardList, txns]);

  const overview = useMemo(() => {
    const base = { cards: cardList, transactions: txns, statements: statements as Statement[], accounts: accountList, loanRows, emiRows, billRows, billCycles, now, lookup };
    return buildBillsOverview({
      cycleObligations: buildCycleObligations({ ...base, cycleRange }),
      nextCycleObligations: buildCycleObligations({ ...base, cycleRange: nextRange }),
      completed: groupCompleted(
        buildCompletedEvents({ cards: cardList, transactions: txns, lookup, loanRows, loanPayments, emiRows, emiPayments, billRows, billOccurrences, billPaymentsByBillId }),
        cycleRange,
      ),
    });
  }, [cardList, txns, statements, accountList, loanRows, emiRows, billRows, billCycles, now, lookup, cycleRange, nextRange, loanPayments, emiPayments, billOccurrences, billPaymentsByBillId]);

  const periodLabel = isCustomCycle
    ? `${shortDate(cycleRange.start)} – ${shortDate(cycleRange.end)}`
    : cycleRange.end.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const nextPeriodLabel = isCustomCycle
    ? `${shortDate(nextRange.start)} – ${shortDate(nextRange.end)}`
    : nextRange.end.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return {
    isLoading,
    now,
    startDay,
    isCustomCycle,
    cycleRange,
    nextRange,
    isCurrent,
    periodLabel,
    nextPeriodLabel,
    rangeLabel: `${shortDate(cycleRange.start)} – ${shortDate(cycleRange.end)}`,
    nav,
    ...overview,
  };
}

export type BillsOverviewData = ReturnType<typeof useBillsOverview>;
