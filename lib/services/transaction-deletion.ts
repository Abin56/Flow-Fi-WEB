/**
 * THE delete for a Transaction, whichever screen it starts from (Transactions list, details modal,
 * Transaction Studio single-row and bulk delete). The same transaction must never behave differently
 * depending on the screen: before this, Transaction Studio soft-deleted the bare transaction, leaving
 * the People obligation of a person-funded / borrowed / split expense behind as a ghost ledger row.
 *
 * Routing, by the transaction's own ownership contract (never by amount/date/name):
 *  - a transfer leg → both legs together (`deleteTransferPair`);
 *  - backed by a split/assigned Expense → `deleteExpense` (schedule, installments, every share entry);
 *  - a People cash leg or a person-funded expense → `deletePersonLinked` (the People Ledger's own
 *    planner + atomic delete — the obligation goes with it);
 *  - anything else → a plain balance-reversing soft delete.
 */

import { isPersonFunded, type Transaction } from "@/lib/models/transaction";
import type { Expense } from "@/lib/models/expense";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";

export interface TransactionDeletionDeps {
  transactionRepository: Pick<TransactionRepository, "deleteTransferPair" | "softDeleteTransaction">;
  /** The active Expense whose `transactionId` is this transaction, if any. */
  findExpense: (transactionId: string) => Promise<Expense | null>;
  deleteExpense: (expense: Expense) => Promise<void>;
  /** `deletePersonCashLegTransaction`, already bound to its repositories. */
  deletePersonLinked: (transaction: Transaction) => Promise<void>;
}

export async function deleteTransactionWithLinkedEffects(
  transaction: Transaction,
  deps: TransactionDeletionDeps,
  /** Pass when the caller already has it; otherwise it is looked up, so no caller can forget it. */
  knownExpense?: Expense | null,
): Promise<void> {
  if (transaction.transferId != null) return deps.transactionRepository.deleteTransferPair(transaction);
  const expense = knownExpense ?? (await deps.findExpense(transaction.id));
  if (expense) return deps.deleteExpense(expense);
  if (transaction.isPersonLedgerMovement || isPersonFunded(transaction)) return deps.deletePersonLinked(transaction);
  return deps.transactionRepository.softDeleteTransaction(transaction);
}
