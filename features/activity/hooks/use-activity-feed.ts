"use client";

/**
 * The Activity feed: Transaction pages (newest recorded first, live AND soft-deleted, one-shot reads — no
 * listener on the whole collection) folded into one row per action by `classifyActivity`. Names and the two
 * classification facts (which accounts are cards, which transactions an active split Expense owns) come from
 * the app's shared live hooks, which the rest of the app already keeps warm.
 */

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { useExpenses } from "@/hooks/use-expenses";
import { useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { classifyActivity, type ActivityItem, type ActivityNames } from "@/features/activity/lib/activity-classify";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Emi } from "@/lib/models/emi";
import type { Expense } from "@/lib/models/expense";
import type { Loan } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import { createAccountRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

export const ACTIVITY_PAGE_SIZE = 30;

export function activityQueryKey(uid: string | undefined) {
  return ["activity", uid] as const;
}

export function useActivityFeed() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const { data: cards = [] } = useCreditCards();
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { data: people = [] } = usePeople();
  const { data: loans = [] } = useLoans();
  const { data: emis = [] } = useEmis();

  const query = useInfiniteQuery({
    queryKey: activityQueryKey(uid),
    enabled: !!uid,
    initialPageParam: null as Parameters<ReturnType<typeof createTransactionRepository>["pageByCreatedAt"]>[1],
    queryFn: async ({ pageParam }) => {
      const repository = createTransactionRepository(uid!, createAccountRepository(uid!));
      return repository.pageByCreatedAt(ACTIVITY_PAGE_SIZE, pageParam);
    },
    getNextPageParam: (last) => last.cursor ?? undefined,
    // Activity must show what just happened elsewhere: always re-read the loaded pages when the page opens.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const transactions = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const items: ActivityItem[] = useMemo(() => {
    const cardAccountIds = new Set((cards as CreditCardProfile[]).filter((c) => c.deletedAt == null).map((c) => c.accountId));
    const splitTransactionIds = new Set((expenses as Expense[]).filter((e) => e.deletedAt == null).map((e) => e.transactionId));
    return classifyActivity(transactions, { cardAccountIds, splitTransactionIds });
  }, [transactions, cards, expenses]);

  const names: ActivityNames = useMemo(() => {
    const byId = <T extends { id: string }>(list: readonly T[]) => new Map(list.map((x) => [x.id, x]));
    const accountById = byId(accounts as Account[]);
    const personById = byId(people as Person[]);
    const loanById = byId(loans as Loan[]);
    const emiById = byId(emis as Emi[]);
    return {
      account: (id) => accountById.get(id)?.name ?? null,
      person: (id) => personById.get(id)?.name ?? null,
      loan: (id) => loanById.get(id)?.name ?? null,
      emi: (id) => emiById.get(id)?.name ?? null,
    };
  }, [accounts, people, loans, emis]);

  /** After an undo: re-read the loaded pages so the row's state comes from Firestore, never from the UI. */
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: activityQueryKey(uid) }), [queryClient, uid]);

  return {
    items,
    names,
    accounts: accounts as Account[],
    isLoading: query.isLoading || expensesLoading,
    error: query.error,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
    refresh,
    /** Raw document count loaded so far (rows can be fewer — several docs fold into one action). */
    loadedCount: transactions.length,
  };
}
