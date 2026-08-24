/**
 * Port of `Finance_App/lib/features/transactions/presentation/screens/add_expense_screen.dart`'s
 * `_save()` branch logic for the "this person owes me this expense" toggle —
 * the piece that must be ported faithfully, since getting it wrong either
 * orphans a ledger entry (money "owed" that no longer has a transaction
 * behind it) or double-posts one (unassign forgotten before reassigning).
 *
 * `wasOwed`/`nowOwed` mirror the Dart naming exactly: whether the
 * transaction had/will-have a real person-owed `Expense` backing it, derived
 * from `owesPersonToggle × linkedPersonId × type === "expense"` — never from
 * `Expense` alone, since a `Transaction` can carry `linkedPersonId` as a
 * purely descriptive reference (no ledger effect) when `owesPersonToggle`
 * is off.
 *
 * The "assign to person" and "owed → owed, same person, amount changed"
 * branches always treat the person as owing the *entire* transaction amount
 * — full reassignment, not a partial custom split. A genuine multi-person
 * split is a distinct, explicit action (`convertToSplit`/`resplitExpense`,
 * driven by the participant list UI), not something this toggle drives.
 */

import type { Expense } from "@/lib/models/expense";
import type { Transaction } from "@/lib/models/transaction";
import type { ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";
import type { EditTransactionParams, TransactionRepository } from "@/lib/repositories/transaction-repository";

export interface OwesPersonTarget {
  personId: string | null;
  personName: string;
  owesPersonToggle: boolean;
}

export interface ApplyOwesPersonChangeParams {
  transaction: Transaction;
  /** The person-owed Expense currently backing this transaction, if `wasOwed` — null otherwise. */
  existingExpense: Expense | null;
  target: OwesPersonTarget;
  /** Overrides applied to the plain Transaction fields alongside the person change (e.g. an amount edit). */
  transactionEdits?: Omit<EditTransactionParams, "linkedPersonId" | "clearLinkedPersonId" | "owesPersonToggle">;
  transactionRepository: TransactionRepository;
  expenseRepository: ExpenseRepository;
  /** Resolves the InstallmentRepository for an existing expense's schedule — only needed for the same-person edit branch. */
  installmentRepositoryFor: (scheduleId: string) => InstallmentRepository;
}

function isOwed(transaction: Pick<Transaction, "type" | "linkedPersonId" | "owesPersonToggle">): boolean {
  return transaction.type === "expense" && transaction.linkedPersonId != null && transaction.owesPersonToggle;
}

/** Resolves the currently-owed person's id from `existingExpense`, if any (the non-"Me" participant). */
function owedPersonIdFrom(expense: Expense | null): string | null {
  if (expense == null) return null;
  return expense.participants.find((p) => !p.isMe)?.personId ?? null;
}

/** The non-"Me" participant's identity — used to reconstruct a torn-down assignment on rollback. */
function owedParticipantFrom(expense: Expense): { personId: string | null; name: string } | null {
  const participant = expense.participants.find((p) => !p.isMe);
  return participant ? { personId: participant.personId, name: participant.name } : null;
}

/** Reconstructs `participantInputs` from an `Expense`'s current participants — used to revert an
 *  in-place `editExpense` back to its pre-call state on rollback. */
function participantInputsFrom(expense: Expense): { personId: string | null; name: string; value: number; isMe: boolean }[] {
  return expense.participants.map((p) => ({ personId: p.personId, name: p.name, value: p.share, isMe: p.isMe }));
}

export async function applyOwesPersonChange(params: ApplyOwesPersonChangeParams): Promise<void> {
  const { transaction, existingExpense, target, transactionEdits, transactionRepository, expenseRepository, installmentRepositoryFor } = params;

  const wasOwed = isOwed(transaction) && existingExpense != null;
  const nowOwed = target.owesPersonToggle && target.personId != null && transaction.type === "expense";
  const totalAmount = transactionEdits?.amount ?? transaction.amount;
  const date = transactionEdits?.dateTime ?? transaction.dateTime;
  const categoryId = transactionEdits?.categoryId ?? transaction.categoryId;
  const accountId = transactionEdits?.accountId ?? transaction.accountId;
  const description = transactionEdits?.description ?? transaction.description;
  const notes = transactionEdits?.notes ?? transaction.notes;

  if (!wasOwed && nowOwed) {
    // reference-only (or nothing) -> owed
    const newExpense = await expenseRepository.convertToAssigned({
      existingExpense: null,
      transactionId: transaction.id,
      description,
      totalAmount,
      date,
      categoryId,
      accountId,
      notes,
      personId: target.personId!,
      personName: target.personName,
    });
    try {
      await transactionRepository.editTransaction(transaction, {
        ...transactionEdits,
        linkedPersonId: target.personId,
        owesPersonToggle: true,
      });
    } catch (error) {
      // The ledger-side assignment already committed above — tear it down rather than
      // leave an untraceable "owed" balance with no transaction stamped to back it.
      await expenseRepository.unassignFromPerson(newExpense).catch(() => {
        // Best-effort — the original error below is what actually surfaces.
      });
      throw error;
    }
    return;
  }

  if (wasOwed && !nowOwed) {
    // owed -> reference-only (or fully cleared)
    await expenseRepository.unassignFromPerson(existingExpense!);
    try {
      await transactionRepository.editTransaction(transaction, {
        ...transactionEdits,
        linkedPersonId: target.personId,
        clearLinkedPersonId: target.personId == null,
        owesPersonToggle: false,
      });
    } catch (error) {
      // Re-create the assignment we just tore down — otherwise the debt silently
      // vanishes from People/Ledger totals if the transaction stamp fails.
      const oldParticipant = owedParticipantFrom(existingExpense!);
      if (oldParticipant) {
        await expenseRepository
          .convertToAssigned({
            existingExpense: null,
            transactionId: transaction.id,
            description,
            totalAmount,
            date,
            categoryId,
            accountId,
            notes,
            personId: oldParticipant.personId ?? "",
            personName: oldParticipant.name,
          })
          .catch(() => {
            // Best-effort — the original error below is what actually surfaces.
          });
      }
      throw error;
    }
    return;
  }

  if (wasOwed && nowOwed) {
    const samePerson = owedPersonIdFrom(existingExpense) === target.personId;

    if (!samePerson) {
      // owed -> owed, different person: unassign then reassign, never in-place
      await expenseRepository.unassignFromPerson(existingExpense!);
      const newExpense = await expenseRepository.convertToAssigned({
        existingExpense: null,
        transactionId: transaction.id,
        description,
        totalAmount,
        date,
        categoryId,
        accountId,
        notes,
        personId: target.personId!,
        personName: target.personName,
      });

      try {
        await transactionRepository.editTransaction(transaction, {
          ...transactionEdits,
          linkedPersonId: target.personId,
          owesPersonToggle: true,
        });
      } catch (error) {
        // Reverse both ledger-side steps: tear down the new assignment, restore the original one.
        await expenseRepository.unassignFromPerson(newExpense).catch(() => {
          // Best-effort — the original error below is what actually surfaces.
        });
        const oldParticipant = owedParticipantFrom(existingExpense!);
        if (oldParticipant) {
          await expenseRepository
            .convertToAssigned({
              existingExpense: null,
              transactionId: transaction.id,
              description,
              totalAmount,
              date,
              categoryId,
              accountId,
              notes,
              personId: oldParticipant.personId ?? "",
              personName: oldParticipant.name,
            })
            .catch(() => {
              // Best-effort — the original error below is what actually surfaces.
            });
        }
        throw error;
      }
    } else {
      // owed -> owed, same person: edit the existing ledger line in place
      const scheduleId = existingExpense!.scheduleId;
      const currentInstallments = scheduleId == null ? [] : await installmentRepositoryFor(scheduleId).getAll();
      const hasMeParticipant = existingExpense!.participants.some((p) => p.isMe);

      const editedExpense = await expenseRepository.editExpense({
        expense: existingExpense!,
        currentInstallments,
        description,
        date,
        categoryId,
        accountId,
        notes,
        totalAmount,
        splitType: "custom",
        participantInputs: hasMeParticipant
          ? [
              { name: "Me", isMe: true, value: 0 },
              { personId: target.personId, name: target.personName, value: totalAmount },
            ]
          : [{ personId: target.personId, name: target.personName, value: totalAmount }],
      });

      try {
        await transactionRepository.editTransaction(transaction, {
          ...transactionEdits,
          linkedPersonId: target.personId,
          owesPersonToggle: true,
        });
      } catch (error) {
        // Revert the in-place ledger edit back to its pre-call state.
        const revertScheduleId = editedExpense.scheduleId ?? scheduleId;
        const revertInstallments = revertScheduleId == null ? [] : await installmentRepositoryFor(revertScheduleId).getAll();
        await expenseRepository
          .editExpense({
            expense: editedExpense,
            currentInstallments: revertInstallments,
            description: existingExpense!.description,
            date: existingExpense!.date,
            categoryId: existingExpense!.categoryId,
            accountId: existingExpense!.accountId,
            notes: existingExpense!.notes,
            totalAmount: existingExpense!.totalAmount,
            splitType: "custom",
            participantInputs: participantInputsFrom(existingExpense!),
          })
          .catch(() => {
            // Best-effort — the original error below is what actually surfaces.
          });
        throw error;
      }
    }

    return;
  }

  // !wasOwed && !nowOwed: plain field edits, possibly including a reference-only linkedPersonId change.
  await transactionRepository.editTransaction(transaction, {
    ...transactionEdits,
    linkedPersonId: target.personId,
    clearLinkedPersonId: target.personId == null,
    owesPersonToggle: false,
  });
}
