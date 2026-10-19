/**
 * Activity & Undo — the I/O half. `resolveUndoFacts` reads, FRESH from Firestore, exactly the documents an
 * action's undo depends on (never the screen's cached copy) and hands them to the pure `decideUndo`.
 * `executeUndo` then calls the module's OWN reversal handler — each re-reads and re-checks inside its
 * Firestore transaction, so a stale screen, a repeat click or a second tab can never move money twice.
 * Ownership is only ever proven through stored ids (transactionRef / incomeTransactionRef / purpose refs /
 * payment doc ids / transactionId); a name match is only used to decide which bill to LOOK in first.
 */

import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import type { ActivityItem } from "@/features/activity/lib/activity-classify";
import type { PeopleReference, UndoFacts, UndoHandler } from "@/features/activity/lib/undo-eligibility";
import { groupRecordedPayments } from "@/features/loans/lib/recorded-payments";
import { createBillOccurrenceRepository, createPaymentRepository } from "@/features/bills/lib/bill-occurrence-factory";
import { splitExpenseDetailFor } from "@/lib/engines/history-builder";
import { paymentImpact } from "@/lib/engines/person-payment-impact";
import { purposeCashOf } from "@/lib/engines/purpose-funds";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { safeDocs } from "@/lib/firestore/safe-docs";
import type { Emi } from "@/lib/models/emi";
import { isSplit, myShare } from "@/lib/models/expense";
import type { Loan } from "@/lib/models/loan";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, type AdvanceApplication, type LedgerEntry, type Person } from "@/lib/models/person";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import type { PurposeFund } from "@/lib/models/purpose-fund";
import { transferFeeIdFor, type Transaction } from "@/lib/models/transaction";
import {
  createAccountRepository,
  createAdvanceApplicationsCollection,
  createBillRepository,
  createEmiRepository,
  createExpenseRepository,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createLoanRepository,
  createPersonRepository,
  createPurposeFundsCollection,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";

export interface ResolveDeps {
  db: Firestore;
  uid: string;
  /** Live people ids to look through for a People / purpose reference (D3). */
  personIds: readonly string[];
}

function ledgerCollection(db: Firestore, uid: string, personId: string) {
  return collection(db, FirestoreCollections.users, uid, FirestoreCollections.people, personId, FirestoreCollections.ledger).withConverter({
    toFirestore: ledgerEntryToFirestore,
    fromFirestore: ledgerEntryFromFirestore,
  });
}

function fundReferences(f: PurposeFund, transactionId: string): boolean {
  return (
    f.receiptTransactionRef === transactionId ||
    f.incomeTransactionRef === transactionId ||
    (f.release?.kind === "income" && f.release.ref === transactionId) ||
    f.uses.some((u) => u.transactionId === transactionId)
  );
}

/**
 * D3: a transaction with no owner marker can still be a People payment's separate income part
 * (`incomeTransactionRef`), a ledger entry's linked record (`transactionRef`), or purpose money's receipt /
 * use / release. Checked across every person, by stored id only.
 */
export async function findPeopleReference(deps: ResolveDeps, transactionIds: readonly string[]): Promise<PeopleReference | null> {
  const ids = [...new Set(transactionIds)];
  // People are checked in parallel; the first reference in `personIds` order wins, so the answer is deterministic.
  const perPerson = await Promise.all(
    deps.personIds.map(async (personId): Promise<PeopleReference | null> => {
      const ledger = ledgerCollection(deps.db, deps.uid, personId);
      const snaps = await Promise.all(
        ids.flatMap((id) => [getDocs(query(ledger, where("incomeTransactionRef", "==", id))), getDocs(query(ledger, where("transactionRef", "==", id)))]),
      );
      if (snaps.some((snap) => safeDocs(snap.docs).some((e) => e.deletedAt == null))) return { personId, via: "ledger" };
      const funds = safeDocs((await getDocs(createPurposeFundsCollection(deps.uid, personId))).docs).filter((f) => f.deletedAt == null);
      return funds.some((f) => ids.some((id) => fundReferences(f, id))) ? { personId, via: "purpose" } : null;
    }),
  );
  return perPerson.find((r) => r != null) ?? null;
}

function sharedWithPeople(owner: { ownershipShares?: { personId: string | null }[] | null; beneficiaryPersonId?: string | null }): boolean {
  return (owner.ownershipShares ?? []).some((s) => s.personId != null) || owner.beneficiaryPersonId != null;
}

async function schedulePayments(uid: string, scheduleId: string): Promise<{ installments: Installment[]; payments: InstallmentPayment[] }> {
  const installmentRepository = createInstallmentRepositoryFor(uid, scheduleId);
  const installments = (await installmentRepository.getAll()).filter((i) => i.deletedAt == null);
  const payments = (
    await Promise.all(installments.map((i) => createInstallmentPaymentRepositoryFor(uid, scheduleId, i.id, installmentRepository).getAll()))
  ).flat();
  return { installments, payments: payments.filter((p) => p.deletedAt == null) };
}

async function peopleFacts(deps: ResolveDeps, fresh: Transaction): Promise<UndoFacts> {
  const personId = fresh.linkedPersonId ?? fresh.fundedByPersonId ?? null;
  if (personId == null) return { kind: "people", fresh, personId: null, paymentId: null, impact: null, entry: null };
  const personRepository = createPersonRepository(deps.uid);
  const ledger = createLedgerRepositoryFor(deps.uid, personId, personRepository);
  const owned = await ledger.getByTransactionRef(fresh.id);
  const funds = safeDocs((await getDocs(createPurposeFundsCollection(deps.uid, personId))).docs).filter((f) => f.deletedAt == null);
  const paymentId = owned.find((e) => e.paymentId != null)?.paymentId ?? funds.find((f) => f.receiptTransactionRef === fresh.id)?.paymentId ?? null;

  if (paymentId != null) {
    const entries = await ledger.getByPaymentId(paymentId);
    const advanceIds = entries.filter((e) => e.deletedAt == null && e.sourceKind === "advance").map((e) => e.id);
    const applications: AdvanceApplication[] = [];
    for (const id of advanceIds) {
      const snap = await getDocs(query(createAdvanceApplicationsCollection(deps.uid, personId), where("advanceEntryId", "==", id)));
      applications.push(...safeDocs(snap.docs));
    }
    const paymentFunds = funds.filter((f) => f.paymentId === paymentId);
    const transactionRepository = createTransactionRepository(deps.uid, createAccountRepository(deps.uid));
    const refIds = [
      ...entries.flatMap((e) => [e.transactionRef, e.incomeTransactionRef ?? null]),
      ...paymentFunds.flatMap((f) => [f.receiptTransactionRef, f.incomeTransactionRef ?? null]),
    ].filter((id): id is string => id != null);
    const byId = new Map<string, Transaction>();
    for (const id of new Set(refIds)) {
      const t = await transactionRepository.getByKey(id);
      if (t) byId.set(id, t);
    }
    const impact = paymentImpact({
      paymentId,
      entries,
      applications,
      transactionOf: (id) => byId.get(id),
      purposeAmount: purposeCashOf(funds, paymentId),
      purposeCashRefs: paymentFunds.map((f) => f.receiptTransactionRef),
      purposeIncomeRefs: paymentFunds.flatMap((f) => (f.incomeTransactionRef ? [f.incomeTransactionRef] : [])),
    });
    return { kind: "people", fresh, personId, paymentId, impact, entry: null };
  }

  // An older single People entry (or a person-funded expense's entry) owned by this transaction.
  if (owned.length !== 1) return { kind: "people", fresh, personId, paymentId: null, impact: null, entry: null };
  const all: LedgerEntry[] = await ledger.getAll();
  const dependents = all.filter((e) => e.deletedAt == null && e.parentEntryId === owned[0].id).length;
  return { kind: "people", fresh, personId, paymentId: null, impact: null, entry: { id: owned[0].id, dependents } };
}

async function billFacts(deps: ResolveDeps, fresh: Transaction): Promise<UndoFacts> {
  const paymentId = fresh.billPaymentId!;
  const billRepository = createBillRepository(deps.uid);
  const bills = [...(await billRepository.getAll()), ...(await billRepository.getTrash())];
  // The name only decides where to look first; ownership is proven by the payment doc existing under that bill
  // AND pointing back at this exact transaction (`decideUndo` checks `payment.transactionId`).
  bills.sort((a, b) => Number(b.name === fresh.description) - Number(a.name === fresh.description));
  for (const { id: billId } of bills) {
    const payment = await createPaymentRepository(deps.uid, billId, createBillOccurrenceRepository(deps.uid, billId, billRepository)).getByKey(paymentId);
    if (payment == null) continue;
    return { kind: "billPayment", fresh, billId, payment: { id: payment.id, transactionId: payment.transactionId ?? null, deleted: payment.deletedAt != null } };
  }
  return { kind: "billPayment", fresh, billId: null, payment: null };
}

/** Fresh facts for one action (card-payment figures are added by the caller from the Credit Cards preview). */
export async function resolveUndoFacts(deps: ResolveDeps, item: ActivityItem): Promise<UndoFacts> {
  const transactionRepository = createTransactionRepository(deps.uid, createAccountRepository(deps.uid));
  const fresh = await transactionRepository.getByKey(item.anchor.id);
  if (fresh == null) return { kind: "missing" };

  switch (item.kind) {
    case "transfer":
    case "cardPayment": {
      const sibling = await transactionRepository.findTransferSibling(fresh);
      const legs = [fresh, ...(sibling ? [sibling] : [])];
      const feeDoc = fresh.transferId ? await transactionRepository.getByKey(transferFeeIdFor(fresh.transferId)) : null;
      const fee = feeDoc != null && feeDoc.deletedAt == null && feeDoc.transferFeeForId === fresh.transferId ? feeDoc : null;
      const reference = fresh.deletedAt == null ? await findPeopleReference(deps, legs.map((t) => t.id)) : null;
      return { kind: "transfer", legs, fee, reference, card: null };
    }
    case "loanPayment": {
      const loan: Loan | null = item.loanId ? await createLoanRepository(deps.uid).getByKey(item.loanId) : null;
      if (loan == null) return { kind: "loanPayment", fresh, loan: null, action: null, all: [] };
      const { installments, payments } = await schedulePayments(deps.uid, loan.scheduleId);
      const all = groupRecordedPayments(payments, installments, "loan");
      const action = all.find((a) => a.transactionId === fresh.id) ?? null;
      return { kind: "loanPayment", fresh, loan: { id: loan.id, closed: loan.isClosed, trashed: loan.deletedAt != null, sharedWithPeople: sharedWithPeople(loan) }, action, all };
    }
    case "emiPayment": {
      const emi: Emi | null = item.emiId ? await createEmiRepository(deps.uid).getByKey(item.emiId) : null;
      if (emi == null || fresh.installmentPaymentId == null) return { kind: "emiPayment", fresh, emi: null, action: null, all: [] };
      const { installments, payments } = await schedulePayments(deps.uid, emi.scheduleId);
      const all = groupRecordedPayments(payments, installments, "emi");
      const action = all.find((a) => a.portions.some((p) => p.id === fresh.installmentPaymentId)) ?? null;
      return { kind: "emiPayment", fresh, emi: { id: emi.id, closed: emi.isClosed, trashed: emi.deletedAt != null, sharedWithPeople: sharedWithPeople(emi) }, action, all };
    }
    case "billPayment":
      return billFacts(deps, fresh);
    case "peopleMovement":
    case "personFunded":
      return peopleFacts(deps, fresh);
    case "splitExpense": {
      const expense = await createExpenseRepository(deps.uid, createAccountRepository(deps.uid)).findActiveByTransactionId(fresh.id);
      if (expense == null) return { kind: "split", fresh, expenseLive: false, collected: 0, anyReceived: false };
      const installments = expense.scheduleId ? (await createInstallmentRepositoryFor(deps.uid, expense.scheduleId).getAll()).filter((i) => i.deletedAt == null) : [];
      const detail = splitExpenseDetailFor(
        { transactionId: expense.transactionId, isSplit: isSplit(expense), scheduleId: expense.scheduleId, myShare: myShare(expense), participants: expense.participants },
        expense.scheduleId ? { [expense.scheduleId]: installments.map((i) => ({ scheduleId: i.scheduleId, amountPaid: i.amountPaid, remainingAmount: 0, status: "upcoming" as const })) } : {},
      );
      return { kind: "split", fresh, expenseLive: true, collected: detail.collected, anyReceived: expense.participants.some((p) => !p.isMe && p.receivedStatus === "received") };
    }
    case "loanAgreement":
    case "expense":
    case "income":
      return { kind: "plain", fresh, reference: fresh.deletedAt == null ? await findPeopleReference(deps, [fresh.id]) : null };
  }
}

// --- Execution: the module's own handlers only ---

export interface ExecuteDeps {
  uid: string;
  deleteTransactionWithLinkedEffects: (transaction: Transaction) => Promise<void>;
  revertPersonPayment: (person: Person, paymentId: string) => Promise<void>;
  reverseLoanPayment: (params: {
    loan: Loan;
    transactionId: string;
    paymentIds: string[];
    installmentIds: string[];
    overflowPaymentId: string | null;
    overflowInstallmentId: string | null;
    reversalIdempotencyKey: string;
  }) => Promise<{ alreadyReversed: boolean; scheduleRestorationSkippedReason: string | null }>;
  reverseEmiPayment: (emi: Emi, params: { original: { paymentIds: string[]; installmentIds: string[] } }) => Promise<{ alreadyReversed: boolean }>;
  cancelBillPayment: (params: { billId: string; paymentId: string }) => Promise<{ alreadyReversed: boolean }>;
}

export type ExecuteResult = { outcome: "undone" | "alreadyUndone"; warning: string | null };

export async function executeUndo(handler: UndoHandler, deps: ExecuteDeps, anchorId: string): Promise<ExecuteResult> {
  const transactionRepository = createTransactionRepository(deps.uid, createAccountRepository(deps.uid));
  try {
    switch (handler.kind) {
      case "deleteTransaction":
        await deps.deleteTransactionWithLinkedEffects(handler.transaction);
        return { outcome: "undone", warning: null };
      case "revertPersonPayment": {
        const person = await createPersonRepository(deps.uid).getByKey(handler.personId);
        if (person == null) throw new Error("This person no longer exists — nothing was changed.");
        await deps.revertPersonPayment(person, handler.paymentId);
        return { outcome: "undone", warning: null };
      }
      case "reverseLoanPayment": {
        const loan = await createLoanRepository(deps.uid).getByKey(handler.loanId);
        if (loan == null) throw new Error("This loan no longer exists — nothing was changed.");
        const result = await deps.reverseLoanPayment({ loan, transactionId: handler.transactionId, ...handler.refs, reversalIdempotencyKey: handler.reversalIdempotencyKey });
        return { outcome: result.alreadyReversed ? "alreadyUndone" : "undone", warning: result.scheduleRestorationSkippedReason };
      }
      case "reverseEmiPayment": {
        const emi = await createEmiRepository(deps.uid).getByKey(handler.emiId);
        if (emi == null) throw new Error("This EMI no longer exists — nothing was changed.");
        const result = await deps.reverseEmiPayment(emi, { original: handler.refs });
        return { outcome: result.alreadyReversed ? "alreadyUndone" : "undone", warning: null };
      }
      case "reverseBillPayment": {
        const result = await deps.cancelBillPayment({ billId: handler.billId, paymentId: handler.paymentId });
        return { outcome: result.alreadyReversed ? "alreadyUndone" : "undone", warning: null };
      }
    }
  } catch (error) {
    // A repeat / second-tab undo can surface as an error from a handler that refuses an already-reverted record
    // (e.g. People "already reverted"). Nothing was written either way; report it as already undone only when the
    // anchor is verifiably gone.
    const anchor = await transactionRepository.getByKey(anchorId).catch(() => null);
    if (anchor != null && anchor.deletedAt != null) return { outcome: "alreadyUndone", warning: null };
    throw error;
  }
}

/** Ids of every live person — the scope for the D3 reference check. */
export async function livePersonIds(uid: string): Promise<string[]> {
  return (await createPersonRepository(uid).getAll()).map((p) => p.id);
}
