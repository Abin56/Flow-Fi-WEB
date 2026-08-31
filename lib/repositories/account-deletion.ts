/**
 * Cascading PERMANENT deletion for an Account's entire linked history —
 * every transaction that references it (plus the far leg of any transfer
 * pair, whose *own*, still-alive account balance needs reversing), every
 * split/assigned Expense funded from it (and the LedgerEntry/Person-balance
 * effects those posted), and every Bill paying from it (occurrences +
 * payments included). Used directly for a plain Account delete, and as the
 * shared final step of a Credit Card delete (see `credit-card-deletion.ts`),
 * since a card IS an Account underneath (`lib/models/credit-card.ts`).
 *
 * Every step here is a genuine hard delete, never soft-delete/trash — this
 * is only ever reached after an explicit type-to-confirm warning
 * (`components/finance/destructive-delete-dialog.tsx`), replacing the old
 * "block deletion while anything references it" posture entirely.
 *
 * Not atomic end-to-end (Firestore has no cross-collection, unbounded-size
 * transaction primitive) — writes are grouped into `writeBatch`es per stage,
 * chunked to stay under Firestore's 500-writes-per-batch limit. This mirrors
 * the same non-atomic-across-stages posture `EmiRepository.permanentlyDeleteEmi`
 * already accepts for its own cascade.
 */

