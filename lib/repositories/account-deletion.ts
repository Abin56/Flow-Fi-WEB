/**
 * Cascading PERMANENT deletion for an Account's entire linked history —
 * every transaction that references it (plus the far leg of any transfer
 * pair, whose *own*, still-alive account balance needs reversing), every
 * split/assigned Expense funded from it, every Bill paying from it
 * (occurrences + payments included), every Loan / EMI whose money moved
 * through it (schedule, installments, payments and the legs they posted on
 * OTHER accounts), and every People-ledger entry any of that posted (with
 * each person's balance reversed). Used directly for a plain Account delete,
 * and as the shared final step of a Credit Card delete (see
 * `credit-card-deletion.ts`), since a card IS an Account underneath
 * (`lib/models/credit-card.ts`).
 *
 * Every step here is a genuine hard delete, never soft-delete/trash — this
 * is only ever reached after an explicit type-to-confirm warning
 * (`components/finance/destructive-delete-dialog.tsx`), which also lists
 * every loan/EMI/person balance that is still UNSETTLED (`impact.unsettled`)
 * and makes the user acknowledge it first.
 *
 * Not atomic end-to-end (Firestore has no cross-collection, unbounded-size
 * transaction primitive) — writes are grouped into `writeBatch`es per stage,
 * chunked to stay under Firestore's 500-writes-per-batch limit. This mirrors
 * the same non-atomic-across-stages posture `EmiRepository.permanentlyDeleteEmi`
 * already accepts for its own cascade.
 */

import { collection, getDocs, writeBatch, type DocumentReference, type Firestore, type WriteBatch } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { installmentProgress } from "@/lib/engines/installment-progress";
import { balanceEffect, hasAccountLeg, type Transaction } from "@/lib/models/transaction";
import type { Bill } from "@/lib/models/bill";
import type { Emi } from "@/lib/models/emi";
import type { Expense } from "@/lib/models/expense";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { signedAmount, type LedgerEntry, type Person } from "@/lib/models/person";
import type { AccountRepository } from "./account-repository";
import type { BillRepository } from "./bill-repository";
import type { EmiRepository } from "./emi-repository";
import type { ExpenseRepository } from "./expense-repository";
import type { LoanRepository } from "./loan-repository";
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
  loanRepository: LoanRepository;
  emiRepository: EmiRepository;
}

/** Something still open that the deletion would erase — shown in the warning dialog before anything is deleted. */
export interface UnsettledItem {
  kind: "loan" | "emi" | "person";
  name: string;
  /** Money still outstanding (always positive). */
  amount: number;
  /** "owedByMe": I still have to pay it. "owedToMe": it is still owed to me. */
  direction: "owedByMe" | "owedToMe";
  /** Loans / EMIs only: installments not fully paid yet. */
  pendingInstallments?: number;
}

export interface AccountDeletionImpact {
  transactionCount: number;
  transferSiblingCount: number;
  expenseCount: number;
  affectedPersonCount: number;
  billCount: number;
  /** Loans whose money moved through this account — all of them are deleted. */
  agreementLoanCount: number;
  /** EMIs whose money moved through this account — all of them are deleted. */
  agreementEmiCount: number;
  /** Payment legs of those loans/EMIs that sit on OTHER accounts (removed, those accounts' balances corrected). */
  agreementLegCount: number;
  /** People-ledger entries removed. */
  ledgerEntryCount: number;
  unsettled: UnsettledItem[];
}

/** Records the caller already knows belong to the account but that don't reference it through a transaction
 *  (a credit card's linked EMIs / loans). */
export interface AccountDeletionExtras {
  emis?: Emi[];
  loans?: Loan[];
}

export type Agreement =
  | { kind: "loan"; entity: Loan; installments: Installment[] }
  | { kind: "emi"; entity: Emi; installments: Installment[] };

interface LedgerSweep {
  person: Person;
  entries: LedgerEntry[];
}

interface AccountDeletionPlan extends AccountDeletionImpact {
  transactions: Transaction[];
  /** The far leg of every transfer on this account — lives on a surviving account. */
  foreignSiblings: Transaction[];
  /** Loan/EMI payment legs posted on other accounts. */
  agreementLegs: Transaction[];
  expenses: Expense[];
  bills: Bill[];
  agreements: Agreement[];
  ledgerSweeps: LedgerSweep[];
}

const BATCH_CHUNK_SIZE = 450;
const BALANCE_EPSILON = 0.005;
const AGREEMENT_SUBCOLLECTIONS = [
  FirestoreCollections.reamortizationEvents,
  FirestoreCollections.additionalDisbursements,
  FirestoreCollections.lenderCharges,
  FirestoreCollections.paymentBreakdowns,
] as const;

