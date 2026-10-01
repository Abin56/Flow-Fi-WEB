"use client";

import { useMemo } from "react";
import { useExpenseInstallmentsBySchedule, useExpenses } from "@/hooks/use-expenses";
import { remainingAmount } from "@/lib/models/payment-schedule";
import {
  derivePendingSplitParticipants,
  type PendingSplitParticipant,
} from "@/lib/engines/person-pending-split-participants";

/**
 * This person's *outstanding* split-expense participations, oldest-due-first
 * — feeds the Settle Up dialog's "Specific expense" mode. The engine itself
 * (`derivePendingSplitParticipants`) resolves every participation, matching
 * Flutter's `personSplitParticipantsProvider`; the `remainingAmount > 0`
 * filter is applied here at the call site, same as Flutter's
 * `settle_up_sheet.dart` does, so the engine stays reusable for a future
 * view that wants already-settled rows too.
 */
export function usePersonPendingSplitParticipants(personId: string | null | undefined): {
  pending: PendingSplitParticipant[];
  /** Expense `transactionId`s whose share for this person has an installment (any status) — see `trackedShareRefs`. */
  trackedShareRefs: ReadonlySet<string>;
  isLoading: boolean;
} {
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { installmentsByScheduleId, isLoading: installmentsLoading } = useExpenseInstallmentsBySchedule();

  const { pending, trackedShareRefs } = useMemo(() => {
    if (!personId) return { pending: [], trackedShareRefs: new Set<string>() };
    const all = derivePendingSplitParticipants(personId, expenses, installmentsByScheduleId);
    return {
      pending: all.filter((item) => remainingAmount(item.installment) > 0),
      trackedShareRefs: new Set(all.map((item) => item.expense.transactionId)),
    };
  }, [personId, expenses, installmentsByScheduleId]);

  const isLoading = expensesLoading || installmentsLoading;
  return { pending, trackedShareRefs, isLoading };
}
