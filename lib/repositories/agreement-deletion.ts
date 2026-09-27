/**
 * Permanent deletion of a Loan/EMI entered by mistake, with every financial effect it owns reversed — see
 * `lib/engines/agreement-deletion.ts` for the ownership rules. Replaces the old posture where a Loan whose
 * creation moved money (or that had any payment) could never be removed.
 *
 * Two phases, because a schedule can hold more installments than one Firestore transaction may write:
 *
 *  1. ONE `runTransaction` — every money effect, all or nothing. It re-reads the agreement, each owned
 *     Transaction, each affected Account and the linked Person inside the transaction (nothing is computed
 *     from UI state), then: reverses each still-active owned movement on its account once, removes the
 *     owned Transactions, reverses + removes owned People-ledger entries, deletes the Loan/EMI document, and
 *     stamps its PaymentSchedule `deletedAt` — the purge marker. From this commit on the agreement is gone
 *     from every derived figure (outstanding, dues, Net Worth, card credit, People, dashboard, reports).
 *     If it fails, nothing at all was written.
 *
 *  2. Batched removal of what is left and carries no money: payment records, installments, the Loan's
 *     re-plan / disbursement records, an EMI's payment breakdowns, and finally the schedule (the marker).
 *     Every step is a delete, so it is safe to repeat. If it's interrupted, the marker — a deleted schedule
 *     whose owner document no longer exists, an ownership fact, not a guess — lets
 *     `resumePendingAgreementPurges` (and any retry of the same delete) finish it.
 *
 * A retry after phase 1 committed finds the agreement gone and only resumes phase 2 — so nothing can ever be
 * reversed twice.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  where,
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type FirestoreDataConverter,
} from "firebase/firestore";
import {
  AgreementDeletionBlockedError,
  MAX_ATOMIC_DELETION_WRITES,
  atomicWriteCount,
  isOwnedTransaction,
  planAgreementDeletion,
  type AgreementKind,
} from "@/lib/engines/agreement-deletion";
import { FirestoreCollections as C } from "@/lib/firestore/collections";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { emiFromFirestore, emiToFirestore, type Emi } from "@/lib/models/emi";
import { expenseFromFirestore, expenseToFirestore, type Expense } from "@/lib/models/expense";
import {
  loanAdditionalDisbursementFromFirestore,
  loanAdditionalDisbursementToFirestore,
  type LoanAdditionalDisbursement,
} from "@/lib/models/loan-additional-disbursement";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import {
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type InstallmentPayment,
  type PaymentSchedule,
} from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore, type LedgerEntry, type Person } from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";

export { AgreementDeletionBlockedError } from "@/lib/engines/agreement-deletion";

export type AgreementDeletionStage = "checking" | "reversing" | "removing";

/**
 * The money step committed — the agreement is gone and its effects reversed — but removing its leftover
 * schedule records was interrupted. Not a success: retrying the same delete (or the next visit, via
 * `resumePendingAgreementPurges`) finishes it, and can never reverse anything twice.
 */
export class AgreementCleanupIncompleteError extends Error {
  constructor(readonly cause: unknown) {
    super("The agreement and its money effects were removed, but some schedule records weren't cleared yet. Try again to finish.");
    this.name = "AgreementCleanupIncompleteError";
  }
}

export interface AgreementDeletionResult {
  /** True when an earlier attempt had already removed the agreement — this call only finished the cleanup. */
  resumed: boolean;
  reversedTransactionCount: number;
  accountDeltas: Record<string, number>;
  personDelta: number;
  removedInstallmentCount: number;
  removedPaymentCount: number;
}

/** What deleting would do — for the confirmation dialog. Read-only. */
export interface AgreementDeletionImpact {
  installmentCount: number;
  paidInstallmentCount: number;
  paymentCount: number;
  /** Per account, the balance change deletion makes (positive = money goes back into it). */
  accountEffects: { accountId: string; accountName: string; delta: number }[];
  ledgerEntryCount: number;
  hasFinancialActivity: boolean;
}

