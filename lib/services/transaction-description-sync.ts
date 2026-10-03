/**
 * Renaming a transaction's description — carried to the People records that mirror it.
 *
 * People rows never read `Transaction.description` live: each row's title is its ledger entry's stored
 * `note` (`ledgerTitle` in person-cycle-statement), and a split/assigned share also has its Expense's own
 * `description`. So a rename must reach those copies, by canonical owner:
 *  - split/assigned share (owner: Expense) → `ExpenseRepository.syncDescription` — the Expense and every
 *    participant's "Split: …" share entry;
 *  - person cash leg ("Money I Gave/Borrowed" with an account), person-funded expense, legacy linked
 *    entry → the entry's note, ONLY while it still mirrors the old description (a note customised on the
 *    People side is the user's own text and is left alone);
 *  - payment entries (`paymentId`: Record Payment, settlements) are payment-history snapshots — never
 *    rewritten.
 *
 * Description only: `editEntry` with just a note has zero balance delta, and nothing here touches an
 * amount, account, installment or settlement. Idempotent — records already in step are skipped, so a
 * path that already synced (e.g. `editExpense`, same-person `changeExpenseFunding`) is unaffected.
 */

import type { Expense } from "@/lib/models/expense";
import type { Transaction } from "@/lib/models/transaction";
import type { ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";

/** True when `note` still mirrors the transaction's old description (empty counts) and the new text differs. */
export function followsDescription(note: string, oldDescription: string, newDescription: string | null | undefined): boolean {
  if (newDescription == null) return false;
  const next = newDescription.trim();
  const current = note.trim();
  return next !== "" && next !== current && (current === "" || current === oldDescription.trim());
}

export interface DescriptionSyncDeps {
  expenseRepository: Pick<ExpenseRepository, "getAll" | "syncDescription">;
  personRepository: Pick<PersonRepository, "getByKey">;
  ledgerRepositoryFor: (personId: string) => Pick<LedgerRepository, "getByTransactionRef" | "editEntry">;
}

/**
 * `transaction` is the record as it was BEFORE the save (its `description` is the old text). No-op when
 * the description didn't change.
 */
export async function syncLinkedDescription(deps: DescriptionSyncDeps, transaction: Transaction, newDescription: string | null | undefined): Promise<void> {
  if (newDescription == null) return;
  const next = newDescription.trim();
  if (next === "" || next === transaction.description.trim()) return;

  const expense = ((await deps.expenseRepository.getAll()) as Expense[]).find((e) => e.transactionId === transaction.id && e.deletedAt == null) ?? null;
  if (expense != null) await deps.expenseRepository.syncDescription(expense, next);

  const personIds = new Set([transaction.linkedPersonId, transaction.fundedByPersonId].filter((id): id is string => id != null));
  for (const personId of personIds) {
    const person = await deps.personRepository.getByKey(personId);
    if (person == null) continue;
    const ledger = deps.ledgerRepositoryFor(personId);
    for (const entry of await ledger.getByTransactionRef(transaction.id)) {
      if (entry.paymentId != null || !followsDescription(entry.note, transaction.description, next)) continue;
      await ledger.editEntry(person, entry, { note: next });
    }
  }
}