const round2 = (v: number) => Math.round(v * 100) / 100;

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

/** Wipes a Loan / EMI and everything under it: its own subcollections (disbursements, re-amortizations, lender
 *  charges, payment breakdowns), every installment with its payments, the schedule, then the agreement doc. */
async function queueAgreementCascade(
  agreement: Agreement,
  repos: AccountDeletionRepos,
  mutators: Array<(batch: WriteBatch) => void>,
): Promise<void> {
  const { entity, installments } = agreement;
  // Only used to address subcollections and delete the doc, so the Loan/Emi converter type is irrelevant here.
  const agreementRef = (
    agreement.kind === "loan" ? repos.loanRepository.docRef(entity.id) : repos.emiRepository.docRef(entity.id)
  ) as unknown as DocumentReference;
  const installmentRepository = repos.installmentRepositoryFor(entity.scheduleId);

  const subcollectionDocs = await Promise.all(AGREEMENT_SUBCOLLECTIONS.map((name) => getDocs(collection(agreementRef, name))));
  for (const snapshot of subcollectionDocs) {
    for (const d of snapshot.docs) mutators.push((batch) => batch.delete(d.ref));
  }

  const paymentDocs = await Promise.all(
    installments.map((installment) =>
      getDocs(collection(installmentRepository.docRef(installment.id), FirestoreCollections.payments)),
    ),
  );
  for (const snapshot of paymentDocs) {
    for (const d of snapshot.docs) mutators.push((batch) => batch.delete(d.ref));
  }
  for (const installment of installments) {
    mutators.push((batch) => batch.delete(installmentRepository.docRef(installment.id)));
  }
  mutators.push((batch) => batch.delete(repos.paymentScheduleRepository.docRef(entity.scheduleId)));
  mutators.push((batch) => batch.delete(agreementRef));
}

async function loadInstallments(scheduleId: string, repos: AccountDeletionRepos): Promise<Installment[]> {
  const installmentRepository = repos.installmentRepositoryFor(scheduleId);
  const [active, trashed] = await Promise.all([installmentRepository.getAll(), installmentRepository.getTrash()]);
  return [...active, ...trashed];
}

function agreementName(agreement: Agreement): string {
  if (agreement.kind === "emi") return agreement.entity.name;
  return agreement.entity.name ?? agreement.entity.institutionName ?? "Loan";
}

/** The warning row for a Loan / EMI that still has money to pay (or collect) — null when it is closed or fully paid. */
export function unsettledItemForAgreement(agreement: Agreement): UnsettledItem | null {
  if (agreement.entity.isClosed) return null;
  const progress = installmentProgress(agreement.installments);
  if (progress.remainingTotal <= BALANCE_EPSILON) return null;
  return {
    kind: agreement.kind,
    name: agreementName(agreement),
    amount: progress.remainingTotal,
    direction: agreement.kind === "loan" && agreement.entity.direction === "given" ? "owedToMe" : "owedByMe",
    pendingInstallments: progress.total - progress.paid,
  };
}

/** Loads a Loan / EMI with its installments, for callers (credit card delete) that pass them as `extras`. */
export async function loadAgreement(kind: Agreement["kind"], entity: Loan | Emi, repos: AccountDeletionRepos): Promise<Agreement> {
  const installments = await loadInstallments(entity.scheduleId, repos);
  return { kind, entity, installments } as Agreement;
}