/** Firestore `in` queries take at most 30 values. */
const IN_LIMIT = 30;
const CHUNK = 450;

/** The models' converter pairs, typed for `withConverter`. */
function converter<T>(from: (...a: never[]) => T, to: (v: T) => DocumentData): FirestoreDataConverter<T> {
  return { fromFirestore: from as unknown as FirestoreDataConverter<T>["fromFirestore"], toFirestore: to as unknown as FirestoreDataConverter<T>["toFirestore"] };
}

function refs(firestore: Firestore, uid: string) {
  const user = doc(firestore, C.users, uid);
  const transactions = collection(user, C.transactions).withConverter<Transaction>(converter(transactionFromFirestore, transactionToFirestore));
  const accounts = collection(user, C.accounts).withConverter<Account>(converter(accountFromFirestore, accountToFirestore));
  const people = collection(user, C.people).withConverter<Person>(converter(personFromFirestore, personToFirestore));
  const schedules = collection(user, C.paymentSchedules).withConverter<PaymentSchedule>(converter(paymentScheduleFromFirestore, paymentScheduleToFirestore));
  return {
    user,
    transactions,
    accounts,
    people,
    schedules,
    expenses: collection(user, C.expenses).withConverter<Expense>(converter(expenseFromFirestore, expenseToFirestore)),
    loan: (id: string) => doc(user, C.loans, id).withConverter<Loan>(converter(loanFromFirestore, loanToFirestore)),
    emi: (id: string) => doc(user, C.emis, id).withConverter<Emi>(converter(emiFromFirestore, emiToFirestore)),
    installments: (scheduleId: string) => collection(schedules, scheduleId, C.installments),
    payments: (scheduleId: string, installmentId: string) =>
      collection(schedules, scheduleId, C.installments, installmentId, C.payments).withConverter<InstallmentPayment>(converter(installmentPaymentFromFirestore, installmentPaymentToFirestore)),
    ledger: (personId: string) => collection(people, personId, C.ledger).withConverter<LedgerEntry>(converter(ledgerEntryFromFirestore, ledgerEntryToFirestore)),
  };
}

type Refs = ReturnType<typeof refs>;

/** Every record under the agreement that carries no money of its own — found by path, i.e. by ownership. */
async function readLeaves(r: Refs, kind: AgreementKind, agreementId: string, scheduleId: string) {
  const installments = await getDocs(r.installments(scheduleId));
  const paymentSnaps = await Promise.all(installments.docs.map((i) => getDocs(r.payments(scheduleId, i.id))));
  const payments = paymentSnaps.flatMap((s) => s.docs);
  const owner = kind === "loan" ? doc(r.user, C.loans, agreementId) : doc(r.user, C.emis, agreementId);
  const subcollections = kind === "loan" ? [C.reamortizationEvents, C.additionalDisbursements] : [C.reamortizationEvents, C.paymentBreakdowns];
  const subDocs = (await Promise.all(subcollections.map((name) => getDocs(collection(owner, name))))).flatMap((s) => s.docs);
  const disbursements =
    kind === "loan"
      ? (await getDocs(collection(owner, C.additionalDisbursements).withConverter<LoanAdditionalDisbursement>(converter(loanAdditionalDisbursementFromFirestore, loanAdditionalDisbursementToFirestore)))).docs.map((d) => d.data())
      : [];
  return { installments: installments.docs, payments, subDocs, disbursements };
}

/** Phase 2 — deletes only, leaves first, the schedule (the purge marker) last. */
async function removeLeaves(firestore: Firestore, r: Refs, kind: AgreementKind, agreementId: string, scheduleId: string) {
  const leaves = await readLeaves(r, kind, agreementId, scheduleId);
  const ordered: DocumentReference[] = [...leaves.payments.map((d) => d.ref), ...leaves.installments.map((d) => d.ref), ...leaves.subDocs.map((d) => d.ref)];
  for (let i = 0; i < ordered.length; i += CHUNK) {
    const batch = writeBatch(firestore);
    for (const ref of ordered.slice(i, i + CHUNK)) batch.delete(ref);
    await batch.commit();
  }
  const batch = writeBatch(firestore);
  batch.delete(doc(r.schedules, scheduleId));
  await batch.commit();
  return { removedInstallmentCount: leaves.installments.length, removedPaymentCount: leaves.payments.length };
}

