/**
 * Direct port of `lib/features/people/presentation/providers/person_pending_participants_providers.dart`
 * (`personSplitParticipantsProvider`). Pure, feature-agnostic derivation —
 * walks every split/assigned `Expense`, matches this person's participant
 * row to its live `Installment` by `installmentId`. Matches the Dart
 * provider's own scope exactly: it does *not* filter by remaining balance
 * itself (that's left to the caller, same as Flutter's
 * `settle_up_sheet.dart`, so a future "settlement history" view could reuse
 * this for already-settled rows too) — callers that only want outstanding
 * amounts (e.g. the Settle Up dialog) should filter with
 * `remainingAmount(item.installment) > 0` themselves.
 */

import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";

export interface PendingSplitParticipant {
  expense: Expense;
  participant: ExpenseParticipant;
  installment: Installment;
}

/**
 * Returns every one of this person's split-expense participations that have
 * a resolvable live installment, sorted oldest-due-date-first — the order
 * `ExpenseRepository.settleAcrossPending` expects its `pending` list to
 * already be in.
 */
export function derivePendingSplitParticipants(
  personId: string,
  expenses: Expense[],
  installmentsByScheduleId: Record<string, Installment[]>,
): PendingSplitParticipant[] {
  const result: PendingSplitParticipant[] = [];

  for (const expense of expenses) {
    if (expense.scheduleId == null) continue;
    const installments = installmentsByScheduleId[expense.scheduleId] ?? [];

    for (const participant of expense.participants) {
      if (participant.isMe) continue;
      if (participant.personId !== personId) continue;
      if (participant.installmentId == null) continue;

      const installment = installments.find((i) => i.id === participant.installmentId);
      if (installment == null) continue;

      result.push({ expense, participant, installment });
    }
  }

  result.sort((a, b) => a.installment.dueDate.getTime() - b.installment.dueDate.getTime());
  return result;
}
