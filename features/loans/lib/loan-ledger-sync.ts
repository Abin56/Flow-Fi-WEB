/**
 * Keeps a personal loan's People Ledger entry in sync with the loan itself.
 * Only "personal" loans (`Loan.category === "personal"`, `Loan.personId` set)
 * touch the ledger — institutional loans have no linked `Person`. Every entry
 * this module posts carries `transactionRef: loan.id`, so it can be found
 * again (`LedgerRepository.getByTransactionRef`) to reverse or restore
 * without maintaining a second id anywhere on `Loan` itself.
 *
 * Direction mirrors `LoanDirection`: "taken" (you borrowed) posts "borrowed"
 * at creation and "repaid" per EMI payment, exactly like a real payable
 * shrinking as it's paid off. "given" (you lent) posts "gave"/"receivedBack"
 * the same way, mirroring a receivable.
 */

import type { Loan } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { createLedgerRepository } from "@/features/people/lib/ledger-factory";

function isPersonalLoan(loan: Loan): loan is Loan & { personId: string } {
  return loan.category === "personal" && loan.personId != null;
}

async function ledgerRepositoryFor(
  uid: string,
  loan: Loan,
  personRepository: PersonRepository,
): Promise<{ ledgerRepository: LedgerRepository; person: Person } | null> {
  if (!isPersonalLoan(loan)) return null;
  const person = await personRepository.getByKey(loan.personId);
  if (person == null) return null;
  return { ledgerRepository: createLedgerRepository(uid, loan.personId, personRepository), person };
}

/** Posts the initial "borrowed"/"gave" entry for a newly created personal loan. Given/taken decides sign. */
export async function postLoanCreatedLedgerEntry(
  uid: string,
  loan: Loan,
  personRepository: PersonRepository,
): Promise<void> {
  const target = await ledgerRepositoryFor(uid, loan, personRepository);
  if (target == null) return;
  await target.ledgerRepository.addEntry(target.person, {
    type: loan.direction === "taken" ? "borrowed" : "gave",
    amount: loan.loanAmount,
    date: loan.loanDate,
    note: loan.name?.trim() ? loan.name.trim() : "Loan",
    transactionRef: loan.id,
  });
}

/** Posts a "repaid"/"receivedBack" entry for one EMI payment against a personal loan. */
export async function postLoanPaymentLedgerEntry(
  uid: string,
  loan: Loan,
  personRepository: PersonRepository,
  params: { amount: number; date: Date; note?: string },
): Promise<void> {
  const target = await ledgerRepositoryFor(uid, loan, personRepository);
  if (target == null) return;
  await target.ledgerRepository.addEntry(target.person, {
    type: loan.direction === "taken" ? "repaid" : "receivedBack",
    amount: params.amount,
    date: params.date,
    note: params.note?.trim() ? params.note.trim() : `Loan payment: ${loan.name?.trim() || "Loan"}`,
    transactionRef: loan.id,
  });
}

/** Reverses (soft-deletes) every active ledger entry linked to this loan — used when the loan is trashed. */
export async function reverseLoanLedgerEntries(
  uid: string,
  loan: Loan,
  personRepository: PersonRepository,
): Promise<void> {
  const target = await ledgerRepositoryFor(uid, loan, personRepository);
  if (target == null) return;
  const entries = await target.ledgerRepository.getByTransactionRef(loan.id);
  for (const entry of entries) {
    await target.ledgerRepository.softDeleteEntry(target.person, entry);
  }
}

/** Restores every trashed ledger entry linked to this loan — used when the loan is restored from trash. */
export async function restoreLoanLedgerEntries(
  uid: string,
  loan: Loan,
  personRepository: PersonRepository,
): Promise<void> {
  const target = await ledgerRepositoryFor(uid, loan, personRepository);
  if (target == null) return;
  const entries = await target.ledgerRepository.getTrashByTransactionRef(loan.id);
  for (const entry of entries) {
    await target.ledgerRepository.restoreEntry(target.person, entry);
  }
}
