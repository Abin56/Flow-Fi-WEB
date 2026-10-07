/**
 * Every credit-card bill (statement obligation) for one card, as Month Cycle consumes it.
 *
 * This web app never calls `StatementRepository.materializeIfDue`, so most closed billing cycles have
 * NO stored `Statement` document. Reading only stored statements (as Month Cycle used to) silently
 * dropped those bills. This engine builds each bill from the same authoritative pieces the Credit Cards
 * screen uses — no new math:
 *  - Stored statements, with their total recomputed live (`statementPeriodTotal`).
 *  - Derived bills for card transactions no stored statement covers, grouped into the statement window
 *    `statementWindowForDate` assigns (card `statementDay` / `paymentDueDay`, via `CycleAnchor`).
 *    The still-open cycle is included too (`isClosed: false`) — its due date is already fixed.
 *  - Card bill payments (`cardPaymentTotal`) settled oldest-due first (`settleCardPayments`).
 *
 * Pure: nothing is written. Which month cycle a bill belongs to is decided by its `dueDate` only.
 */

import { statementWithLiveTotal, type CreditCardProfile, type Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import {
  cardPaymentTotal,
  cardStatementAmount,
  countsTowardCardStatement,
  settleCardPayments,
  statementPeriodTotal,
  statementWindowForDate,
} from "@/lib/repositories/credit-card-repository";

export interface CardBill {
  cardId: string;
  /** Stored statement id, or `derived:<cardId>:<periodEnd>` for a not-yet-materialized cycle. */
  id: string;
  isMaterialized: boolean;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  totalAmount: number;
  amountPaid: number;
  remaining: number;
  /** The statement period has ended (the bill is generated) — false for the cycle still in progress. */
  isClosed: boolean;
  /** Issuer minimum due — only a stored statement carries one; null = not tracked (never invented). */
  minimumDue: number | null;
  /** Ids of the card transactions this bill is made of — People gating scopes by these, never by rupees. */
  chargeIds: string[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function containsDay(period: { periodStart: Date; periodEnd: Date }, date: Date): boolean {
  const day = dayIndex(date);
  return day >= dayIndex(period.periodStart) && day <= dayIndex(period.periodEnd);
}

export function cardBillsForCard(
  card: CreditCardProfile,
  cardTransactions: Transaction[],
  storedStatements: Statement[],
  now: Date = new Date(),
): CardBill[] {
  const today = dayIndex(now);
  const stored = storedStatements.filter((s) => s.deletedAt == null && s.cardId === card.id);

  const bills: CardBill[] = stored.map((s) => {
    const live = statementWithLiveTotal(s, statementPeriodTotal(cardTransactions, s), s.minimumDue);
    return {
      cardId: card.id,
      id: s.id,
      isMaterialized: true,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      dueDate: s.dueDate,
      totalAmount: live.totalAmount,
      amountPaid: live.amountPaid,
      remaining: 0,
      isClosed: dayIndex(s.periodEnd) < today,
      minimumDue: s.minimumDue ?? null,
      chargeIds: cardTransactions.filter((t) => countsTowardCardStatement(t) && t.type === "expense" && containsDay(s, t.dateTime)).map((t) => t.id),
    };
  });

  // Transactions no stored statement covers → grouped by the statement window that owns them.
  const derived = new Map<number, CardBill>();
  for (const t of cardTransactions) {
    if (!countsTowardCardStatement(t)) continue;
    if (stored.some((s) => containsDay(s, t.dateTime))) continue;
    const window = statementWindowForDate(card, t.dateTime);
    const key = dayIndex(window.periodEnd);
    const existing = derived.get(key);
    if (existing) {
      existing.totalAmount += cardStatementAmount(t);
      if (t.type === "expense") existing.chargeIds.push(t.id);
      continue;
    }
    derived.set(key, {
      cardId: card.id,
      id: `derived:${card.id}:${key}`,
      isMaterialized: false,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      dueDate: window.dueDate,
      totalAmount: cardStatementAmount(t),
      amountPaid: 0,
      remaining: 0,
      isClosed: key < today,
      minimumDue: null,
      chargeIds: t.type === "expense" ? [t.id] : [],
    });
  }
  bills.push(...derived.values());

  const settled = settleCardPayments(bills, 0, cardPaymentTotal(cardTransactions)).statements;
  return settled
    .map((b) => ({
      ...b,
      totalAmount: round2(b.totalAmount),
      amountPaid: round2(b.amountPaid),
      remaining: round2(Math.min(Math.max(b.totalAmount - b.amountPaid, 0), Math.max(b.totalAmount, 0))),
    }))
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

export interface CardCycleBill extends CardBill {
  overdue: boolean;
  /** Due in an EARLIER cycle, still unpaid — carried into this one (always also `overdue`). */
  carriedForward: boolean;
}

/**
 * Unpaid bills owed in `cycle`: due inside it, plus earlier unpaid bills already past due by `now`
 * (carried forward — same rule as `loanCycleDues`). Paid bills are never owed.
 */
export function cardBillsDueInCycle(bills: CardBill[], cycle: { start: Date; end: Date }, now: Date = new Date()): CardCycleBill[] {
  const start = dayIndex(cycle.start);
  const end = dayIndex(cycle.end);
  const today = dayIndex(now);
  const result: CardCycleBill[] = [];
  for (const b of bills) {
    if (b.remaining <= 0) continue;
    const due = dayIndex(b.dueDate);
    const inCycle = due >= start && due <= end;
    const carried = due < start && due < today;
    if (!inCycle && !carried) continue;
    result.push({ ...b, overdue: due < today, carriedForward: carried });
  }
  return result;
}

/**
 * THE canonical answer to "which statement is normal Pay Now paying right now?" — every Pay bill
 * surface (Card bills table, Pay now prefill, the dialog's bill summary, People readiness) reads this.
 *
 * ONE Pay Now = ONE bill: the OLDEST closed statement with something still unpaid (`current`).
 * Payments are not tagged to a statement — the allocator (`settleCardPayments`) applies every payment
 * oldest due first — so the oldest unpaid statement is the one any payment settles first; naming any
 * other would misdescribe where the money goes. Later closed statements (`later`) and the open cycle's
 * spend (`unbilled`) stay on the card as the next bills and are never folded into the Pay Now amount.
 * Closed ≠ due: `currentOverdue` says whether `current` is already past its own due date. Paying several
 * statements at once is only the explicit "full outstanding" choice.
 *
 * Per PHYSICAL card: a shared-limit sibling's statements are never included.
 */
export interface CardStatementPaymentScope {
  /** Every closed statement with something still unpaid, oldest due first — the allocation order. */
  statements: CardBill[];
  /** The ONE bill normal Pay Now targets (`statements[0]`); null when no closed statement is unpaid. */
  current: CardBill | null;
  /** `current` is past its due date. */
  currentOverdue: boolean;
  /** Closed statements after `current`, still unpaid — next bills, NOT part of a normal payment. */
  later: CardBill[];
  /** `current.remaining` — the normal Pay Now amount (0 when no closed statement is unpaid). */
  statementDue: number;
  /** Σ remaining of every closed unpaid statement (`current` + `later`). */
  closedDue: number;
  /** Remaining on the still-open cycle(s) — the next statement's spend, not billed yet. */
  unbilled: number;
  /** `closedDue + unbilled` — this physical card's own outstanding. */
  cardOutstanding: number;
}

export function cardStatementPaymentScope(bills: readonly CardBill[], now: Date = new Date()): CardStatementPaymentScope {
  const statements = bills.filter((b) => b.isClosed && b.remaining > 0).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const current = statements[0] ?? null;
  const closedDue = round2(statements.reduce((s, b) => s + b.remaining, 0));
  const unbilled = round2(bills.filter((b) => !b.isClosed).reduce((s, b) => s + b.remaining, 0));
  return {
    statements,
    current,
    currentOverdue: current != null && dayIndex(current.dueDate) < dayIndex(now),
    later: statements.slice(1),
    statementDue: current?.remaining ?? 0,
    closedDue,
    unbilled,
    cardOutstanding: round2(closedDue + unbilled),
  };
}

/**
 * The card charges a payment of `amount` may be People-gated on: the current bill's own charges (by
 * transaction id) while the amount stays within that bill — an exact or partial Pay Now never reaches
 * the next statement. Null (no statement restriction; oldest-first reach decides) once the user
 * explicitly pays beyond the current bill, e.g. full outstanding.
 */
export function payBillChargeScope(scope: CardStatementPaymentScope, amount: number): ReadonlySet<string> | null {
  if (scope.current == null || amount > scope.current.remaining + 0.005) return null;
  return new Set(scope.current.chargeIds);
}

export type PayBillChoice = "statement" | "full";

/**
 * The amount "Pay bill" opens with. "statement" (the default) = the current bill's remaining — never
 * several statements, never the card's whole outstanding; nothing pre-filled when no closed statement
 * is unpaid. "full" is the explicit "pay everything this card owes" choice (this physical card's own
 * outstanding — never a shared facility's pooled total).
 */
export function payBillAmount(scope: CardStatementPaymentScope, choice: PayBillChoice, ownOutstanding: number): number | undefined {
  if (choice === "full") return ownOutstanding > 0 ? round2(ownOutstanding) : undefined;
  return scope.statementDue > 0 ? scope.statementDue : undefined;
}