async function gatherAccountDeletionPlan(
  accountId: string,
  repos: AccountDeletionRepos,
  extras: AccountDeletionExtras = {},
): Promise<AccountDeletionPlan> {
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

  const [activeBills, trashedBills] = await Promise.all([billRepository.getAll(), billRepository.getTrash()]);
  const bills = [...activeBills, ...trashedBills].filter((b) => b.accountId === accountId);

  // Loans / EMIs whose money moved through this account (a payment or disbursement transaction on it points at them).
  const loanIds = new Set<string>((extras.loans ?? []).map((l) => l.id));
  const emiIds = new Set<string>((extras.emis ?? []).map((e) => e.id));
  for (const t of transactions) {
    if (t.loanId != null) loanIds.add(t.loanId);
    if (t.emiId != null) emiIds.add(t.emiId);
  }

  const agreements: Agreement[] = [];
  if (loanIds.size > 0) {
    const [activeLoans, trashedLoans] = await Promise.all([repos.loanRepository.getAll(), repos.loanRepository.getTrash()]);
    const loans = new Map<string, Loan>();
    for (const l of [...activeLoans, ...trashedLoans, ...(extras.loans ?? [])]) if (loanIds.has(l.id)) loans.set(l.id, l);
    for (const loan of loans.values()) agreements.push(await loadAgreement("loan", loan, repos));
  }
  if (emiIds.size > 0) {
    const [activeEmis, trashedEmis] = await Promise.all([repos.emiRepository.getAll(), repos.emiRepository.getTrash()]);
    const emis = new Map<string, Emi>();
    for (const e of [...activeEmis, ...trashedEmis, ...(extras.emis ?? [])]) if (emiIds.has(e.id)) emis.set(e.id, e);
    for (const emi of emis.values()) agreements.push(await loadAgreement("emi", emi, repos));
  }

  // The same agreements may also have been paid from OTHER accounts — those legs go with them.
  let agreementLegs: Transaction[] = [];
  if (agreements.length > 0) {
    const siblingIds = new Set(foreignSiblings.map((t) => t.id));
    const [activeTransactions, trashedTransactions] = await Promise.all([transactionRepository.getAll(), transactionRepository.getTrash()]);
    agreementLegs = [...activeTransactions, ...trashedTransactions].filter(
      (t) =>
        !txIds.has(t.id) &&
        !siblingIds.has(t.id) &&
        ((t.loanId != null && loanIds.has(t.loanId)) || (t.emiId != null && emiIds.has(t.emiId))),
    );
  }

  // People ledger: every entry that points at something being removed here. Matched on the transaction it posted,
  // the income transaction of a split payment, the installment obligation it settles, or the installment payment
  // it wrote — across EVERY person, since a loan/EMI share or a payment can involve people no expense mentions.
  const removedTxIds = new Set<string>([...txIds, ...foreignSiblings.map((t) => t.id), ...agreementLegs.map((t) => t.id)]);
  const scheduleIds = [
    ...agreements.map((a) => a.entity.scheduleId),
    ...expenses.map((e) => e.scheduleId).filter((id): id is string => id != null),
  ];
  const installmentIds = agreements.flatMap((a) => a.installments.map((i) => i.id));
  const isLinkedEntry = (e: LedgerEntry) =>
    (e.transactionRef != null && removedTxIds.has(e.transactionRef)) ||
    (e.incomeTransactionRef != null && removedTxIds.has(e.incomeTransactionRef)) ||
    (e.obligationRef != null && installmentIds.some((id) => e.obligationRef?.includes(id))) ||
    (e.installmentPaymentRef != null && scheduleIds.some((id) => e.installmentPaymentRef?.startsWith(`${id}/`)));

  const [activePeople, trashedPeople] = await Promise.all([repos.personRepository.getAll(), repos.personRepository.getTrash()]);
  const ledgerSweeps: LedgerSweep[] = [];
  for (const person of [...activePeople, ...trashedPeople]) {
    const ledgerRepository = repos.ledgerRepositoryFor(person.id);
    const [activeEntries, trashedEntries] = await Promise.all([ledgerRepository.getAll(), ledgerRepository.getTrash()]);
    const entries = [...activeEntries, ...trashedEntries].filter(isLinkedEntry);
    if (entries.length > 0) ledgerSweeps.push({ person, entries });
  }

  const affectedPersonIds = new Set<string>(ledgerSweeps.map((s) => s.person.id));
  for (const e of expenses) {
    for (const p of e.participants) {
      if (p.personId != null) affectedPersonIds.add(p.personId);
    }
  }

  const unsettled: UnsettledItem[] = [];
  for (const agreement of agreements) {
    const item = unsettledItemForAgreement(agreement);
    if (item != null) unsettled.push(item);
  }
  for (const { person } of ledgerSweeps) {
    if (person.deletedAt != null || Math.abs(person.currentBalance) < BALANCE_EPSILON) continue;
    unsettled.push({
      kind: "person",
      name: person.name,
      amount: round2(Math.abs(person.currentBalance)),
      direction: person.currentBalance > 0 ? "owedToMe" : "owedByMe",
    });
  }

  return {
    transactions,
    foreignSiblings,
    agreementLegs,
    expenses,
    bills,
    agreements,
    ledgerSweeps,
    transactionCount: transactions.length,
    transferSiblingCount: foreignSiblings.length,
    expenseCount: expenses.length,
    affectedPersonCount: affectedPersonIds.size,
    billCount: bills.length,
    agreementLoanCount: agreements.filter((a) => a.kind === "loan").length,
    agreementEmiCount: agreements.filter((a) => a.kind === "emi").length,
    agreementLegCount: agreementLegs.length,
    ledgerEntryCount: ledgerSweeps.reduce((sum, s) => sum + s.entries.length, 0),
    unsettled,
  };
}

