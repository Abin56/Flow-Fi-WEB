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
      existing.totalAmount += t.amount;
      continue;
    }
    derived.set(key, {
      cardId: card.id,
      id: `derived:${card.id}:${key}`,
      isMaterialized: false,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      dueDate: window.dueDate,
      totalAmount: t.amount,
      amountPaid: 0,
      remaining: 0,
      isClosed: key < today,
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
