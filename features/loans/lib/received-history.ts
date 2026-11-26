import { isPaidDirectlyEntry } from "@/lib/engines/historical-reimbursement";
import { isInCycle } from "@/lib/engines/month-cycle-range";
import { round2 } from "@/lib/engines/person-payment";
import type { LedgerEntry } from "@/lib/models/person";

type ReceiptEntry = Pick<LedgerEntry, "id" | "type" | "amount" | "date" | "deletedAt" | "note" | "recordedEarlier" | "receivedDateKnown" | "paymentId" | "obligationRef">;

/** Saved receipt rows only. A direct lender payment can cover a share without money being received. */
export function isActualReceipt(entry: Pick<ReceiptEntry, "type" | "deletedAt" | "note" | "recordedEarlier">): boolean {
  return entry.deletedAt == null && entry.type === "receivedBack" && !isPaidDirectlyEntry(entry);
}

interface ReceiptGroup<T> {
  key: string;
  date: Date | null;
  amount: number;
  references: Set<string>;
  entries: T[];
}

export function receivedHistory<T extends ReceiptEntry>(entries: readonly T[], cycle: { start: Date; end: Date }) {
  const groups = new Map<string, ReceiptGroup<T>>();
  let receivedThisCycle = 0;
  for (const entry of entries) {
    if (!isActualReceipt(entry)) continue;
    const date = entry.receivedDateKnown === false ? null : entry.date;
    if (date && isInCycle(date, cycle)) receivedThisCycle += entry.amount;
    // A Record Payment may split one receipt across obligations and leave part of it as advance.
    const key = entry.paymentId ? `payment:${entry.paymentId}|${date?.getTime() ?? "unknown"}` : `entry:${entry.id}`;
    const group = groups.get(key) ?? { key, date, amount: 0, references: new Set<string>(), entries: [] };
    group.amount = round2(group.amount + entry.amount);
    if (entry.obligationRef) group.references.add(entry.obligationRef);
    group.entries.push(entry);
    groups.set(key, group);
  }
  return {
    receivedThisCycle: round2(receivedThisCycle),
    recent: [...groups.values()].sort((a, b) => (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity)),
  };
}
