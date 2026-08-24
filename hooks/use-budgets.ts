"use client";

/**
 * Mirrors the `budgetsStreamProvider`-shaped live subscription pattern
 * established by `hooks/use-accounts.ts` — a live Firestore `watchAll`
 * subscription feeding a React Query cache, `staleTime: Infinity`.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Budget } from "@/lib/models/budget";
import { createBudgetRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function budgetsQueryKey(uid: string | undefined) {
  return ["budgets", uid] as const;
}

/** Live-subscribes to the signed-in user's active budgets. */
export function useBudgets() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Budget[]>({
    queryKey: budgetsQueryKey(uid),
    enabled: !!uid,
    hookName: "useBudgets",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createBudgetRepository(uid).watchAll(onData, onError);
    },
  });
}