/** Read-only preview for the type-to-confirm delete dialog — same gather logic `permanentlyDeleteAccountHistory`
 *  executes against, so the counts shown to the user are exactly what will be destroyed. */
export async function previewAccountDeletionImpact(
  accountId: string,
  repos: AccountDeletionRepos,
  extras?: AccountDeletionExtras,
): Promise<AccountDeletionImpact> {
  const plan = await gatherAccountDeletionPlan(accountId, repos, extras);
  return {
    transactionCount: plan.transactionCount,
    transferSiblingCount: plan.transferSiblingCount,
    expenseCount: plan.expenseCount,
    affectedPersonCount: plan.affectedPersonCount,
    billCount: plan.billCount,
    agreementLoanCount: plan.agreementLoanCount,
    agreementEmiCount: plan.agreementEmiCount,
    agreementLegCount: plan.agreementLegCount,
    ledgerEntryCount: plan.ledgerEntryCount,
    unsettled: plan.unsettled,
  };
}

/** Deletes everything *linked to* the account (transactions, transfer siblings, expenses, loans/EMIs, people
 *  ledger entries, bills) but NOT the account doc itself — callers delete their own root doc(s)
 *  afterward (a plain account delete vs. a credit-card delete, which also owns a
 *  `CreditCardProfile`; see `credit-card-deletion.ts`). */
export async function permanentlyDeleteAccountHistory(
  accountId: string,
  repos: AccountDeletionRepos,
  extras?: AccountDeletionExtras,
): Promise<void> {
  const plan = await gatherAccountDeletionPlan(accountId, repos, extras);
  const mutators: Array<(batch: WriteBatch) => void> = [];

  // 1. People ledger: every entry linked to anything removed here goes (trashed ones too), and each person's
  //    cached balance is corrected once by the net effect of their ACTIVE entries — a trashed entry's effect
  //    was already reversed when it was trashed.
  for (const { person, entries } of plan.ledgerSweeps) {
    const reversalDelta = -entries.filter((e) => e.deletedAt == null).reduce((sum, entry) => sum + signedAmount(entry), 0);
    const ledgerRepository = repos.ledgerRepositoryFor(person.id);
    if (reversalDelta !== 0) {
      const updatedPerson = repos.personRepository.applyBalanceDelta(person, reversalDelta);
      mutators.push((batch) => batch.set(repos.personRepository.docRef(person.id), updatedPerson));
    }
    for (const entry of entries) {
      mutators.push((batch) => batch.delete(ledgerRepository.docRef(entry.id)));
    }
  }

  // 2. Split/assigned expenses funded from this account: their schedule/installments, then the expense doc
  //    itself (their ledger entries were swept above). Mirrors `ExpenseRepository.deleteExpense`'s
  //    cascade shape, but hard-deletes instead of trashing.
  for (const expense of plan.expenses) {
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

  // 3. Loans / EMIs paid or disbursed through this account — wiped entirely.
  for (const agreement of plan.agreements) {
    await queueAgreementCascade(agreement, repos, mutators);
  }

  // 4. The account's own transactions — no balance reversal needed, the account is being
  //    destroyed wholesale.
  for (const transaction of plan.transactions) {
    mutators.push((batch) => batch.delete(repos.transactionRepository.docRef(transaction.id)));
  }

  // 5. Transfer legs and loan/EMI payment legs on *surviving* accounts: reverse each affected account's
  //    balance (netted per account) for every leg that was still live, then delete the leg itself.
  const foreignLegs = [...plan.foreignSiblings, ...plan.agreementLegs];
  const deltaByAccountId = new Map<string, number>();
  for (const leg of foreignLegs) {
    if (leg.deletedAt != null || !hasAccountLeg(leg)) continue;
    const delta = -balanceEffect(leg);
    deltaByAccountId.set(leg.accountId, (deltaByAccountId.get(leg.accountId) ?? 0) + delta);
  }
  for (const [otherAccountId, delta] of deltaByAccountId) {
    if (delta === 0) continue;
    const otherAccount = await repos.accountRepository.getByKey(otherAccountId);
    if (otherAccount == null) continue;
    const updated = repos.accountRepository.applyBalanceDelta(otherAccount, delta);
    mutators.push((batch) => batch.set(repos.accountRepository.docRef(otherAccountId), updated));
  }
  for (const leg of foreignLegs) {
    mutators.push((batch) => batch.delete(repos.transactionRepository.docRef(leg.id)));
  }

  // 6. Bills paying from this account.
  for (const bill of plan.bills) {
    await queueBillCascade(bill, repos, mutators);
  }

  await commitInChunks(db, mutators);
}
