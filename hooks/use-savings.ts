"use client";

/**
 * Mirrors the live-subscription pattern established by
 * `hooks/use-accounts.ts` / `hooks/use-bills.ts` — a live Firestore
 * `watchAll` subscription feeding a React Query cache, `staleTime: Infinity`.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import { createSavingsRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function savingsGoalsQueryKey(uid: string | undefined) {
  return ["savings-goals", uid] as const;
}

/** Live-subscribes to the signed-in user's active savings goals. */
export function useSavingsGoals() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<SavingsGoal[]>({
    queryKey: savingsGoalsQueryKey(uid),
    enabled: !!uid,
    hookName: "useSavingsGoals",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createSavingsRepository(uid).watchAll(onData, onError);
    },
  });
}
