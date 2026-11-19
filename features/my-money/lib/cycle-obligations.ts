/**
 * The ONE place that turns FlowFi's live records into "what is owed in a Month Cycle" and "what was paid in it" —
 * shared by My Money (To pay / Completed) and Bills, so the two pages cannot disagree. Pure: no React, no Firebase,
 * nothing is written and no amount is re-derived here; every figure comes from the engine that owns it:
 *  - Card bills   → `cardBillsForCard` + `cardBillsDueInCycle` (per physical card).
 *  - Loan / EMI   → `loanCycleDues` over each schedule's live `Installment`s (partial + advance payments are already
 *                   in `amountPaid`; carried overdue stays its own row).
 *  - Regular bills → `billObligationsInCycle` over EVERY outstanding cycle (a cycle reopened by a cancelled payment
 *                   is owed again), each once, at its live remainder.
 *  - Card-funded EMIs → `emiPurchaseRepresentedOnCard`: when the purchase is on the card, the card bill carries the
 *                   money and the installment is listed but NOT counted (`countsTowardTotal: false`) — no double count.
 *  - Completed    → payments by their own recorded date, from the same records the payments were written to.
 *
 * Moving this out of `use-my-money-data.ts` changed no rule: that hook now calls these functions with the same inputs.
 */

import type { BillCycleRef, BillRow } from "@/features/bills/hooks/use-bills-data";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { compareObligations, obligationStatus, sharedSplitFrom, type ObligationItem, type PaymentEvent } from "@/features/my-money/lib/my-money";
import { billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import { cardBillsDueInCycle, cardBillsForCard } from "@/lib/engines/card-cycle-bills";
import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import { hasOwnershipShares } from "@/lib/engines/debt-ownership";
import { linkedPeopleForCard, linkedPeopleForInstallments } from "@/lib/engines/linked-people-readiness";
import { loanCycleDues } from "@/lib/engines/loan-cycle-dues";
import { isInCycle } from "@/lib/engines/month-cycle-range";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { isCardBillPaymentLeg } from "@/lib/repositories/credit-card-repository";
import type { Account } from "@/lib/models/account";
import type { BillOccurrence, PaymentRecord } from "@/lib/models/bill";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { LedgerEntry } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

const round2 = (v: number) => Math.round(v * 100) / 100;

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// ───────────────────────────── card label + card-funded rule ─────────────────────────────

export interface CardLookup {
  /** "HDFC Regalia ••1234". */
  label: (card: CreditCardProfile) => string;
  /** The tracked card whose bill already carries this agreement's purchase (Case A), else null. */
  carriedByCard: (linkedCreditCardId: string | null | undefined, purchaseTransactionId: string | null | undefined) => string | null;
}

/** Card display label + the card-funded-EMI rule (`emiPurchaseRepresentedOnCard`), shared by To pay and Completed. */
export function makeCardLookup(params: { accounts: readonly Account[]; cards: readonly CreditCardProfile[]; transactions: readonly Transaction[] }): CardLookup {
  const accountById = new Map(params.accounts.map((a) => [a.id, a]));
  const cardById = new Map(params.cards.map((c) => [c.id, c]));
  const txnById = new Map(params.transactions.filter((t) => t.deletedAt == null).map((t) => [t.id, t]));
  const label = (card: CreditCardProfile) => {
    const name = accountById.get(card.accountId)?.name ?? "Credit card";
    return card.lastFourDigits ? `${name} ••${card.lastFourDigits}` : name;
  };
  const carriedByCard: CardLookup["carriedByCard"] = (linkedCreditCardId, purchaseTransactionId) => {
    const card = linkedCreditCardId ? cardById.get(linkedCreditCardId) : undefined;
    if (!card) return null;
    return emiPurchaseRepresentedOnCard(purchaseTransactionId ?? null, txnById.get(purchaseTransactionId ?? ""), card.accountId) ? label(card) : null;
  };
  return { label, carriedByCard };
}

// ───────────────────────────── owed in a cycle ─────────────────────────────

export interface CycleObligationsInput {
  /** Live (non-trashed) cards. */
  cards: readonly CreditCardProfile[];
  transactions: readonly Transaction[];
  statements: readonly Statement[];
  accounts: readonly Account[];
  loanRows: readonly LoanRow[];
  emiRows: readonly EmiRow[];
  billRows: readonly BillRow[];
  /** Every persisted cycle of every bill (`useBillRows().cycles`). */
  billCycles: readonly BillCycleRef[];
  cycleRange: { start: Date; end: Date };
  now: Date;
  lookup: CardLookup;
  /**
   * People shares under each lender obligation (My Money's "shared" breakdown). Optional: it never changes an
   * amount owed — only how the obligation is explained — so Bills leaves it out and avoids the whole-history read.
   */
  people?: { statements: readonly PersonCycleStatement[]; ledgerEntries: readonly LedgerEntry[] } | null;
}

/** Every obligation owed in `cycleRange` (inside it, or earlier and still unpaid — carried forward), most urgent first. */
export function buildCycleObligations(input: CycleObligationsInput): ObligationItem[] {
  const { cards, transactions: txns, statements, accounts, loanRows, emiRows, billRows, billCycles, cycleRange, now, lookup, people } = input;
  const items: ObligationItem[] = [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));

  for (const card of cards) {
    const cardTxns = txns.filter((t) => t.accountId === card.accountId);
    const bills = cardBillsForCard(card, cardTxns, statements as Statement[], now);
    const openingBalance = accounts.find((a) => a.id === card.accountId)?.openingBalance ?? 0;
    for (const bill of cardBillsDueInCycle(bills, cycleRange, now)) {
      const readiness = people
        ? linkedPeopleForCard({
            statements: people.statements,
            ledgerEntries: people.ledgerEntries,
            transactions: txns,
            cardAccountId: card.accountId,
            cardOpeningBalance: openingBalance,
            lenderDue: bill.remaining,
            chargeScope: new Set(bill.chargeIds),
          })
        : null;
      items.push({
        key: `card:${card.id}:${bill.id}`,
        kind: "card",
        sourceId: card.id,
        title: lookup.label(card),
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
        shared: readiness ? sharedSplitFrom(readiness) : null,
        href: bill.isClosed ? `/credit-cards?card=${encodeURIComponent(card.id)}&pay=1` : `/credit-cards?card=${encodeURIComponent(card.id)}`,
        actionLabel: bill.isClosed ? "Pay bill" : "View card",
        payHref: bill.isClosed ? `/credit-cards?card=${encodeURIComponent(card.id)}&pay=1` : null,
        related: lookup.label(card),
        minimumDue: bill.minimumDue,
      });
    }
  }

  for (const row of loanRows) {
    if (row.direction !== "taken") continue;
    const loan = row.loan;
    const carriedBy = lookup.carriedByCard(loan.linkedCreditCardId, loan.purchaseTransactionId);
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
        shared:
          sharesInstallments && people
            ? sharedSplitFrom(linkedPeopleForInstallments({ statements: people.statements, installmentIds: [due.installmentId], sourceKind: "loan", lenderDue: due.amountDue }))
            : null,
        href: `/loans?agreement=${encodeURIComponent(loan.id)}`,
        actionLabel: due.isPartiallyPaid ? "Continue payment" : "Pay",
        installmentId: due.installmentId,
        payHref: `/loans?agreement=${encodeURIComponent(loan.id)}&installment=${encodeURIComponent(due.installmentId)}&pay=1`,
        related: carriedBy,
        agreementRemaining: { amount: row.outstandingPrincipal, label: "Principal outstanding" },
      });
    }
  }

  for (const row of emiRows) {
    const emi = row.emi;
    const isClosed = row.status === "closed" || row.status === "completed";
    const carriedBy = lookup.carriedByCard(emi.linkedCreditCardId, emi.purchaseTransactionId);
    const sharesInstallments = hasOwnershipShares(emi) || emi.beneficiaryRepaysInstallments === true;
    const autoDebit = emi.autoDebitAccount ? (accountName.get(emi.autoDebitAccount) ?? null) : null;
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
        shared:
          sharesInstallments && people
            ? sharedSplitFrom(linkedPeopleForInstallments({ statements: people.statements, installmentIds: [due.installmentId], sourceKind: "emi", lenderDue: due.amountDue }))
            : null,
        href: `/loans?agreement=${encodeURIComponent(emi.id)}`,
        actionLabel: due.isPartiallyPaid ? "Continue payment" : "Pay",
        installmentId: due.installmentId,
        payHref: `/emi?agreement=${encodeURIComponent(emi.id)}&installment=${encodeURIComponent(due.installmentId)}&pay=1`,
        related: carriedBy ?? autoDebit,
        agreementRemaining: { amount: row.remainingBalance, label: "Left on this EMI" },
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
      occurrenceId: occurrence.id,
      payHref: null,
      related: row.account?.name ?? null,
    });
  }

  return items.sort(compareObligations);
}