/** Owned-candidate Transactions: the back-reference query plus every id the agreement's own records name. */
async function readCandidateTransactions(r: Refs, kind: AgreementKind, agreementId: string, referencedIds: string[]): Promise<Transaction[]> {
  const byBackRef = (await getDocs(query(r.transactions, where(kind === "loan" ? "loanId" : "emiId", "==", agreementId)))).docs.map((d) => d.data());
  const known = new Set(byBackRef.map((t) => t.id));
  const extra = await Promise.all(referencedIds.filter((id) => !known.has(id)).map((id) => getDoc(doc(r.transactions, id))));
  return [...byBackRef, ...extra.filter((s) => s.exists()).map((s) => s.data()!)];
}

async function readDependentExpenseTransactionIds(r: Refs, transactionIds: string[]): Promise<string[]> {
  const found: string[] = [];
  for (let i = 0; i < transactionIds.length; i += IN_LIMIT) {
    const snap = await getDocs(query(r.expenses, where("transactionId", "in", transactionIds.slice(i, i + IN_LIMIT))));
    for (const d of snap.docs) {
      const expense = d.data();
      if (expense.deletedAt == null) found.push(expense.transactionId);
    }
  }
  return found;
}

interface Gathered {
  agreement: Loan | Emi;
  scheduleId: string;
  purchaseTransactionId: string | null;
  personId: string | null;
  referencedTransactionIds: string[];
  transactions: Transaction[];
  ledgerEntries: LedgerEntry[];
  dependentExpenseTransactionIds: string[];
  installmentCount: number;
  paidInstallmentCount: number;
  paymentCount: number;
}

/** The People ledger a Loan's legacy generated entries live under — only personal Loans ever posted them. */
function ledgerPersonId(kind: AgreementKind, agreement: Loan | Emi): string | null {
  if (kind !== "loan") return null;
  const loan = agreement as Loan;
  return loan.category === "personal" ? (loan.personId ?? null) : null;
}

async function gather(r: Refs, kind: AgreementKind, agreement: Loan | Emi): Promise<Gathered> {
  const leaves = await readLeaves(r, kind, agreement.id, agreement.scheduleId);
  const paymentDocs = leaves.payments.map((d) => d.data());
  const referencedTransactionIds = Array.from(
    new Set([...paymentDocs.map((p) => p.transactionId), ...leaves.disbursements.map((d) => d.transactionId)].filter((id): id is string => id != null)),
  );
  const purchaseTransactionId = agreement.purchaseTransactionId ?? null;
  const transactions = await readCandidateTransactions(r, kind, agreement.id, referencedTransactionIds);
  const ownership = { kind, agreementId: agreement.id, purchaseTransactionId, referencedTransactionIds };
  const ownedIds = transactions.filter((t) => isOwnedTransaction(t, ownership)).map((t) => t.id);
  const personId = ledgerPersonId(kind, agreement);
  const ledgerEntries = personId ? (await getDocs(query(r.ledger(personId), where("transactionRef", "==", agreement.id)))).docs.map((d) => d.data()) : [];
  return {
    agreement,
    scheduleId: agreement.scheduleId,
    purchaseTransactionId,
    personId,
    referencedTransactionIds,
    transactions,
    ledgerEntries,
    dependentExpenseTransactionIds: await readDependentExpenseTransactionIds(r, ownedIds),
    installmentCount: leaves.installments.length,
    paidInstallmentCount: leaves.installments.filter((d) => ((d.data() as { amountPaid?: number }).amountPaid ?? 0) > 0).length,
    paymentCount: paymentDocs.filter((p) => p.deletedAt == null).length,
  };
}

async function readAgreement(r: Refs, kind: AgreementKind, id: string): Promise<Loan | Emi | null> {
  const snap = kind === "loan" ? await getDoc(r.loan(id)) : await getDoc(r.emi(id));
  return snap.exists() ? snap.data() : null;
}

