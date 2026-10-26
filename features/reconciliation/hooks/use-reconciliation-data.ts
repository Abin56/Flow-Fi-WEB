"use client";

/**
 * Everything Reconciliation compares against, from the app's existing live (read-only) hooks — plus whether each
 * required source has REALLY loaded. Nothing here writes; no new query, collection or index is introduced.
 *
 * Why the extra tracking: `useFirestoreWatch` resolves its query with an empty list straight away and only later
 * receives the first Firestore snapshot. An empty list before that snapshot is "not loaded yet", not "you have no
 * transactions" — so "No match" may only be shown once every required source has delivered a real snapshot.
 *
 * A snapshot is recognised without touching the shared hook: it arrives through `queryClient.setQueryData`, which
 * React Query records as a *manual* success (the placeholder resolves through the query function instead). Data that
 * was already synced before this page mounted is recognised by having been updated more than once, or by being
 * non-empty — the placeholder is always empty.
 */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { accountsQueryKey, useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { creditCardStatementsQueryKey, creditCardsQueryKey, useAllCreditCardStatements, useCreditCards } from "@/hooks/use-credit-cards";
import { useExpenses } from "@/hooks/use-expenses";
import { useSmsTransactionCandidates } from "@/hooks/use-sms-transaction-candidates";
import { transactionsQueryKey, transactionsTrashQueryKey, useTransactions, useTrashedTransactions } from "@/hooks/use-transactions";
import { retryFirestoreWatch } from "@/lib/services/firestore-watch-registry";
import { useAuthStore } from "@/store/auth-store";
import type { ReconciliationData } from "../components/reconciliation-workspace";

export type SourceName = "accounts" | "cards" | "statements" | "transactions" | "deleted" | "sms";

export interface RecordsSync {
  /** Sources that haven't delivered their first real snapshot yet. */
  loading: SourceName[];
  /** Sources whose live query failed. */
  failed: SourceName[];
  retry: () => void;
}

const SOURCE_LABEL: Record<SourceName, string> = {
  accounts: "accounts",
  cards: "cards",
  statements: "card bills",
  transactions: "transactions",
  deleted: "deleted transactions",
  sms: "Transaction Inbox",
};

export function sourceLabel(name: SourceName): string {
  return SOURCE_LABEL[name];
}

const hash = (key: QueryKey) => JSON.stringify(key);

/** Tracks which watched query keys have received a real snapshot (see module doc). */
export function useSnapshotTracker(keys: QueryKey[]) {
  const queryClient = useQueryClient();
  const [manual, setManual] = useState<ReadonlySet<string>>(() => new Set());
  const [, setTick] = useState(0);
  const watched = useMemo(() => new Set(keys.map(hash)), [keys]);

  // Installed before the data hooks below subscribe (effects run in call order), so the first snapshot isn't missed.
  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !watched.has(event.query.queryHash)) return;
      const action = event.action as { type: string; manual?: boolean };
      if (action.type === "success" && action.manual) setManual((s) => (s.has(event.query.queryHash) ? s : new Set(s).add(event.query.queryHash)));
      else setTick((n) => n + 1); // error / other state changes
    });
  }, [queryClient, watched]);

  return (key: QueryKey): { synced: boolean; failed: boolean } => {
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
    if (!query) return { synced: false, failed: false };
    if (query.state.status === "error") return { synced: false, failed: true };
    const data = query.state.data;
    const synced = manual.has(query.queryHash) || (Array.isArray(data) && data.length > 0) || query.state.dataUpdateCount >= 2;
    return { synced, failed: false };
  };
}

export function useReconciliationData(): ReconciliationData & { sync: RecordsSync } {
  const uid = useAuthStore((s) => s.user?.uid);
  const keys = useMemo(
    () => ({
      accounts: accountsQueryKey(uid),
      cards: creditCardsQueryKey(uid),
      statements: creditCardStatementsQueryKey(uid),
      transactions: transactionsQueryKey(uid),
      deleted: transactionsTrashQueryKey(uid),
    }),
    [uid],
  );
  const keyList = useMemo(() => Object.values(keys) as QueryKey[], [keys]);
  const status = useSnapshotTracker(keyList);

  const accounts = useAccounts();
  const creditCards = useCreditCards();
  const statements = useAllCreditCardStatements();
  const categories = useCategories();
  const transactions = useTransactions();
  const trashed = useTrashedTransactions();
  const sms = useSmsTransactionCandidates();
  const expenses = useExpenses();

  const cardList = creditCards.data ?? [];
  const loading: SourceName[] = [];
  const failed: SourceName[] = [];
  for (const name of ["accounts", "cards", "transactions", "deleted"] as const) {
    const s = status(keys[name]);
    if (s.failed) failed.push(name);
    else if (!s.synced) loading.push(name);
  }
  // Card bills only exist (and the statements listener only runs) once there are cards.
  if (cardList.length > 0) {
    const s = status(keys.statements);
    if (s.failed) failed.push("statements");
    else if (!s.synced) loading.push("statements");
  }
  if (sms.isError) failed.push("sms");
  else if (!sms.hasSnapshot) loading.push("sms");

  return {
    accounts: accounts.data ?? [],
    creditCards: cardList,
    statements: statements.data ?? [],
    categories: categories.data ?? [],
    transactions: transactions.data ?? [],
    trashedTransactions: trashed.data ?? [],
    smsCandidates: sms.data ?? [],
    expenses: expenses.data ?? [],
    sync: {
      loading,
      failed,
      retry: () => {
        for (const name of failed) {
          if (name === "sms") sms.retry();
          else retryFirestoreWatch(keys[name]);
        }
      },
    },
  };
}