// ───────────────────────────── paid in a cycle ─────────────────────────────

export interface CompletedEventsInput {
  cards: readonly CreditCardProfile[];
  transactions: readonly Transaction[];
  lookup: CardLookup;
  loanRows: readonly LoanRow[];
  loanPayments: ReadonlyArray<{ scheduleId?: string | null; deletedAt?: Date | null; direction?: string; date: Date; amount: number }>;
  emiRows: readonly EmiRow[];
  emiPayments: ReadonlyArray<{ scheduleId: string; date: Date; amount: number }>;
  billRows: readonly BillRow[];
  billOccurrences: readonly BillOccurrence[];
  billPaymentsByBillId: Readonly<Record<string, readonly PaymentRecord[]>>;
}

/**
 * Every recorded payment as a dated event (grouping by cycle is `groupCompleted`'s job). Card bill payment legs,
 * Loan / EMI installment payments, and bill `PaymentRecord`s — a card-funded installment is NOT a payment of its own
 * (it is paid through the card bill), and a bill part no record covers stays undated, never given the due date.
 */
export function buildCompletedEvents(input: CompletedEventsInput): PaymentEvent[] {
  const { cards, transactions: txns, lookup, loanRows, loanPayments, emiRows, emiPayments, billRows, billOccurrences, billPaymentsByBillId } = input;
  const events: PaymentEvent[] = [];
  for (const card of cards) {
    for (const t of txns) {
      if (t.accountId !== card.accountId || t.deletedAt != null || !isCardBillPaymentLeg(t)) continue;
      events.push({ kind: "card", sourceId: card.id, title: lookup.label(card), date: t.dateTime, amount: t.amount, href: `/credit-cards?card=${encodeURIComponent(card.id)}` });
    }
  }
  const loanBySchedule = new Map(loanRows.map((r) => [r.loan.scheduleId, r]));
  for (const p of loanPayments) {
    const row = p.scheduleId ? loanBySchedule.get(p.scheduleId) : undefined;
    if (!row || p.deletedAt != null || p.direction !== "taken") continue;
    // A card-funded purchase is paid through the card bill — its installment record is not a second payment.
    if (lookup.carriedByCard(row.loan.linkedCreditCardId, row.loan.purchaseTransactionId)) continue;
    events.push({ kind: "loan", sourceId: row.loan.id, title: row.loan.name?.trim() || row.lenderName, date: p.date, amount: p.amount, href: `/loans?agreement=${encodeURIComponent(row.loan.id)}` });
  }
  const emiBySchedule = new Map(emiRows.map((r) => [r.emi.scheduleId, r]));
  for (const p of emiPayments) {
    const row = emiBySchedule.get(p.scheduleId);
    if (!row) continue;
    if (lookup.carriedByCard(row.emi.linkedCreditCardId, row.emi.purchaseTransactionId)) continue;
    events.push({ kind: "emi", sourceId: row.emi.id, title: row.emi.name, date: p.date, amount: p.amount, href: `/loans?agreement=${encodeURIComponent(row.emi.id)}` });
  }
  // Bills: each occurrence's live `amountPaid` is authoritative; its `PaymentRecord`s supply the real payment dates
  // (oldest first, capped at `amountPaid`, so a just-reverted record never counts). Any part no record covers yet
  // (legacy, or a payment the record list hasn't caught up with) stays undated — never given the due date.
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
  return events;
}
