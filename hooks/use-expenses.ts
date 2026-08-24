"use client";

/**
 * Mirrors the live-subscription pattern established by `hooks/use-people.ts`
 * — a live Firestore `watchAll` subscription feeding a React Query cache,
 * `staleTime: Infinity`. Powers the Transaction Manager popup's lookup of
 * the `Expense` (if any) backing a given `Transaction`. `ExpenseRepository`
 * has no query-by-transactionId, so callers build a
 * `Map<transactionId, Expense>` client-side — same join style
 * `features/transactions/hooks/use-transactions-data.ts` already uses for
 * account/category joins.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Expense } from "@/lib/models/expense";
import { createAccountRepository, createExpenseRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function expensesQueryKey(uid: string | undefined) {
  return ["expenses", uid] as const;
}

/** Live-subscribes to the signed-in user's active expenses (split/assigned-to-person records). */
export function useExpenses() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Expense[]>({
    queryKey: expensesQueryKey(uid),
    enabled: !!uid,
    hookName: "useExpenses",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const accountRepository = createAccountRepository(uid);
      return createExpenseRepository(uid, accountRepository).watchAll(onData, onError);
    },
  });
}
