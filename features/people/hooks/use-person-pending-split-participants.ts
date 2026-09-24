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
  isLoading: boolean;
} {
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { installmentsByScheduleId, isLoading: installmentsLoading } = useExpenseInstallmentsBySchedule();

  const pending = useMemo(() => {
    if (!personId) return [];
    return derivePendingSplitParticipants(personId, expenses, installmentsByScheduleId).filter(
      (item) => remainingAmount(item.installment) > 0,
    );
  }, [personId, expenses, installmentsByScheduleId]);

  return { pending, isLoading: expensesLoading || installmentsLoading };
}
