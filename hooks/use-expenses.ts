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
import { useMemo } from "react";
import type { Expense } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import {
  createAccountRepository,
  createExpenseRepository,
  createInstallmentRepositoryFor,
} from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function expensesQueryKey(uid: string | undefined) {
  return ["expenses", uid] as const;
}

export function expenseInstallmentsQueryKey(uid: string | undefined) {
  return ["expenseInstallments", uid] as const;
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

/**
 * Live-subscribes to every active `Installment` across every split `Expense`
 * that has a `scheduleId`, keyed by that `scheduleId` — mirrors
 * `useAllLoanInstallments`'s per-schedule fan-out (`hooks/use-loans.ts`), but
 * keeps the per-schedule grouping (rather than flattening) since callers
 * (Cashflow's `moneyReceivedThisMonth`, History's `splitExpenseDetailFor`)
 * need to look up installments for one specific expense's schedule, not just
 * a flat pool. Mirrors `Finance_App`'s pattern of watching
 * `installmentsStreamProvider(expense.scheduleId!)` per split expense.
 */
export function useExpenseInstallmentsBySchedule(): {
  installmentsByScheduleId: Record<string, Installment[]>;
  isLoading: boolean;
} {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { data: expenses = [] } = useExpenses();
  const scheduleIds = useMemo(
    () =>
      Array.from(
        new Set((expenses as Expense[]).filter((e) => e.scheduleId != null).map((e) => e.scheduleId as string)),
      ).sort(),
    [expenses],
  );
  const scheduleIdsKey = scheduleIds.join(",");

  const { data, isLoading } = useFirestoreWatch<Record<string, Installment[]>>({
    queryKey: [...expenseInstallmentsQueryKey(uid), scheduleIdsKey],
    enabled: !!uid && scheduleIds.length > 0,
    hookName: "useExpenseInstallmentsBySchedule",
    emptyValue: {},
    deps: [uid, scheduleIdsKey, queryClient],
    subscribe: (onData, onError) => {
      if (!uid || scheduleIds.length === 0) return () => {};
      const byScheduleId = new Map<string, Installment[]>();
      let erroredOnce = false;
      const publish = () => onData(Object.fromEntries(byScheduleId));

      const unsubscribes = scheduleIds.map((scheduleId) => {
        const repository = createInstallmentRepositoryFor(uid, scheduleId);
        return repository.watchAll(
          (installments) => {
            byScheduleId.set(scheduleId, installments);
            publish();
          },
          (error) => {
            if (erroredOnce) return;
            erroredOnce = true;
            onError(error);
          },
        );
      });

      return () => unsubscribes.forEach((unsub) => unsub());
    },
  });

  return { installmentsByScheduleId: data ?? {}, isLoading };
}