/** Read-only: what permanently deleting this agreement would change. */
export async function previewAgreementDeletion(firestore: Firestore, uid: string, kind: AgreementKind, agreementId: string): Promise<AgreementDeletionImpact | null> {
  const r = refs(firestore, uid);
  const agreement = await readAgreement(r, kind, agreementId);
  if (agreement == null) return null;
  const g = await gather(r, kind, agreement);
  let plan;
  try {
    plan = planAgreementDeletion({ kind, agreementId, ...g });
  } catch {
    plan = null;
  }
  const accountIds = plan ? [...plan.accountDeltas.keys()] : [];
  const accountSnaps = await Promise.all(accountIds.map((id) => getDoc(doc(r.accounts, id))));
  return {
    installmentCount: g.installmentCount,
    paidInstallmentCount: g.paidInstallmentCount,
    paymentCount: g.paymentCount,
    accountEffects: accountIds.map((id, i) => ({ accountId: id, accountName: accountSnaps[i].data()?.name ?? "Account", delta: plan!.accountDeltas.get(id)! })),
    ledgerEntryCount: plan?.ledgerEntryIds.length ?? 0,
    hasFinancialActivity: g.paymentCount > 0 || g.paidInstallmentCount > 0 || (plan?.ownedTransactions.length ?? 0) > 0 || (plan?.ledgerEntryIds.length ?? 0) > 0,
  };
}

/**
 * Permanently deletes a Loan/EMI and reverses every financial effect it owns. Throws
 * `AgreementDeletionBlockedError` (nothing written) when it can't be done safely; any other error before
 * phase 1 commits also leaves everything untouched.
 */
