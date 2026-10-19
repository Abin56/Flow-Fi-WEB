/**
 * Dashboard bill outputs — Upcoming payments (bill rows), Upcoming Bills and Needs your attention — mapped from the
 * SAME occurrence-level obligations Bills Stats, Month Cycle and My Money use (`lib/engines/bill-obligations.ts`).
 *
 * This is presentation mapping only: amounts are each cycle's remaining (partial payments respected), counts and the
 * overdue total come from `billObligationStats`, and nothing here creates a transaction or touches an account.
 * Overdue and upcoming are kept apart: an overdue cycle is never worded as "due in N days".
 */

import { billObligationStats, type OutstandingBillOccurrence } from "@/lib/engines/bill-obligations";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Whole calendar days from today to `due` — negative once overdue. */
export function daysUntil(due: Date, now: Date): number {
  return Math.round((dayStart(due) - dayStart(now)) / MS_PER_DAY);
}

export interface DashboardBillRow {
  /** One row per outstanding CYCLE: a bill with two open cycles has two rows. */
  id: string;
  billId: string;
  name: string;
  amount: number;
  dueDate: Date;
  daysLeft: number;
  overdue: boolean;
  partPaid: boolean;
}

export interface DashboardBillAttention {
  id: string;
  type: "bill";
  title: string;
  subtitle: string;
  amount: number;
  note: string;
  cta: string;
}

export function dashboardBillRows(outstanding: readonly OutstandingBillOccurrence[], billNameById: ReadonlyMap<string, string>, now: Date): DashboardBillRow[] {
  const rows: DashboardBillRow[] = [];
  for (const { billId, occurrence, remaining, isOverdue } of outstanding) {
    const name = billNameById.get(billId);
    if (!name) continue; // bill deleted / not loaded
    rows.push({
      id: `bill-${billId}:${occurrence.id}`,
      billId,
      name,
      amount: remaining,
      dueDate: occurrence.dueDate,
      daysLeft: daysUntil(occurrence.dueDate, now),
      overdue: isOverdue,
      partPaid: occurrence.amountPaid > 0,
    });
  }
  return rows;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Up to two alerts: ONE overdue summary (what is actually owed on every past-due cycle, oldest first) and the NEXT
 * upcoming bill. Either may be absent.
 */
export function dashboardBillAttention(rows: readonly DashboardBillRow[], outstanding: readonly OutstandingBillOccurrence[], now: Date, formatDate: (d: Date) => string): DashboardBillAttention[] {
  const items: DashboardBillAttention[] = [];
  const shown = new Set(rows.map((r) => r.id));
  const stats = billObligationStats(outstanding.filter((o) => shown.has(`bill-${o.billId}:${o.occurrence.id}`)), now);
  const overdue = rows.filter((r) => r.overdue);
  if (overdue.length > 0) {
    const oldest = overdue[0];
    items.push({
      id: "attn-bill-overdue",
      type: "bill",
      title: "Overdue Bill",
      subtitle: overdue.length === 1 ? oldest.name : `${plural(overdue.length, "bill")} overdue`,
      amount: stats.overdueAmount,
      note: overdue.length === 1 ? `Overdue by ${plural(-oldest.daysLeft, "day")} · due ${formatDate(oldest.dueDate)}` : `Oldest due ${formatDate(oldest.dueDate)}`,
      cta: "Pay Now",
    });
  }
  const next = rows.find((r) => !r.overdue);
  if (next) {
    items.push({
      id: `attn-bill-${next.id}`,
      type: "bill",
      title: "Upcoming Bill",
      subtitle: next.name,
      amount: next.amount,
      note: next.daysLeft <= 0 ? "Due today" : `Due in ${plural(next.daysLeft, "day")}`,
      cta: "Pay Now",
    });
  }
  return items;
}
