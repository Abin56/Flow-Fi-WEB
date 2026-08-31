"use client";

/**
 * Composes the Savings page's real data/actions from the ported
 * `SavingsGoal` model and `SavingsRepository` — no new business logic here,
 * only composition on top of `hooks/use-savings.ts` (live Firestore
 * subscription) and `lib/repositories/savings-repository.ts` (create/edit/
 * contribute/archive/delete). Progress is always computed via the ported
 * `progress()` helper, never recomputed here.
 */

import { useMemo } from "react";
import { progress, type SavingsGoal } from "@/lib/models/savings-goal";
import { createSavingsRepository } from "@/lib/repositories/repository-factory";
import type { CreateGoalParams, EditGoalParams } from "@/lib/repositories/savings-repository";
import { useSavingsGoals } from "@/hooks/use-savings";
import { useAuthStore } from "@/store/auth-store";

export interface SavingsGoalRow {
  goal: SavingsGoal;
  progress: number;
}

/** Live savings goals joined with their clamped progress ratio. */
export function useSavingsRows(): { rows: SavingsGoalRow[]; isLoading: boolean } {
  const { data: goals = [], isLoading } = useSavingsGoals();

  const rows = useMemo(
    () =>
      (goals as SavingsGoal[])
        .filter((g) => !g.isArchived)
        .map((goal) => ({ goal, progress: progress(goal) })),
    [goals],
  );

  return { rows, isLoading };
}

/** Archived goals — kept out of the primary list per `SavingsRepository.archive`'s doc comment. */
export function useArchivedSavingsRows(): { rows: SavingsGoalRow[]; isLoading: boolean } {
  const { data: goals = [], isLoading } = useSavingsGoals();

  const rows = useMemo(
    () =>
      (goals as SavingsGoal[])
        .filter((g) => g.isArchived)
        .map((goal) => ({ goal, progress: progress(goal) })),
    [goals],
  );

  return { rows, isLoading };
}

/** Create/edit/contribute/archive/delete actions wired to the real repository, scoped to the signed-in user. */
export function useSavingsActions() {
  const uid = useAuthStore((s) => s.user?.uid);

  return useMemo(() => {
    if (!uid) return null;
    const repository = createSavingsRepository(uid);

    return {
      createGoal: async (params: CreateGoalParams) => {
        return repository.createGoal(params);
      },
      editGoal: async (goal: SavingsGoal, params: EditGoalParams) => {
        await repository.editGoal(goal, params);
      },
      /** Adds toward `currentAmount` — the only way that field may change; never a generic amount edit. */
      contribute: async (goal: SavingsGoal, amount: number) => {
        await repository.contribute(goal, amount);
      },
      archive: async (goal: SavingsGoal) => {
        await repository.archive(goal);
      },
      unarchive: async (goal: SavingsGoal) => {
        await repository.unarchive(goal);
      },
      deleteGoal: async (goal: SavingsGoal) => {
        await repository.softDelete(goal);
      },
    };
  }, [uid]);
}