export async function permanentlyDeleteAgreement(
  firestore: Firestore,
  uid: string,
  kind: AgreementKind,
  agreementId: string,
  opts: { onStage?: (stage: AgreementDeletionStage) => void } = {},
): Promise<AgreementDeletionResult> {
  const r = refs(firestore, uid);
  opts.onStage?.("checking");
  const agreement = await readAgreement(r, kind, agreementId);
  if (agreement == null) {
    // Phase 1 already committed on an earlier attempt — only the cleanup can be left.
    const pending = await pendingScheduleFor(r, kind, agreementId);
    opts.onStage?.("removing");
    let removed = { removedInstallmentCount: 0, removedPaymentCount: 0 };
    try {
      if (pending) removed = await removeLeaves(firestore, r, kind, agreementId, pending);
    } catch (e) {
      throw new AgreementCleanupIncompleteError(e);
    }
    return { resumed: true, reversedTransactionCount: 0, accountDeltas: {}, personDelta: 0, ...removed };
  }

  const g = await gather(r, kind, agreement);
  const preview = planAgreementDeletion({ kind, agreementId, ...g }); // throws AgreementDeletionBlockedError
  if (atomicWriteCount(preview) > MAX_ATOMIC_DELETION_WRITES) {
    throw new AgreementDeletionBlockedError(
      `This ${kind === "loan" ? "loan" : "EMI"} has too many linked records to reverse in one safe step (${atomicWriteCount(preview)}). Nothing was changed.`,
    );
  }

  opts.onStage?.("reversing");
  const ownedIds = preview.ownedTransactions.map((t) => t.id);
  const committed = await runTransaction(firestore, async (tx) => {
    // --- All reads first — authoritative, current values only. ---
    const agreementRef: DocumentReference = kind === "loan" ? r.loan(agreementId) : r.emi(agreementId);
    const fresh = await tx.get(agreementRef);
    if (!fresh.exists()) return null; // a concurrent attempt got there first — nothing to reverse twice
    const transactions: Transaction[] = [];
    for (const id of ownedIds) {
      const snap = await tx.get(doc(r.transactions, id));
      if (snap.exists()) transactions.push(snap.data());
    }
    const ledgerEntries: LedgerEntry[] = [];
    for (const id of preview.ledgerEntryIds) {
      const snap = await tx.get(doc(r.ledger(g.personId!), id));
      if (snap.exists()) ledgerEntries.push(snap.data());
    }
    const plan = planAgreementDeletion({
      kind,
      agreementId,
      purchaseTransactionId: g.purchaseTransactionId,
      referencedTransactionIds: g.referencedTransactionIds,
      transactions,
      ledgerEntries,
      dependentExpenseTransactionIds: g.dependentExpenseTransactionIds,
    });
    const accounts = new Map<string, Account>();
    for (const id of plan.accountDeltas.keys()) {
      const snap = await tx.get(doc(r.accounts, id));
      // An account the user already deleted took its balance with it — nothing left to correct there.
      if (snap.exists()) accounts.set(id, snap.data());
    }
    const personSnap = g.personId && plan.personDelta !== 0 ? await tx.get(doc(r.people, g.personId)) : null;
    const scheduleSnap = await tx.get(doc(r.schedules, g.scheduleId));

    // --- Then all writes. ---
    const now = new Date();
    for (const [id, delta] of plan.accountDeltas) {
      const account = accounts.get(id);
      if (!account) continue;
      const balance = Math.round((account.currentBalance + delta) * 100) / 100;
      tx.set(doc(r.accounts, id), { ...recordEdit(account, "currentBalance", String(account.currentBalance), String(balance)), currentBalance: balance });
    }
    for (const t of plan.ownedTransactions) tx.delete(doc(r.transactions, t.id));
    if (personSnap?.exists()) {
      const person = personSnap.data();
      const balance = Math.round((person.currentBalance + plan.personDelta) * 100) / 100;
      tx.set(doc(r.people, person.id), { ...recordEdit(person, "currentBalance", String(person.currentBalance), String(balance)), currentBalance: balance });
    }
    for (const id of plan.ledgerEntryIds) tx.delete(doc(r.ledger(g.personId!), id));
    tx.delete(agreementRef);
    // The purge marker: this schedule's owner is gone — phase 2 (or a resume) removes what's left.
    if (scheduleSnap.exists()) tx.set(doc(r.schedules, g.scheduleId), { ...scheduleSnap.data(), deletedAt: now });
    return plan;
  });

  opts.onStage?.("removing");
  let removed;
  try {
    removed = await removeLeaves(firestore, r, kind, agreementId, g.scheduleId);
  } catch (e) {
    throw new AgreementCleanupIncompleteError(e);
  }
  return {
    resumed: committed == null,
    reversedTransactionCount: committed?.ownedTransactions.filter((t) => t.deletedAt == null).length ?? 0,
    accountDeltas: Object.fromEntries(committed?.accountDeltas ?? []),
    personDelta: committed?.personDelta ?? 0,
    ...removed,
  };
}

/** The schedule id of an agreement whose phase 1 committed but whose cleanup didn't finish, if any. */
async function pendingScheduleFor(r: Refs, kind: AgreementKind, agreementId: string): Promise<string | null> {
  const snap = await getDocs(query(r.schedules, where("ownerId", "==", agreementId)));
  const marker = snap.docs.map((d) => d.data()).find((s) => s.ownerType === kind && s.deletedAt != null);
  return marker?.id ?? null;
}

/**
 * Finishes any permanent deletion that was interrupted after its money step committed. A marker is a
 * deleted Loan/EMI schedule whose owner document no longer exists — nothing else ever produces that, and a
 * schedule whose owner still exists is never touched.
 */
export async function resumePendingAgreementPurges(firestore: Firestore, uid: string): Promise<number> {
  const r = refs(firestore, uid);
  const snap = await getDocs(query(r.schedules, where("deletedAt", "!=", null)));
  let resumed = 0;
  for (const schedule of snap.docs.map((d) => d.data())) {
    if (schedule.ownerType !== "loan" && schedule.ownerType !== "emi") continue;
    if ((await readAgreement(r, schedule.ownerType, schedule.ownerId)) != null) continue;
    await removeLeaves(firestore, r, schedule.ownerType, schedule.ownerId, schedule.id);
    resumed++;
  }
  return resumed;
}
