"use client";

/**
 * Repairs ghost People entries left by older transaction-only deletes — e.g. "Exam ₹1,000, you need to pay
 * AMMA" still showing after its person-funded expense was deleted. Mounted once in the app shell, so People,
 * Month Cycle, Net Worth, Debt Planner and Record Payment all stop counting it, whichever page is open.
 *
 * Client data only NOMINATES candidates (`planOrphanReconciliation`); the write
 * (`LedgerRepository.reconcileOrphanedTransactionEntries`) re-reads every candidate and its transaction
 * fresh inside one Firestore transaction and removes only what is still provably owned by a deleted /
 * missing transaction. Removal is a balance-reversing soft delete — the entry stays in trash for audit
 * and comes back with `restorePersonFundedExpense`. Ghosts with a live payment recorded against them are
 * never touched (`blocked`) — the People Ledger shows them as "Original transaction is no longer available".
 * Each candidate is attempted at most once per session.
 */

import { useEffect, useRef } from "react";
import { usePeople } from "@/hooks/use-people";
import { useTransactions, useTrashedTransactions } from "@/hooks/use-transactions";
import { usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { planOrphanReconciliation } from "@/lib/engines/transaction-owned-ledger";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

export function useOrphanLedgerReconciliation(): void {
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const { data: active = [], isLoading: activeLoading } = useTransactions();
  const { data: trashed = [], isLoading: trashLoading } = useTrashedTransactions();
  const actions = useTransactionActions();
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!actions || peopleLoading || entriesLoading || activeLoading || trashLoading) return;
    const byId = new Map<string, Transaction>();
    for (const t of [...(active as Transaction[]), ...(trashed as Transaction[])]) byId.set(t.id, t);
    // A transactionRef absent from both streams is reported as missing (null) — the repository re-verifies.
    const ownerOf = (ref: string) => byId.get(ref) ?? null;

    for (const person of people as Person[]) {
      const entries = entriesByPersonId[person.id] ?? [];
      const ids = planOrphanReconciliation(entries, ownerOf)
        .reconcile.map((e) => e.id)
        .filter((id) => !attempted.current.has(id));
      if (ids.length === 0) continue;
      ids.forEach((id) => attempted.current.add(id));
      actions.reconcileOrphanedEntries(person, ids).catch((error: unknown) => {
        console.warn("[people] couldn't reconcile orphaned ledger entries", person.id, error);
      });
    }
  }, [actions, people, entriesByPersonId, active, trashed, peopleLoading, entriesLoading, activeLoading, trashLoading]);
}

/** Render-nothing mount point for {@link useOrphanLedgerReconciliation}. */
export function OrphanLedgerReconciler(): null {
  useOrphanLedgerReconciliation();
  return null;
}
