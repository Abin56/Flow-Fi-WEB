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
import { useTransactions } from "@/hooks/use-transactions";
import { useAllBillOccurrences } from "@/features/bills/hooks/use-bill-occurrence-history";
import { useBillRows } from "@/features/bills/hooks/use-bills-data";
import { billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import { useBillPayments } from "@/features/history/hooks/use-history-payment-sources";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { usePeopleLedgerEntries, usePeopleRows } from "@/features/people/hooks/use-people-data";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { attentionItems, openRemainingByKey, useAllPersonFollowUps } from "@/features/people/hooks/use-person-follow-ups";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { cardBillsDueInCycle, cardBillsForCard } from "@/lib/engines/card-cycle-bills";
import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import { hasOwnershipShares } from "@/lib/engines/debt-ownership";
import { linkedPeopleForCard, linkedPeopleForInstallments, peopleLedgerHref } from "@/lib/engines/linked-people-readiness";
import { loanCycleDues } from "@/lib/engines/loan-cycle-dues";
import { adjacentCycleRange, cycleRangeFor, cycleRangeForMonth, isInCycle, mySpendBucketDate } from "@/lib/engines/month-cycle-range";
import { mySpendRows, summarizeMySpend } from "@/lib/engines/my-spend";
import type { PersonCycleStatement, StatementCategory, StatementCycle } from "@/lib/engines/person-cycle-statement";
import { peopleDirectionSides } from "@/lib/engines/person-position";
import { isCardBillPaymentLeg } from "@/lib/repositories/credit-card-repository";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import {
  compareObligations,
  groupCompleted,
  obligationStatus,
  sharedSplitFrom,
  spendComparison,
  summarizeToPay,
  type ObligationItem,
  type PaymentEvent,
} from "@/features/my-money/lib/my-money";

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
  const [referenceDay, setReferenceDay] = useState<Date | null>(null);
  const cycleRange = useMemo(() => cycleRangeFor(startDay, referenceDay ?? now), [startDay, referenceDay, now]);
  const previousRange = useMemo(() => adjacentCycleRange(startDay, cycleRange, -1), [startDay, cycleRange]);
  const isCurrent = isInCycle(now, cycleRange);
  const isPast = cycleRange.end.getTime() < now.getTime();
  const nav = {
    previous: () => setReferenceDay(adjacentCycleRange(startDay, cycleRange, -1).start),
    next: () => setReferenceDay(adjacentCycleRange(startDay, cycleRange, 1).start),
    current: () => setReferenceDay(null),
    pickMonth: (year: number, month: number) => setReferenceDay(cycleRangeForMonth(startDay, year, month).start),
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
  const accountList = accounts as Account[];
  const cardList = useMemo(() => (cards as CreditCardProfile[]).filter((c) => c.deletedAt == null), [cards]);

  /** Card display label + the card-funded-EMI rule, shared by To pay and Completed. */
  const cardLookup = useMemo(() => {
    const accountById = new Map(accountList.map((a) => [a.id, a]));
    const cardById = new Map(cardList.map((c) => [c.id, c]));
    const txnById = new Map(txns.filter((t) => t.deletedAt == null).map((t) => [t.id, t]));
    const label = (card: CreditCardProfile) => {
      const name = accountById.get(card.accountId)?.name ?? "Credit card";
      return card.lastFourDigits ? `${name} ••${card.lastFourDigits}` : name;
    };
    /** The tracked card whose bill already carries this agreement's purchase (Case A), else null. */
    const carriedByCard = (linkedCreditCardId: string | null | undefined, purchaseTransactionId: string | null | undefined) => {
      const card = linkedCreditCardId ? cardById.get(linkedCreditCardId) : undefined;
      if (!card) return null;
      return emiPurchaseRepresentedOnCard(purchaseTransactionId ?? null, txnById.get(purchaseTransactionId ?? ""), card.accountId) ? label(card) : null;
    };
    return { label, carriedByCard };
  }, [accountList, cardList, txns]);

  const peopleStatements = useMemo(() => Object.values(statementsByPersonId) as PersonCycleStatement[], [statementsByPersonId]);

  // ── To pay: every obligation owed in the period ──
  const obligations = useMemo(() => {
    const items: ObligationItem[] = [];
    const ledgerEntries = Object.values(entriesByPersonId).flat();

    for (const card of cardList) {
      const cardTxns = txns.filter((t) => t.accountId === card.accountId);
      const bills = cardBillsForCard(card, cardTxns, statements as Statement[], now);
      const openingBalance = accountList.find((a) => a.id === card.accountId)?.openingBalance ?? 0;
      for (const bill of cardBillsDueInCycle(bills, cycleRange, now)) {
        const readiness = linkedPeopleForCard({
          statements: peopleStatements,
          ledgerEntries,
          transactions: txns,
          cardAccountId: card.accountId,
          cardOpeningBalance: openingBalance,
          lenderDue: bill.remaining,
          chargeScope: new Set(bill.chargeIds),
        });
        items.push({
          key: `card:${card.id}:${bill.id}`,
          kind: "card",
          sourceId: card.id,
          title: cardLookup.label(card),
          detail: bill.isClosed ? `Statement ${shortDate(bill.periodStart)} – ${shortDate(bill.periodEnd)}` : `Statement closes ${shortDate(bill.periodEnd)}`,
          dueDate: bill.dueDate,
          amountDue: bill.totalAmount,
          amountPaid: bill.amountPaid,
          remaining: bill.remaining,
          status: obligationStatus(bill.dueDate, bill.remaining, now),
          carriedForward: bill.carriedForward,
          countsTowardTotal: true,
          note: card.sharedLimitId ? "Shares a credit limit · billed separately" : null,
          billStillOpen: !bill.isClosed,
          shared: sharedSplitFrom(readiness),
          href: bill.isClosed ? `/credit-cards?card=${encodeURIComponent(card.id)}&pay=1` : `/credit-cards?card=${encodeURIComponent(card.id)}`,
          actionLabel: bill.isClosed ? "Pay bill" : "View card",
        });
      }
    }

    for (const row of loanRows) {
      if (row.direction !== "taken") continue;
      const loan = row.loan;
      const carriedBy = cardLookup.carriedByCard(loan.linkedCreditCardId, loan.purchaseTransactionId);
      const paidByOther = row.payerPersonId != null ? (row.payerName ?? "someone else") : null;
      const sharesInstallments = hasOwnershipShares(loan) || loan.beneficiaryRepaysInstallments === true;
      for (const due of loanCycleDues({ id: loan.id, isClosed: loan.isClosed, installments: row.installments }, cycleRange, now)) {
        items.push({
          key: `loan:${loan.id}:${due.installmentId}`,
          kind: "loan",
          sourceId: loan.id,
          title: loan.name?.trim() || row.lenderName,
          detail: `${row.lenderName} · Installment ${due.sequenceNumber} of ${due.installmentCount}`,
          dueDate: due.dueDate,
          amountDue: due.amountDue,
          amountPaid: due.amountPaid,
          remaining: due.remaining,
          status: obligationStatus(due.dueDate, due.remaining, now),
          carriedForward: due.carriedForward,
          countsTowardTotal: carriedBy == null && paidByOther == null,
          note: carriedBy ? `Included in ${carriedBy} bill` : paidByOther ? `Paid to the lender by ${paidByOther}` : null,
          billStillOpen: false,
          shared: sharesInstallments
            ? sharedSplitFrom(linkedPeopleForInstallments({ statements: peopleStatements, installmentIds: [due.installmentId], sourceKind: "loan", lenderDue: due.amountDue }))
            : null,
          href: `/loans?agreement=${encodeURIComponent(loan.id)}`,
          actionLabel: due.isPartiallyPaid ? "Continue payment" : "Pay",
        });
      }
    }

    for (const row of emiRows) {
      const emi = row.emi;
      const isClosed = row.status === "closed" || row.status === "completed";
      const carriedBy = cardLookup.carriedByCard(emi.linkedCreditCardId, emi.purchaseTransactionId);
      const sharesInstallments = hasOwnershipShares(emi) || emi.beneficiaryRepaysInstallments === true;
      for (const due of loanCycleDues({ id: emi.id, isClosed, installments: row.installments }, cycleRange, now)) {
        items.push({
          key: `emi:${emi.id}:${due.installmentId}`,
          kind: "emi",
          sourceId: emi.id,
          title: emi.name,
          detail: `${emi.lenderName ? `${emi.lenderName} · ` : ""}EMI ${due.sequenceNumber} of ${due.installmentCount}`,
          dueDate: due.dueDate,
          amountDue: due.amountDue,
          amountPaid: due.amountPaid,
          remaining: due.remaining,
          status: obligationStatus(due.dueDate, due.remaining, now),
          carriedForward: due.carriedForward,
          countsTowardTotal: carriedBy == null,
          note: carriedBy ? `Included in ${carriedBy} bill` : null,
          billStillOpen: false,
          shared: sharesInstallments
            ? sharedSplitFrom(linkedPeopleForInstallments({ statements: peopleStatements, installmentIds: [due.installmentId], sourceKind: "emi", lenderDue: due.amountDue }))
            : null,
          href: `/loans?agreement=${encodeURIComponent(emi.id)}`,
          actionLabel: due.isPartiallyPaid ? "Continue payment" : "Pay",
        });
      }
    }

    // Bills: every outstanding cycle (a cycle reopened by a cancelled payment is owed again), once each.
    const billById = new Map(billRows.map((r) => [r.bill.id, r]));
    for (const { billId, occurrence, remaining } of billObligationsInCycle(outstandingBillOccurrences(billCycles, now), cycleRange, now).items) {
      const row = billById.get(billId);
      if (!row) continue;
      items.push({
        key: `bill:${billId}:${occurrence.id}`,
        kind: "bill",
        sourceId: billId,
        title: row.bill.name,
        detail: row.category?.name ?? "Bill",
        dueDate: occurrence.dueDate,
        amountDue: occurrence.amount,
        amountPaid: occurrence.amountPaid,
        remaining,
        status: obligationStatus(occurrence.dueDate, remaining, now),
        carriedForward: !isInCycle(occurrence.dueDate, cycleRange),
        countsTowardTotal: true,
        note: null,
        billStillOpen: false,
        shared: null,
        href: "/bills",
        actionLabel: occurrence.amountPaid > 0 ? "Continue payment" : "Pay",
      });
    }

    return items.sort(compareObligations);
  }, [cardList, txns, statements, accountList, cycleRange, now, entriesByPersonId, peopleStatements, cardLookup, loanRows, emiRows, billRows, billCycles]);

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
  }, [peopleRows, followUpsByPersonId, statementsByPersonId, cycleRange, now]);

  // ── My spending: My Spend engine, Month Cycle bucketing ──
  const spending = useMemo(() => {
    const bucketDate = (t: Transaction) => mySpendBucketDate(t, isCustomCycle);
    const rows = mySpendRows({ transactions: txns, ctx: mySpendCtx, bucketDate, range: cycleRange });
    const summary = summarizeMySpend(rows);
    const previous = summarizeMySpend(mySpendRows({ transactions: txns, ctx: mySpendCtx, bucketDate, range: previousRange })).mySpend;
    const categoryById = new Map((categories as Category[]).map((c) => [c.id, c]));
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
    };
  }, [txns, mySpendCtx, isCustomCycle, cycleRange, previousRange, categories, isPast]);

  // ── Completed: payments made in the period ──
  const completed = useMemo(() => {
    const events: PaymentEvent[] = [];
    for (const card of cardList) {
      for (const t of txns) {
        if (t.accountId !== card.accountId || t.deletedAt != null || !isCardBillPaymentLeg(t)) continue;
        events.push({ kind: "card", sourceId: card.id, title: cardLookup.label(card), date: t.dateTime, amount: t.amount, href: `/credit-cards?card=${encodeURIComponent(card.id)}` });
      }
    }
    const loanBySchedule = new Map(loanRows.map((r) => [r.loan.scheduleId, r]));
    for (const p of loanPayments) {
      const row = p.scheduleId ? loanBySchedule.get(p.scheduleId) : undefined;
      if (!row || p.deletedAt != null || p.direction !== "taken") continue;
      // A card-funded purchase is paid through the card bill — its installment record is not a second payment.
      if (cardLookup.carriedByCard(row.loan.linkedCreditCardId, row.loan.purchaseTransactionId)) continue;
      events.push({ kind: "loan", sourceId: row.loan.id, title: row.loan.name?.trim() || row.lenderName, date: p.date, amount: p.amount, href: `/loans?agreement=${encodeURIComponent(row.loan.id)}` });
    }
    const emiBySchedule = new Map(emiRows.map((r) => [r.emi.scheduleId, r]));
    for (const p of emiPayments) {
      const row = emiBySchedule.get(p.scheduleId);
      if (!row) continue;
      if (cardLookup.carriedByCard(row.emi.linkedCreditCardId, row.emi.purchaseTransactionId)) continue;
      events.push({ kind: "emi", sourceId: row.emi.id, title: row.emi.name, date: p.date, amount: p.amount, href: `/loans?agreement=${encodeURIComponent(row.emi.id)}` });
    }
    // Bills: each occurrence's live `amountPaid` is authoritative; its `PaymentRecord`s supply the real payment
    // dates (oldest first, capped at `amountPaid`, so a just-reverted record never counts). Any part no record
    // covers yet (legacy, or a payment the record list hasn't caught up with) stays undated — never given the due date.
    const billNameById = new Map(billRows.map((r) => [r.bill.id, r.bill.name]));
    for (const o of billOccurrences) {
      if (o.deletedAt != null || o.amountPaid <= 0) continue;
      const name = billNameById.get(o.billId);
      if (!name) continue;
      const records = (billPaymentsByBillId[o.billId] ?? [])
        .filter((r) => r.deletedAt == null && r.occurrenceId === o.id && r.amount > 0)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      let left = o.amountPaid;
      for (const r of records) {
        if (left <= 0.005) break;
        const amount = round2(Math.min(r.amount, left));
        left = round2(left - amount);
        events.push({ kind: "bill", sourceId: o.billId, title: name, date: r.date, amount, href: "/bills" });
      }
      if (left > 0.005) events.push({ kind: "bill", sourceId: o.billId, title: name, date: null, periodAnchor: o.dueDate, amount: left, href: "/bills" });
    }
    return groupCompleted(events, cycleRange);
  }, [cardList, txns, cardLookup, loanRows, loanPayments, emiRows, emiPayments, billRows, billOccurrences, billPaymentsByBillId, cycleRange]);

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
    completed,
  };
}

export type MyMoneyData = ReturnType<typeof useMyMoneyData>;
