/**
 * Flags transaction ids sharing the same amount and exact calendar day with at least one other
 * transaction in the same list — the same "amount + exact date alone is enough" signal already
 * enforced at SMS/PDF import time (see `lib/services/duplicate-detection`), surfaced directly on the
 * already-committed Transactions list so an existing duplicate (imported before that gate existed,
 * or slipped past a confirmed "Import Anyway") is still visible, not just prevented going forward.
 *
 * Deliberately description/account/direction-independent, matching that same fallback rule — this is
 * a visual hint on already-real data, not a write-path gate, so there's no false-positive cost to
 * being broad here the way there would be at import time.
 *
 * Transfer pairs (`transferId` set) are excluded: a transfer's source withdrawal and destination
 * deposit are expected to share the same amount and date by design and are never a duplicate.
 */

export interface TransactionForDuplicateGrouping {
  id: string;
  amount: number;
  dateTime: Date;
  transferId: string | null;
}

export function findSameAmountDateDuplicateIds(transactions: TransactionForDuplicateGrouping[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const transaction of transactions) {
    if (transaction.transferId != null) continue;
    const key = `${transaction.amount.toFixed(2)}_${transaction.dateTime.toISOString().slice(0, 10)}`;
    const ids = groups.get(key);
    if (ids) ids.push(transaction.id);
    else groups.set(key, [transaction.id]);
  }

  const duplicateIds = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length > 1) for (const id of ids) duplicateIds.add(id);
  }
  return duplicateIds;
}
