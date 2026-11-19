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
  /** Withdrawal from a locked goal through an explicit emergency release. */
  emergency?: boolean;
  allocationId?: string | null;
}

/** One goal's line in an "Allocate this month" action. `id` stays the same across retries of that line. */
export interface AllocationLine {
  id: string;
  view: GoalView;
  amount: number;
}

export interface AllocationResult {
  /** Entry ids that are now stored (including ones a previous attempt already stored). */
  done: string[];
  failed: { id: string; goalName: string; message: string }[];
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
      /**
       * Records one entry per line — each with its own stable id, so retrying after a partial failure writes only the
       * lines that did not land (a stored line returns the stored entry). Sequential: transfers each need the
       * source's fresh balance (`enforceFunds`).
       */
      allocate: async (
        lines: readonly AllocationLine[],
        opts: { mode: SavingsEntryMode; accountId: string; counterAccountId?: string | null; date: Date; allocationId: string; note?: string },
        onMessage: (e: unknown) => string,
      ): Promise<AllocationResult> => {
        const result: AllocationResult = { done: [], failed: [] };
        // Several lines can hit the same goal only once each; track saved-after per goal as we go.
        const savedNow = new Map<string, number>();
        for (const line of lines) {
          if (!(line.amount > 0)) continue;
          const before = savedNow.get(line.view.goal.id) ?? line.view.saved;
          try {
            await repository.recordEntry(line.view.goal, {
              id: line.id,
              direction: "in",
              mode: opts.mode,
              amount: line.amount,
              date: opts.date,
              accountId: opts.accountId,
              counterAccountId: opts.mode === "transfer" ? (opts.counterAccountId ?? null) : null,
              note: opts.note ?? "Monthly allocation",
              categoryId: opts.mode === "transfer" ? categoryId : undefined,
              savedAfter: before + line.amount,
              allocationId: opts.allocationId,
            });
            savedNow.set(line.view.goal.id, before + line.amount);
            result.done.push(line.id);
          } catch (e) {
            result.failed.push({ id: line.id, goalName: line.view.goal.name, message: onMessage(e) });
          }
        }
        return result;
      },
      setPlan: (view: GoalView, monthlyTarget: number | null, planAccountId?: string | null) => repository.setPlan(view.goal, { monthlyTarget, planAccountId }),
      setCycleSkipped: (view: GoalView, cycleKey: string, skipped: boolean) => repository.setCycleSkipped(view.goal, cycleKey, skipped),
      setLock: (view: GoalView, locked: boolean, lockedUntil: Date | null) => repository.setLock(view.goal, { locked, lockedUntil }),
      markCompleted: (view: GoalView) => repository.markCompleted(view.goal, { saved: view.saved }),
      reopen: (goal: SavingsGoal) => repository.markIncomplete(goal),
      archive: (goal: SavingsGoal) => repository.archive(goal),
      unarchive: (goal: SavingsGoal) => repository.unarchive(goal),
      deleteGoal: (goal: SavingsGoal) => repository.softDelete(goal),
      hasTransferCategory: categoryId !== "",
    };
  }, [uid, categoryId]);
}