import { collection, getDocs, writeBatch, type Firestore, type WriteBatch } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";
import type { Bill } from "@/lib/models/bill";
import type { Expense } from "@/lib/models/expense";
import { signedAmount } from "@/lib/models/person";
import type { AccountRepository } from "./account-repository";
import type { BillRepository } from "./bill-repository";
import type { ExpenseRepository } from "./expense-repository";
import type { InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";
import type { LedgerRepository, PersonRepository } from "./person-repository";
import type { TransactionRepository } from "./transaction-repository";

export interface AccountDeletionRepos {
  uid: string;
  transactionRepository: TransactionRepository;
  accountRepository: AccountRepository;
  billRepository: BillRepository;
  expenseRepository: ExpenseRepository;
  personRepository: PersonRepository;
  ledgerRepositoryFor: (personId: string) => LedgerRepository;
  paymentScheduleRepository: PaymentScheduleRepository;
  installmentRepositoryFor: (scheduleId: string) => InstallmentRepository;
}

export interface AccountDeletionImpact {
  transactionCount: number;
  transferSiblingCount: number;
  expenseCount: number;
  affectedPersonCount: number;
  billCount: number;
}

interface AccountDeletionPlan extends AccountDeletionImpact {
  transactions: Transaction[];
  foreignSiblings: Transaction[];
  expenses: Expense[];
  bills: Bill[];
}

const BATCH_CHUNK_SIZE = 450;

/** Queues `mutators` across as many `writeBatch`es as needed to stay under Firestore's
 *  500-writes-per-batch cap — see this file's module doc for the non-atomicity trade-off. */
async function commitInChunks(firestore: Firestore, mutators: Array<(batch: WriteBatch) => void>): Promise<void> {
  for (let i = 0; i < mutators.length; i += BATCH_CHUNK_SIZE) {
    const batch = writeBatch(firestore);
    for (const mutate of mutators.slice(i, i + BATCH_CHUNK_SIZE)) mutate(batch);
    await batch.commit();
  }
}

/** Deletes every doc (occurrences + payments + the bill itself) under `bill` — both live
 *  directly under `bills/{billId}` per `FirestoreCollections`' doc comments, so nothing here
 *  needs `deletedAt` filtering: the whole bill is being wiped regardless of trash state. */
async function queueBillCascade(
  bill: Bill,
  repos: AccountDeletionRepos,
  mutators: Array<(batch: WriteBatch) => void>,
): Promise<void> {
  const billDocRef = repos.billRepository.docRef(bill.id);
  const occurrencesRef = collection(billDocRef, FirestoreCollections.billOccurrences);
  const paymentsRef = collection(billDocRef, FirestoreCollections.payments);
  const [occurrenceDocs, paymentDocs] = await Promise.all([getDocs(occurrencesRef), getDocs(paymentsRef)]);
  for (const d of occurrenceDocs.docs) mutators.push((batch) => batch.delete(d.ref));
  for (const d of paymentDocs.docs) mutators.push((batch) => batch.delete(d.ref));
  mutators.push((batch) => batch.delete(billDocRef));
}

async function gatherAccountDeletionPlan(accountId: string, repos: AccountDeletionRepos): Promise<AccountDeletionPlan> {
  const { transactionRepository, expenseRepository, billRepository } = repos;

  const transactions = await transactionRepository.getAllForAccountIncludingTrash(accountId);
  const txIds = new Set(transactions.map((t) => t.id));

  // Any transfer leg on a *surviving* account whose sibling is being deleted here needs its own
  // balance reversed (the account being deleted needs no such reversal — it's being destroyed
  // wholesale). Deduped by id in case two of this account's own legs point at the same sibling
  // (never happens in practice, but cheap to guard).
  const foreignSiblingsById = new Map<string, Transaction>();
  for (const t of transactions) {
    if (t.transferId == null) continue;
    const sibling = await transactionRepository.findTransferSibling(t);
    if (sibling != null && sibling.accountId !== accountId && !txIds.has(sibling.id)) {
      foreignSiblingsById.set(sibling.id, sibling);
    }
  }
  const foreignSiblings = [...foreignSiblingsById.values()];

  const [activeExpenses, trashedExpenses] = await Promise.all([expenseRepository.getAll(), expenseRepository.getTrash()]);
  const expenses = [...activeExpenses, ...trashedExpenses].filter((e) => txIds.has(e.transactionId));

  const affectedPersonIds = new Set<string>();
  for (const e of expenses) {
    for (const p of e.participants) {
      if (p.personId != null) affectedPersonIds.add(p.personId);
    }
  }

  const [activeBills, trashedBills] = await Promise.all([billRepository.getAll(), billRepository.getTrash()]);
  const bills = [...activeBills, ...trashedBills].filter((b) => b.accountId === accountId);

  return {
    transactions,
    foreignSiblings,
    expenses,
    bills,
    transactionCount: transactions.length,
    transferSiblingCount: foreignSiblings.length,
    expenseCount: expenses.length,
    affectedPersonCount: affectedPersonIds.size,
    billCount: bills.length,
  };
}

/** Read-only preview for the type-to-confirm delete dialog — same gather logic `permanentlyDeleteAccountHistory`
 *  executes against, so the counts shown to the user are exactly what will be destroyed. */
export async function previewAccountDeletionImpact(accountId: string, repos: AccountDeletionRepos): Promise<AccountDeletionImpact> {
  const { transactionCount, transferSiblingCount, expenseCount, affectedPersonCount, billCount } =
    await gatherAccountDeletionPlan(accountId, repos);
  return { transactionCount, transferSiblingCount, expenseCount, affectedPersonCount, billCount };
}

/** Deletes everything *linked to* the account (transactions, transfer siblings, expenses, ledger
 *  entries, bills) but NOT the account doc itself — callers delete their own root doc(s)
 *  afterward (a plain account delete vs. a credit-card delete, which also owns a
 *  `CreditCardProfile`; see `credit-card-deletion.ts`). */
export async function permanentlyDeleteAccountHistory(accountId: string, repos: AccountDeletionRepos): Promise<void> {
  const plan = await gatherAccountDeletionPlan(accountId, repos);
  const mutators: Array<(batch: WriteBatch) => void> = [];

  // 1. Split/assigned expenses funded from this account: reverse + remove every ledger entry
  //    they posted (across every participant's own person subcollection), then their
  //    schedule/installments, then the expense doc itself. Mirrors `ExpenseRepository.deleteExpense`'s
  //    cascade shape, but hard-deletes instead of trashing.
  for (const expense of plan.expenses) {
    for (const participant of expense.participants) {
      if (participant.personId == null) continue;
      const person = await repos.personRepository.getByKey(participant.personId);
      if (person == null) continue;

      const ledgerRepository = repos.ledgerRepositoryFor(person.id);
      const [activeEntries, trashedEntries] = await Promise.all([
        ledgerRepository.getByTransactionRef(expense.transactionId),
        ledgerRepository.getTrashByTransactionRef(expense.transactionId),
      ]);
      if (activeEntries.length === 0 && trashedEntries.length === 0) continue;

      // One net balance correction per person per expense, rather than one write per entry.
      const reversalDelta = -activeEntries.reduce((sum, entry) => sum + signedAmount(entry), 0);
      if (reversalDelta !== 0) {
        const updatedPerson = repos.personRepository.applyBalanceDelta(person, reversalDelta);
        mutators.push((batch) => batch.set(repos.personRepository.docRef(person.id), updatedPerson));
      }
      for (const entry of [...activeEntries, ...trashedEntries]) {
        mutators.push((batch) => batch.delete(ledgerRepository.docRef(entry.id)));
      }
    }

    if (expense.scheduleId != null) {
      const scheduleId = expense.scheduleId;
      const installmentRepository = repos.installmentRepositoryFor(scheduleId);
      const [activeInstallments, trashedInstallments] = await Promise.all([
        installmentRepository.getAll(),
        installmentRepository.getTrash(),
      ]);
      for (const installment of [...activeInstallments, ...trashedInstallments]) {
        mutators.push((batch) => batch.delete(installmentRepository.docRef(installment.id)));
      }
      mutators.push((batch) => batch.delete(repos.paymentScheduleRepository.docRef(scheduleId)));
    }

    mutators.push((batch) => batch.delete(repos.expenseRepository.docRef(expense.id)));
  }

  // 2. The account's own transactions — no balance reversal needed, the account is being
  //    destroyed wholesale.
  for (const transaction of plan.transactions) {
    mutators.push((batch) => batch.delete(repos.transactionRepository.docRef(transaction.id)));
  }

  // 3. Transfer legs on *surviving* accounts: reverse each affected account's balance (netted
  //    per account, in case more than one deleted leg's sibling lands on the same account), then
  //    delete the sibling transaction itself.
  const deltaByAccountId = new Map<string, number>();
  for (const sibling of plan.foreignSiblings) {
    const delta = -balanceEffect(sibling);
    deltaByAccountId.set(sibling.accountId, (deltaByAccountId.get(sibling.accountId) ?? 0) + delta);
  }
  for (const [otherAccountId, delta] of deltaByAccountId) {
    if (delta === 0) continue;
    const otherAccount = await repos.accountRepository.getByKey(otherAccountId);
    if (otherAccount == null) continue;
    const updated = repos.accountRepository.applyBalanceDelta(otherAccount, delta);
    mutators.push((batch) => batch.set(repos.accountRepository.docRef(otherAccountId), updated));
  }
  for (const sibling of plan.foreignSiblings) {
    mutators.push((batch) => batch.delete(repos.transactionRepository.docRef(sibling.id)));
  }

  // 4. Bills paying from this account.
  for (const bill of plan.bills) {
    await queueBillCascade(bill, repos, mutators);
  }

  await commitInChunks(db, mutators);
}
