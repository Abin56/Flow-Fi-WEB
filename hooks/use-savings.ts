"use client";

/**
 * Mirrors the live-subscription pattern established by
 * `hooks/use-accounts.ts` / `hooks/use-bills.ts` — a live Firestore
 * `watchAll` subscription feeding a React Query cache, `staleTime: Infinity`.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import type { SavingsContribution } from "@/lib/models/savings-contribution";
import { createSavingsContributionsCollection, createSavingsRepository } from "@/lib/repositories/repository-factory";
import { onSnapshot, query, where } from "firebase/firestore";
import { safeDocs } from "@/lib/firestore/safe-docs";
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

export function savingsContributionsQueryKey(uid: string | undefined) {
  return ["savings-contributions", uid] as const;
}

/**
 * Live-subscribes to every goal's money entries. Entries live in per-goal subcollections, so this fans out
 * one listener per goal (the same pattern as `useAllLoanInstallments`) — goal counts are small. Stays enabled
 * with zero goals so a just-deleted last goal clears its entries instead of leaving the old snapshot cached.
 */
export function useSavingsContributions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { data: goals = [] } = useSavingsGoals();
  const goalIds = goals.map((g) => g.id).sort().join(",");

  return useFirestoreWatch<SavingsContribution[]>({
    queryKey: savingsContributionsQueryKey(uid),
    enabled: !!uid,
    hookName: "useSavingsContributions",
    emptyValue: [],
    deps: [uid, goalIds, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      if (!goalIds) {
        onData([]);
        return () => {};
      }
      const byGoal = new Map<string, SavingsContribution[]>();
      let erroredOnce = false;
      const publish = () => onData(Array.from(byGoal.values()).flat());
      const unsubscribes = goalIds.split(",").map((goalId) =>
        onSnapshot(
          query(createSavingsContributionsCollection(uid, goalId), where("deletedAt", "==", null)),
          (snapshot) => {
            byGoal.set(goalId, safeDocs(snapshot.docs));
            publish();
          },
          (error) => {
            if (erroredOnce) return;
            erroredOnce = true;
            onError(error);
          },
        ),
      );
      return () => unsubscribes.forEach((unsub) => unsub());
    },
  });
}
