"use client";

/**
 * Composes the Savings page from live data: goals, their money entries, the live Transaction list (to know
 * which transfer entries are still backed by real legs), accounts and categories. All figures come from
 * `lib/engines/savings-goals.ts`; all writes go through `SavingsRepository` — the same atomic transfer pair
 * "Add transfer" uses. No savings math lives here.
 */

import { useEffect, useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { useSavingsContributions, useSavingsGoals } from "@/hooks/use-savings";
import { useTransactions } from "@/hooks/use-transactions";
import { buildSavingsPosition, removeEntryBlocker, type EntryView, type GoalView, type SavingsPosition } from "@/lib/engines/savings-goals";
import type { Account } from "@/lib/models/account";
import type { SavingsContribution, SavingsEntryDirection, SavingsEntryMode } from "@/lib/models/savings-contribution";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import { createSavingsRepository } from "@/lib/repositories/repository-factory";
import type { CreateGoalParams, EditGoalParams } from "@/lib/repositories/savings-repository";
import { transferCategoryId } from "@/features/transactions/lib/transfer-effect";
import { useAuthStore } from "@/store/auth-store";

export type { EntryView, GoalView, SavingsPosition };

/** Everything the Savings page and the dashboard signal read. */
export function useSavingsPosition(): {
  position: SavingsPosition;
  accounts: Account[];
  isLoading: boolean;
} {
  const { data: goals = [], isLoading: goalsLoading } = useSavingsGoals();
  const { data: contributions = [], isLoading: entriesLoading } = useSavingsContributions();
  const { data: transactions = [] } = useTransactions();
  const { data: accounts = [] } = useAccounts();

  // The shared Transaction listener reads as `[]` for a moment before its first snapshot. Trust transfer
  // entries until the list has content or has had a fair moment to arrive — never flash "reversed".
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (transactions.length > 0) return;
    const t = setTimeout(() => setSettled(true), 2500);
    return () => clearTimeout(t);
  }, [transactions.length]);

  const activeTxIds = useMemo(() => (transactions.length > 0 || settled ? new Set(transactions.map((t) => t.id)) : null), [transactions, settled]);

  const position = useMemo(() => buildSavingsPosition(goals, contributions, activeTxIds, new Date()), [goals, contributions, activeTxIds]);

  return { position, accounts, isLoading: goalsLoading || entriesLoading };
}

export interface MoneyEntryInput {
  /** Stable across retries of one user action. */
  id: string;
  direction: SavingsEntryDirection;
  mode: SavingsEntryMode;
  amount: number;
  date: Date;
  accountId: string | null;
  counterAccountId?: string | null;
  note?: string;
}

/** Create/edit/record/remove/archive/delete actions wired to the real repository, scoped to the signed-in user. */
export function useSavingsActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: categories = [] } = useCategories();
  const categoryId = useMemo(() => transferCategoryId(categories, categories.find((c) => c.deletedAt == null)?.id ?? ""), [categories]);

  return useMemo(() => {
    if (!uid) return null;
    const repository = createSavingsRepository(uid);
    const signed = (direction: SavingsEntryDirection, amount: number) => (direction === "in" ? amount : -amount);

    return {
      createGoal: (params: CreateGoalParams) => repository.createGoal(params),
      editGoal: (view: GoalView, params: Omit<EditGoalParams, "savedNow">) => repository.editGoal(view.goal, { ...params, savedNow: view.saved }),
      /** Records money in/out — earmark (no transaction) or a real transfer. Idempotent on `input.id`. */
      recordEntry: (view: GoalView, input: MoneyEntryInput): Promise<SavingsContribution> =>
        repository.recordEntry(view.goal, {
          ...input,
          categoryId: input.mode === "transfer" ? categoryId : undefined,
          savedAfter: Math.max(0, view.saved + signed(input.direction, input.amount)),
        }),
      /** `null` = removable; otherwise the reason it is blocked. */
      removeBlocker: (view: GoalView, entryId: string) => removeEntryBlocker(view, entryId),
      removeEntry: (view: GoalView, entry: EntryView) =>
        repository.removeEntry(view.goal, entry.entry, {
          wasActive: entry.active,
          savedAfter: Math.max(0, view.saved - entry.effect),
        }),
      editEntry: (view: GoalView, entry: EntryView, patch: { note?: string; amount?: number; accountId?: string | null; date?: Date }) => {
        const newAmount = patch.amount ?? entry.entry.amount;
        const delta = entry.active ? signed(entry.entry.direction, newAmount) - signed(entry.entry.direction, entry.entry.amount) : 0;
        return repository.editEntry(view.goal, entry.entry, patch, Math.max(0, view.saved + delta));
      },
      markCompleted: (view: GoalView) => repository.markCompleted(view.goal, { saved: view.saved }),
      reopen: (goal: SavingsGoal) => repository.markIncomplete(goal),
      archive: (goal: SavingsGoal) => repository.archive(goal),
      unarchive: (goal: SavingsGoal) => repository.unarchive(goal),
      deleteGoal: (goal: SavingsGoal) => repository.softDelete(goal),
      hasTransferCategory: categoryId !== "",
    };
  }, [uid, categoryId]);
}
