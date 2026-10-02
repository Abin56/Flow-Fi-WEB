/**
 * Repairs one historical split-expense ghost (see `lib/engines/split-ghost-repair.ts`). Everything is
 * re-read fresh from the repositories first — a stale screen can only NOMINATE an expense — and a ghost
 * proven to have no payment history is removed through the authoritative `ExpenseRepository.deleteExpense`
 * (installments, schedule, every share entry with its balance reversed, the Expense; its already-trashed
 * Transaction is not reversed again). Blocked ghosts are returned with diagnostics and left untouched.
 *
 * Idempotent: once repaired the Expense is trashed, so every later run reads it as "notGhost".
 */

import { classifySplitGhost, type SplitGhostVerdict } from "@/lib/engines/split-ghost-repair";
import type { Expense } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import type { AdvanceApplication, LedgerEntry } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

export interface SplitGhostRepairDeps {
  getExpense: (expenseId: string) => Promise<Expense | null>;
  getTransaction: (transactionId: string) => Promise<Transaction | null>;
  installmentsFor: (scheduleId: string) => Promise<Installment[]>;
  ledgerEntriesFor: (personId: string) => Promise<LedgerEntry[]>;
  advanceApplicationsFor?: (personId: string) => Promise<AdvanceApplication[]>;
  deleteExpense: (expense: Expense) => Promise<void>;
}

export async function repairSplitGhost(expenseId: string, deps: SplitGhostRepairDeps): Promise<SplitGhostVerdict> {
  const expense = await deps.getExpense(expenseId);
  if (expense == null || expense.deletedAt != null) return { kind: "notGhost" };
  const transaction = await deps.getTransaction(expense.transactionId);
  const installments = expense.scheduleId != null ? await deps.installmentsFor(expense.scheduleId) : [];
  const entriesByPersonId: Record<string, LedgerEntry[]> = {};
  const advanceApplicationsByPersonId: Record<string, AdvanceApplication[]> = {};
  for (const p of expense.participants) {
    if (p.isMe || p.personId == null || entriesByPersonId[p.personId]) continue;
    entriesByPersonId[p.personId] = await deps.ledgerEntriesFor(p.personId);
    if (deps.advanceApplicationsFor) advanceApplicationsByPersonId[p.personId] = await deps.advanceApplicationsFor(p.personId);
  }

  const verdict = classifySplitGhost({ expense, transaction, installments, entriesByPersonId, advanceApplicationsByPersonId });
  if (verdict.kind === "repair") await deps.deleteExpense(expense);
  return verdict;
}
