/**
 * One money entry on a savings goal — stored in `users/{uid}/savingsGoals/{goalId}/contributions/{id}`
 * (inside the goal's own subtree, so the existing `savingsGoals/{document=**}` owner rule already covers it).
 *
 * The honest rule: an entry only claims money has MOVED when a real Transaction pair backs it.
 *  - `mode: "earmark"` — money that is already in `accountId` is set aside for the goal. Nothing moves: no
 *    transaction, no balance change, no net-worth change. It is a reservation of existing money.
 *  - `mode: "transfer"` — a real own-account transfer (the same atomic, idempotent transfer pair "Add transfer"
 *    writes: an expense leg + an income leg sharing a `transferId`, so Income/Expense/Net Worth ignore it).
 *    `transactionIds` are those legs. If either leg is deleted elsewhere the entry stops counting — it is
 *    DERIVED from the live legs (see `lib/engines/savings-goals.ts`), so nothing stored can drift.
 *
 * `direction`: "in" adds to the goal, "out" is a withdrawal. `accountId` is always the account the goal's
 * money sits in for this entry (the earmarked account, or the savings account the transfer pays into / out of);
 * `counterAccountId` is the other side of a transfer (the funding source for "in", the destination for "out").
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

export type SavingsEntryDirection = "in" | "out";
export type SavingsEntryMode = "earmark" | "transfer";

export interface SavingsContribution extends SoftDeletableEntity {
  goalId: string;
  direction: SavingsEntryDirection;
  mode: SavingsEntryMode;
  amount: number;
  date: Date;
  /** The account holding the goal's money for this entry; null only for a legacy/opening entry. */
  accountId: string | null;
  /** Transfer only — the other account. */
  counterAccountId: string | null;
  /** Transfer only — the real transaction legs (out + in) that back this entry. */
  transactionIds: string[];
  note: string;
  createdAt: Date;
  /** Withdrawal only — taken out of a LOCKED goal through an explicit emergency release (additive, default false). */
  emergency: boolean;
  /** Set when the entry was recorded by one "Allocate this month" action — groups the batch in history. */
  allocationId: string | null;
}

const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null);

function auditEntryFromMap(map: Record<string, unknown>): AuditEntry {
  return { timestamp: toDate(map.timestamp) ?? new Date(0), field: map.field as string, oldValue: map.oldValue as string, newValue: map.newValue as string };
}

export function savingsContributionFromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>, _options?: SnapshotOptions): SavingsContribution {
  const d = snapshot.data();
  return {
    id: snapshot.id,
    goalId: d.goalId as string,
    direction: d.direction === "out" ? "out" : "in",
    mode: d.mode === "transfer" ? "transfer" : "earmark",
    amount: (d.amount as number) ?? 0,
    date: toDate(d.date) ?? new Date(0),
    accountId: (d.accountId as string | null | undefined) ?? null,
    counterAccountId: (d.counterAccountId as string | null | undefined) ?? null,
    transactionIds: Array.isArray(d.transactionIds) ? (d.transactionIds as string[]) : [],
    note: (d.note as string | undefined) ?? "",
    createdAt: toDate(d.createdAt) ?? new Date(0),
    emergency: d.emergency === true,
    allocationId: typeof d.allocationId === "string" ? d.allocationId : null,
    deletedAt: toDate(d.deletedAt),
    lastEditedAt: toDate(d.lastEditedAt),
    editHistory: ((d.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function savingsContributionToFirestore(c: SavingsContribution): DocumentData {
  return {
    goalId: c.goalId,
    direction: c.direction,
    mode: c.mode,
    amount: c.amount,
    date: Timestamp.fromDate(c.date),
    accountId: c.accountId,
    counterAccountId: c.counterAccountId,
    transactionIds: c.transactionIds,
    note: c.note,
    createdAt: Timestamp.fromDate(c.createdAt),
    emergency: c.emergency,
    allocationId: c.allocationId,
    deletedAt: c.deletedAt == null ? null : Timestamp.fromDate(c.deletedAt),
    lastEditedAt: c.lastEditedAt == null ? null : Timestamp.fromDate(c.lastEditedAt),
    editHistory: c.editHistory.map((e) => ({ timestamp: Timestamp.fromDate(e.timestamp), field: e.field, oldValue: e.oldValue, newValue: e.newValue })),
  };
}
