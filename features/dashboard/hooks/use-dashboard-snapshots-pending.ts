"use client";

import { useCallback, useSyncExternalStore } from "react";
import { notifyManager, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { accountsQueryKey } from "@/hooks/use-accounts";
import { billsQueryKey } from "@/hooks/use-bills";
import { categoriesQueryKey } from "@/hooks/use-categories";
import { creditCardsQueryKey, creditCardStatementsQueryKey, emiPaymentBreakdownsQueryKey, emisQueryKey, sharedCreditLimitsQueryKey } from "@/hooks/use-credit-cards";
import { emiInstallmentsQueryKey } from "@/hooks/use-emis";
import { expenseInstallmentsQueryKey, expensesQueryKey } from "@/hooks/use-expenses";
import { hasCompleteFirestoreSnapshot, hasConfirmedFirestoreSnapshot } from "@/hooks/use-firestore-watch";
import { loanInstallmentsQueryKey, loanPersonsQueryKey, loansQueryKey, loansTrashQueryKey } from "@/hooks/use-loans";
import { peopleQueryKey } from "@/hooks/use-people";
import { savingsContributionsQueryKey, savingsGoalsQueryKey } from "@/hooks/use-savings";
import { transactionsQueryKey } from "@/hooks/use-transactions";
import { useAuthStore } from "@/store/auth-store";

export type DashboardPanelState = "ready" | "loading" | "unavailable";
type Panel = "netWorth" | "cashFlow" | "attention" | "recent" | "upcoming" | "accounts" | "expenses" | "credit";
type SnapshotSource = QueryKey | { key: QueryKey; scope: string } | { key: QueryKey; confirmFromServer: true };

const readyPanels: Record<Panel, DashboardPanelState> = {
  netWorth: "ready", cashFlow: "ready", attention: "ready", recent: "ready",
  upcoming: "ready", accounts: "ready", expenses: "ready", credit: "ready",
};

const lastReadiness = new WeakMap<QueryClient, { uid: string; states: Record<Panel, DashboardPanelState> }>();

export function dashboardSnapshotStates(client: QueryClient, uid: string): Record<Panel, DashboardPanelState> {
  const read = <T,>(key: QueryKey) => client.getQueryData<T[]>(key) ?? [];
  const ids = (key: QueryKey) => read<{ id: string }>(key).map((record) => record.id);
  const schedules = (key: QueryKey) => read<{ scheduleId: string }>(key).map((record) => record.scheduleId).join(",");
  const group = (key: QueryKey, scope: string): SnapshotSource[] => scope ? [{ key, scope }] : [];
  const state = (sources: readonly SnapshotSource[]): DashboardPanelState => {
    let pending = false;
    for (const source of sources) {
      const keyed = "key" in source;
      const key = keyed ? source.key : source;
      const complete = keyed && "confirmFromServer" in source
        ? hasConfirmedFirestoreSnapshot(client, key)
        : hasCompleteFirestoreSnapshot(client, key, keyed ? [uid, source.scope] : undefined);
      if (complete) continue;
      if (client.getQueryState(key)?.status === "error") return "unavailable";
      pending = true;
    }
    return pending ? "loading" : "ready";
  };

  const accounts = accountsQueryKey(uid);
  const transactions = transactionsQueryKey(uid);
  const categories = categoriesQueryKey(uid);
  const cards = creditCardsQueryKey(uid);
  const bills = billsQueryKey(uid);
  const loans = loansQueryKey(uid);
  const emis = emisQueryKey(uid);
  const expenses = expensesQueryKey(uid);
  const people = peopleQueryKey(uid);
  const goals = savingsGoalsQueryKey(uid);
  const statements = group(creditCardStatementsQueryKey(uid), ids(cards).join(","));
  const installments = [loans, emis, ...group(loanInstallmentsQueryKey(uid), schedules(loans)), ...group(emiInstallmentsQueryKey(uid), schedules(emis))];
  const cardBalances = [cards, transactions, sharedCreditLimitsQueryKey(uid), loanPersonsQueryKey(uid), ...statements,
    ...installments, ...group(emiPaymentBreakdownsQueryKey(uid), ids(emis).join(","))];
  const personIds = ids(people).sort();
  const peopleSources = personIds.length ? [["people-ledger-entries", uid, ...personIds], ["people-advance-applications", uid, ...personIds]] : [];
  const expenseSchedules = [...new Set(read<{ scheduleId: string | null }>(expenses).flatMap((expense) => expense.scheduleId == null ? [] : [expense.scheduleId]))].sort().join(",");

  return {
    netWorth: state([{ key: accounts, confirmFromServer: true }, people, loansTrashQueryKey(uid), ...peopleSources, ...cardBalances]),
    cashFlow: state([transactions, cards, expenses, ...installments, ...group([...expenseInstallmentsQueryKey(uid), expenseSchedules], expenseSchedules)]),
    attention: state([bills, accounts, categories, transactions, goals, ...group(savingsContributionsQueryKey(uid), ids(goals).sort().join(","))]),
    recent: state([transactions, categories, loans]),
    upcoming: state([bills, accounts, categories, cards, transactions, ...statements]),
    accounts: state([accounts, cards]),
    expenses: state([transactions, categories, expenses, loans, emis]),
    credit: state(cardBalances),
  };
}

/** Observe only the sources each card needs, including the first real snapshot of an empty collection. */
export function useDashboardSnapshotStates(): Record<Panel, DashboardPanelState> {
  const client = useQueryClient();
  const uid = useAuthStore((state) => state.user?.uid);
  const subscribe = useCallback((notify: () => void) => {
    // React Query can create entries during render. Deliver notifications through its own scheduler.
    const notifyAfterRender = notifyManager.batchCalls(notify);
    return client.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[1] === uid && (event.type === "updated" || event.type === "removed")) notifyAfterRender();
    });
  }, [client, uid]);

  const getStates = () => {
    if (!uid) return readyPanels;
    const previous = lastReadiness.get(client);
    const next = dashboardSnapshotStates(client, uid);
    if (previous?.uid === uid && (Object.keys(next) as Panel[]).every((panel) => next[panel] === previous.states[panel])) return previous.states;
    lastReadiness.set(client, { uid, states: next });
    return next;
  };

  return useSyncExternalStore(subscribe, getStates, () => readyPanels);
}
