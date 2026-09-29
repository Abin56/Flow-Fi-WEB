/**
 * Deleting a People cash-leg Transaction (`isPersonLedgerMovement` — the real account movement posted
 * with a "Borrowed" / "Gave" / "Repaid" / "Received back" People-ledger entry) from anywhere other than
 * the People Ledger, e.g. the Transactions page.
 *
 * Before this, such a delete only soft-deleted the Transaction, leaving its ledger entry behind — an
 * orphan "You owe them ₹X" with no transaction under it. Now it resolves the entry through the stored
 * link (`LedgerEntry.transactionRef === transaction.id`, person from `transaction.linkedPersonId`),
 * plans exactly what the People Ledger's own Delete would (`planEntryDeletion`: the entry plus the
 * settlements recorded against it via `parentEntryId`), and removes it through the same atomic
 * `LedgerRepository.softDeleteEntriesWithCashLegs`. Nothing is ever matched by amount, date or name.
 */

import { planEntryDeletion } from "@/lib/engines/person-ledger-deletion";
import type { Transaction } from "@/lib/models/transaction";
import type { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";

export class PersonCashLegDeleteBlockedError extends Error {
  constructor() {
    super("A payment on this entry belongs to a split expense — reverse that payment from the expense first");
    this.name = "PersonCashLegDeleteBlockedError";
  }
}

export async function deletePersonCashLegTransaction(params: {
  transaction: Transaction;
  transactionRepository: TransactionRepository;
  personRepository: PersonRepository;
  ledgerRepositoryFor: (personId: string) => LedgerRepository;
}): Promise<void> {
  const { transaction, transactionRepository, personRepository, ledgerRepositoryFor } = params;
  const personId = transaction.linkedPersonId;
  const person = personId == null ? null : await personRepository.getByKey(personId);
  // No person / no entry pointing at this transaction (a person deleted since, or a record from before
  // entries carried the link): there is no ledger effect to reconcile — plain delete, as before.
  if (personId == null || person == null) return transactionRepository.softDeleteTransaction(transaction);

  const ledgerRepository = ledgerRepositoryFor(personId);
  const entries = await ledgerRepository.getAll();
  const entry = entries.find((e) => e.transactionRef === transaction.id);
  if (entry == null) return transactionRepository.softDeleteTransaction(transaction);

  // Which of the affected entries' links are People cash legs — read from the linked Transaction itself.
  const cashLegIds = new Set<string>([transaction.id]);
  const affected = entries.filter((e) => e.id !== entry.id && e.parentEntryId === entry.id && e.transactionRef != null);
  for (const e of affected) {
    const linked = await transactionRepository.getByKey(e.transactionRef!);
    if (linked?.isPersonLedgerMovement) cashLegIds.add(linked.id);
  }

  const plan = planEntryDeletion(entry.id, entries, cashLegIds);
  if (!plan.ok) throw new PersonCashLegDeleteBlockedError();
  await ledgerRepository.softDeleteEntriesWithCashLegs(person, plan.entries, transactionRepository);
}
