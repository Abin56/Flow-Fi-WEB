/**
 * D10 — which card bill a statement row's date falls in, and whether that bill is still open. Read-only: built on
 * the same `cardBillsForCard` engine Month Cycle and Credit Cards use (stored statements with live totals + derived
 * cycles + payments settled oldest-first), plus `statementWindowForDate` for a cycle that has no charges yet. No
 * bill math is added or changed here.
 *
 * A row dated in a CLOSED (or already PAID) cycle is blocked from "Import as new" until it is reviewed separately:
 * importing it would change a bill that has already been generated or settled.
 */

import { cardBillsForCard } from "@/lib/engines/card-cycle-bills";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { statementWindowForDate } from "@/lib/repositories/credit-card-repository";
import type { CycleInfo } from "./types";

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Resolver for one card: date → cycle info. Null for a non-card statement account. */
export function buildCycleResolver(params: {
  card: CreditCardProfile | null;
  transactions: Transaction[];
  statements: Statement[];
  now?: Date;
}): (date: Date) => CycleInfo | null {
  const { card } = params;
  if (!card) return () => null;
  const now = params.now ?? new Date();
  const today = dayIndex(now);
  const cardTransactions = params.transactions.filter((t) => t.accountId === card.accountId && t.deletedAt == null);
  const bills = cardBillsForCard(card, cardTransactions, params.statements, now);

  return (date: Date) => {
    const day = dayIndex(date);
    const bill = bills.find((b) => day >= dayIndex(b.periodStart) && day <= dayIndex(b.periodEnd));
    if (bill) {
      const paid = bill.isClosed && bill.totalAmount > 0 && bill.remaining <= 0.005;
      return { status: paid ? "paid" : bill.isClosed ? "closed" : "open", periodStart: bill.periodStart, periodEnd: bill.periodEnd, dueDate: bill.dueDate };
    }
    const window = statementWindowForDate(card, date);
    return { status: dayIndex(window.periodEnd) < today ? "closed" : "open", periodStart: window.periodStart, periodEnd: window.periodEnd, dueDate: window.dueDate };
  };
}
