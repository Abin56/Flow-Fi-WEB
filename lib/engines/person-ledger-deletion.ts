/**
 * Which Person-ledger entries a delete may remove, and which it must leave alone. Pure: no React, no
 * Firebase I/O — `LedgerRepository.softDeleteEntries` performs the (balance-reversing) writes.
 *
 * Only ledger-owned entries are removable from the People Ledger:
 *  - An entry whose `transactionRef` is its OWN cash leg — the `isPersonLedgerMovement` Transaction
 *    `addEntryWithTransaction` posted with it (ids passed in as `cashLegIds`) — is ledger-owned: it is
 *    removed together with that Transaction (`LedgerRepository.softDeleteEntriesWithCashLegs`).
 *  - Any other entry with a `transactionRef` belongs to another record — a split/assigned expense (its share,
 *    the "Received:" status entry, or a split settlement that also recorded an installment payment) or
 *    a legacy Loan. Deleting it here would leave that expense's installments, payments and other
 *    participants out of step, so those stay and are managed from the expense (or the Loan).
 *  - A settlement recorded against one entry (`parentEntryId`) goes with that entry, so no settlement
 *    is ever left pointing at a deleted transaction.
 *
 * Deletion is a soft delete that reverses each entry's signed effect on `Person.currentBalance` — the
 * same path `LedgerRepository.softDeleteEntry` has always used — so the balance, the cycle statement
 * (which reads active entries only) and every People total stay consistent.
 */

import { type LedgerEntry, signedAmount } from "@/lib/models/person";

export type EntryDeletionBlock = "notFound" | "linked";

export type EntryDeletionPlan =
  | {
      ok: true;
      /** The entry itself first, then every active settlement recorded against it. */
      entries: LedgerEntry[];
      dependentSettlements: LedgerEntry[];
      /** Signed change to the person's balance once these are removed (FlowFi sign: + they owe me more). */
      balanceDelta: number;
    }
  | { ok: false; reason: EntryDeletionBlock };

const round2 = (v: number) => Math.round(v * 100) / 100;

const NO_CASH_LEGS: ReadonlySet<string> = new Set();

const isActive = (e: LedgerEntry) => e.deletedAt == null;
/** Owned by the ledger itself: no linked record, or the link is the entry's own People cash leg. */
const isStandalone = (e: LedgerEntry, cashLegIds: ReadonlySet<string>) => e.transactionRef == null || cashLegIds.has(e.transactionRef);

function balanceDeltaOf(entries: LedgerEntry[]): number {
  return round2(-entries.reduce((sum, e) => sum + signedAmount(e), 0)) || 0;
}

/**
 * `cashLegIds`: ids of People cash-leg Transactions (`isPersonLedgerMovement`, active or trashed) — an
 * entry pointing at one of them is ledger-owned. Omitted = the pre-cash-leg rule (only `transactionRef`-less
 * entries are removable).
 */
export function planEntryDeletion(entryId: string, allEntries: readonly LedgerEntry[], cashLegIds: ReadonlySet<string> = NO_CASH_LEGS): EntryDeletionPlan {
  const active = allEntries.filter(isActive);
  const entry = active.find((e) => e.id === entryId);
  if (entry == null) return { ok: false, reason: "notFound" };
  if (!isStandalone(entry, cashLegIds)) return { ok: false, reason: "linked" };
  const dependentSettlements = active.filter((e) => e.id !== entry.id && e.parentEntryId === entry.id);
  // A settlement that is itself tied to another record can't be removed from here — so neither can its parent.
  if (dependentSettlements.some((e) => !isStandalone(e, cashLegIds))) return { ok: false, reason: "linked" };
  const entries = [entry, ...dependentSettlements];
  return { ok: true, entries, dependentSettlements, balanceDelta: balanceDeltaOf(entries) };
}

/** Whether a single entry can be deleted from the People Ledger (see `planEntryDeletion`). */
export function canDeleteEntry(entryId: string, allEntries: readonly LedgerEntry[], cashLegIds: ReadonlySet<string> = NO_CASH_LEGS): boolean {
  return planEntryDeletion(entryId, allEntries, cashLegIds).ok;
}

export interface BulkDeletionPlan {
  /** Every active standalone entry — parents immediately followed by their settlements. */
  entries: LedgerEntry[];
  /** Active entries that belong to a split expense or Loan and are left in place. */
  keptLinked: LedgerEntry[];
  balanceDelta: number;
}

/**
 * "Delete all transactions" for one person: every active standalone entry. A standalone settlement
 * recorded against a linked entry is standalone itself, so it is removed too — the linked entry simply
 * reopens by that amount, exactly as deleting that settlement on its own would.
 */
export function planBulkDeletion(allEntries: readonly LedgerEntry[], cashLegIds: ReadonlySet<string> = NO_CASH_LEGS): BulkDeletionPlan {
  const active = allEntries.filter(isActive);
  const standalone = active.filter((e) => isStandalone(e, cashLegIds));
  const keptLinked = active.filter((e) => !isStandalone(e, cashLegIds));

  // Keep each parent next to its settlements so a chunked write never separates them needlessly.
  const byParent = new Map<string, LedgerEntry[]>();
  for (const e of standalone) {
    if (e.parentEntryId == null) continue;
    const list = byParent.get(e.parentEntryId) ?? [];
    list.push(e);
    byParent.set(e.parentEntryId, list);
  }
  const standaloneIds = new Set(standalone.map((e) => e.id));
  const ordered: LedgerEntry[] = [];
  const placed = new Set<string>();
  const place = (e: LedgerEntry) => {
    if (placed.has(e.id)) return;
    placed.add(e.id);
    ordered.push(e);
  };
  for (const e of standalone) {
    if (e.parentEntryId != null && standaloneIds.has(e.parentEntryId)) continue; // placed with its parent
    place(e);
    for (const child of byParent.get(e.id) ?? []) place(child);
  }
  for (const e of standalone) place(e);

  return { entries: ordered, keptLinked, balanceDelta: balanceDeltaOf(ordered) };
}
