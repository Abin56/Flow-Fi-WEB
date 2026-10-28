/**
 * READ-ONLY duplicate-cycle detection for the Bills Duplicate Review panel. Pure — no Firestore, no writes, no
 * record is ever merged, deleted, restored or rewritten here. Mirrors the grouping `BillPaymentRepository`'s
 * `duplicateCycleOf` uses to BLOCK a payment (same bill, same due calendar day, every active — non-deleted —
 * occurrence), so the panel explains exactly what the payment guard is reacting to.
 */

import { billOccurrenceStatus, type Bill, type BillOccurrence, type PaymentRecord } from "@/lib/models/bill";
import { outstandingBillOccurrences } from "@/lib/engines/bill-obligations";

function sameDueDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export interface DuplicateOccurrenceRow {
  occurrenceId: string;
  dueDate: Date;
  amount: number;
  amountPaid: number;
  isSkipped: boolean;
  status: ReturnType<typeof billOccurrenceStatus>;
  /** Payment records pointing at this occurrence (cancelled ones included, so the full picture is visible). */
  payments: Pick<PaymentRecord, "id" | "amount" | "date" | "deletedAt" | "recordedEarlier" | "transactionId">[];
  /** Whether `useBillRows`/the Bills page currently shows this as the bill's "current" cycle. */
  isShownAsCurrent: boolean;
}

export interface DuplicateCycleGroup {
  billId: string;
  billName: string;
  dueDate: Date;
  occurrences: DuplicateOccurrenceRow[];
  /** What this duplicate group alone adds to Bills Stats / Month Cycle / Dashboard totals, vs. counting it once. */
  totalsEffect: {
    /** Outstanding total if every unsettled twin in this group is counted (today's actual behaviour). */
    asCountedToday: number;
    /** Outstanding total if only ONE (the oldest-created) occurrence in this group were counted. */
    ifCountedOnce: number;
    /** `asCountedToday - ifCountedOnce` — the overstatement this group alone causes, if positive. */
    overstatement: number;
    /** Extra rows this group alone adds to the Dashboard's unpaid-bills list, vs. counting it once. */
    extraDashboardRows: number;
  };
  /** Plain-language suggestion only — never applied by this panel or any other code path. */
  recommendation: string;
}

/**
 * Groups every bill's active (non-deleted) occurrences by due calendar day; a group of size 1 is not a duplicate
 * and is left out. `now` only affects status/overdue labelling, never which records are grouped.
 */
export function findDuplicateBillCycles(
  bills: ReadonlyArray<Pick<Bill, "id" | "name">>,
  occurrencesByBillId: ReadonlyMap<string, readonly BillOccurrence[]>,
  paymentsByBillId: ReadonlyMap<string, readonly PaymentRecord[]>,
  currentOccurrenceIdByBillId: ReadonlyMap<string, string | null>,
  now: Date = new Date(),
): DuplicateCycleGroup[] {
  const groups: DuplicateCycleGroup[] = [];

  for (const bill of bills) {
    const active = (occurrencesByBillId.get(bill.id) ?? []).filter((o) => o.deletedAt == null);
    const payments = paymentsByBillId.get(bill.id) ?? [];
    const currentId = currentOccurrenceIdByBillId.get(bill.id) ?? null;

    const byDay: BillOccurrence[][] = [];
    for (const occurrence of active) {
      const bucket = byDay.find((g) => sameDueDay(g[0].dueDate, occurrence.dueDate));
      if (bucket) bucket.push(occurrence);
      else byDay.push([occurrence]);
    }

    for (const bucket of byDay) {
      if (bucket.length < 2) continue;
      const sorted = [...bucket].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const rows: DuplicateOccurrenceRow[] = sorted.map((occurrence) => ({
        occurrenceId: occurrence.id,
        dueDate: occurrence.dueDate,
        amount: occurrence.amount,
        amountPaid: occurrence.amountPaid,
        isSkipped: occurrence.isSkipped,
        status: billOccurrenceStatus(occurrence, now),
        payments: payments
          .filter((p) => p.occurrenceId === occurrence.id)
          .map((p) => ({ id: p.id, amount: p.amount, date: p.date, deletedAt: p.deletedAt, recordedEarlier: p.recordedEarlier, transactionId: p.transactionId ?? null })),
        isShownAsCurrent: occurrence.id === currentId,
      }));

      // What Bills Stats / Month Cycle / Dashboard actually sum today (every unsettled twin in the group), vs. what
      // they'd sum if only the oldest-created record in the group existed — the same `outstandingBillOccurrences`
      // engine those screens use, just fed this group's own records instead of every cycle of every bill.
      const unsettledInGroup = outstandingBillOccurrences(sorted.map((occurrence) => ({ billId: bill.id, occurrence })), now);
      const asCountedToday = Math.round(unsettledInGroup.reduce((s, o) => s + o.remaining, 0) * 100) / 100;
      const ifCountedOnce = Math.round(outstandingBillOccurrences([{ billId: bill.id, occurrence: sorted[0] }], now).reduce((s, o) => s + o.remaining, 0) * 100) / 100;
      const overstatement = Math.round((asCountedToday - ifCountedOnce) * 100) / 100;

      const paidTwins = rows.filter((r) => r.amountPaid > 0);
      const recommendation =
        paidTwins.length === 1 && rows.length - paidTwins.length >= 1
          ? `Keep "${paidTwins[0].occurrenceId}" (it has the payment) and remove the other ${rows.length - 1} empty duplicate occurrence(s) for this due date. Do this as a reviewed, separate data-repair action — not from this panel.`
          : paidTwins.length > 1
            ? `More than one of these occurrences has a payment — check each payment's own transaction before deciding which record(s) to keep. This needs manual review, not an automatic merge.`
            : `All ${rows.length} occurrences for this due date are unpaid. Keep one (e.g. the oldest, "${rows[0].occurrenceId}") and remove the rest as a reviewed, separate data-repair action — not from this panel.`;

      groups.push({
        billId: bill.id,
        billName: bill.name,
        dueDate: sorted[0].dueDate,
        occurrences: rows,
        totalsEffect: { asCountedToday, ifCountedOnce, overstatement, extraDashboardRows: Math.max(0, unsettledInGroup.length - 1) },
        recommendation,
      });
    }
  }

  return groups.sort((a, b) => b.dueDate.getTime() - a.dueDate.getTime());
}
