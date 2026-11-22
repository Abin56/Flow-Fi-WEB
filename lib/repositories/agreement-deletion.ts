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
import { deferralDocId } from "@/lib/models/person-payment-deferral";
import { followUpDocId } from "@/lib/models/person-follow-up";
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
  /** People's own repayments (whole payments) that deleting also reverses — their cash legs and ledger entries. */
  personRepaymentCount: number;
  /** Transactions this agreement owns (creation money, payments, card charges) — removed, never refunded. */
  transactionCount: number;
  /** Why the delete cannot run right now (shown instead of the confirmation); null when it can. */
  blockedReason: string | null;
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
  /** The user's own expenses this agreement's "already paid earlier" payments were LINKED to (not owned: never deleted). */
  linkedExpenseTransactionIds: string[];
  transactions: Transaction[];
  ledgerEntries: LedgerEntry[];
  dependentExpenseTransactionIds: string[];
  livePersonSettlementCount: number;
  /** Every installment id of the agreement's schedule — what a person's repayment's `obligationRef` points at. */
  installmentIds: string[];
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

/** Live People-ledger entries that settle one of this agreement's installments (`emi-inst:` / `loan-inst:` refs). */
/** The people whose repayments can settle this agreement's installments (shares, beneficiary, payer). */
function participantPersonIds(agreement: Loan | Emi): string[] {
  const a = agreement as { ownershipShares?: { personId: string | null }[] | null; beneficiaryPersonId?: string | null; payerPersonId?: string | null };
  return [...new Set([...(a.ownershipShares ?? []).map((s) => s.personId), a.beneficiaryPersonId, a.payerPersonId].filter((id): id is string => !!id))];
}

async function countLivePersonSettlements(r: Refs, agreement: Loan | Emi, installmentIds: ReadonlySet<string>): Promise<number> {
  const personIds = participantPersonIds(agreement);
  let count = 0;
  for (const personId of personIds) {
    const snap = await getDocs(query(r.ledger(personId), where("sourceKind", "in", ["emiInstallment", "loanInstallment"])));
    for (const d of snap.docs) {
      const e = d.data();
      const ref = e.obligationRef ?? "";
      if (e.deletedAt == null && installmentIds.has(ref.slice(ref.indexOf(":") + 1))) count++;
    }
  }
  return count;
}

/** One person's repayment (a whole People payment) and the records it created — what is purged once it is reverted. */
interface PersonRepayment {
  personId: string;
  paymentId: string;
  entryIds: string[];
  transactionIds: string[];
}

async function deleteInChunks(firestore: Firestore, refsToDelete: DocumentReference[]) {
  for (let i = 0; i < refsToDelete.length; i += CHUNK) {
    const batch = writeBatch(firestore);
    for (const ref of refsToDelete.slice(i, i + CHUNK)) batch.delete(ref);
    await batch.commit();
  }
}

/**
 * People's "Revert payment" soft-deletes what a repayment created (ledger entries, the cash-leg / income Transactions). For a
 * deleted agreement those would linger as "reversed" rows in People and Activity, so once the revert committed they are removed
 * for good. Only records already soft-deleted by that revert are touched — a live record is never deleted here.
 */
async function purgeRevertedRepayment(firestore: Firestore, r: Refs, rep: PersonRepayment) {
  const doomed: DocumentReference[] = [];
  for (const id of rep.entryIds) {
    const ref = doc(r.ledger(rep.personId), id);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().deletedAt != null) doomed.push(ref);
  }
  for (const id of new Set(rep.transactionIds)) {
    const ref = doc(r.transactions, id);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().deletedAt != null) doomed.push(ref);
  }
  await deleteInChunks(firestore, doomed);
}

/** Postponements and reminders are keyed by this agreement's installments (`emi-inst:` / `loan-inst:`); with it gone they mean nothing. */
async function removePeopleTracking(firestore: Firestore, r: Refs, kind: AgreementKind, agreement: Loan | Emi, installmentIds: readonly string[]) {
  const prefix = kind === "loan" ? "loan-inst:" : "emi-inst:";
  const doomed: DocumentReference[] = [];
  for (const personId of participantPersonIds(agreement)) {
    for (const id of installmentIds) {
      doomed.push(doc(r.people, personId, "paymentDeferrals", deferralDocId(`${prefix}${id}`)));
      doomed.push(doc(r.people, personId, "followUps", followUpDocId(`${prefix}${id}`)));
    }
  }
  await deleteInChunks(firestore, doomed);
}

/**
 * The people's live repayments recorded against this agreement's installments, as whole payments (the unit People's own
 * "Revert payment" undoes). `blocked` says why they can't be reverted automatically: a repayment with no payment id, or one
 * that ALSO settles something that isn't this agreement's installment (reverting it would change unrelated items).
 */
async function findPersonRepayments(r: Refs, agreement: Loan | Emi, installmentIds: ReadonlySet<string>): Promise<{ payments: PersonRepayment[]; blocked: string | null }> {
  const found = new Map<string, PersonRepayment>();
  let blocked: string | null = null;
  const isMine = (e: LedgerEntry) => {
    const ref = e.obligationRef ?? "";
    return (e.sourceKind === "emiInstallment" || e.sourceKind === "loanInstallment") && installmentIds.has(ref.slice(ref.indexOf(":") + 1));
  };
  for (const personId of participantPersonIds(agreement)) {
    const snap = await getDocs(query(r.ledger(personId), where("sourceKind", "in", ["emiInstallment", "loanInstallment"])));
    for (const d of snap.docs) {
      const e = d.data();
      if (e.deletedAt != null || !isMine(e)) continue;
      if (!e.paymentId) blocked = "A repayment recorded against this agreement can't be reversed automatically. Revert it in People first, then delete.";
      else found.set(`${personId}|${e.paymentId}`, { personId, paymentId: e.paymentId, entryIds: [], transactionIds: [] });
    }
  }
  for (const rep of found.values()) {
    const { personId, paymentId } = rep;
    const all = await getDocs(query(r.ledger(personId), where("paymentId", "==", paymentId)));
    for (const d of all.docs) {
      const e = d.data();
      rep.entryIds.push(e.id);
      for (const t of [e.transactionRef, e.incomeTransactionRef]) if (t) rep.transactionIds.push(t);
    }
    if (all.docs.some((d) => d.data().deletedAt == null && !isMine(d.data()))) {
      blocked = "A person's repayment here also settles other items (another EMI/loan or an advance). Revert that payment in People first, then delete.";
    }
  }
  return { payments: [...found.values()], blocked };
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
    linkedExpenseTransactionIds: Array.from(new Set(paymentDocs.map((p) => p.linkedTransactionId).filter((id): id is string => !!id))),
    transactions,
    ledgerEntries,
    dependentExpenseTransactionIds: await readDependentExpenseTransactionIds(r, ownedIds),
    livePersonSettlementCount: await countLivePersonSettlements(r, agreement, new Set(leaves.installments.map((i) => i.id))),
    installmentIds: leaves.installments.map((i) => i.id),
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
  // People's repayments are reversed as part of the delete (when they belong only to this agreement), so they don't block it.
  const repayments = g.livePersonSettlementCount > 0 ? await findPersonRepayments(r, agreement, new Set(g.installmentIds)) : { payments: [], blocked: null };
  const cascade = g.livePersonSettlementCount > 0 && repayments.blocked == null;
  let plan;
  let blockedReason: string | null = null;
  try {
    plan = planAgreementDeletion({ kind, agreementId, ...g, livePersonSettlementCount: cascade ? 0 : g.livePersonSettlementCount });
  } catch (e) {
    plan = null;
    blockedReason = e instanceof AgreementDeletionBlockedError ? e.message : "This can't be deleted safely right now.";
  }
  if (blockedReason == null && repayments.blocked != null) blockedReason = repayments.blocked;
  const accountIds = plan ? [...plan.accountDeltas.keys()] : [];
  const accountSnaps = await Promise.all(accountIds.map((id) => getDoc(doc(r.accounts, id))));
  return {
    installmentCount: g.installmentCount,
    paidInstallmentCount: g.paidInstallmentCount,
    paymentCount: g.paymentCount,
    accountEffects: accountIds.map((id, i) => ({ accountId: id, accountName: accountSnaps[i].data()?.name ?? "Account", delta: plan!.accountDeltas.get(id)! })),
    ledgerEntryCount: plan?.ledgerEntryIds.length ?? 0,
    personRepaymentCount: cascade ? repayments.payments.length : 0,
    transactionCount: plan?.ownedTransactions.length ?? 0,
    blockedReason,
    hasFinancialActivity: g.paymentCount > 0 || g.paidInstallmentCount > 0 || (plan?.ownedTransactions.length ?? 0) > 0 || (plan?.ledgerEntryIds.length ?? 0) > 0 || (cascade && repayments.payments.length > 0),
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
  opts: {
    onStage?: (stage: AgreementDeletionStage) => void;
    /** Reverts one whole People payment (`PersonPaymentRepository.revertPayment`). When given, the people's repayments against this agreement are reversed first instead of blocking the delete. */
    revertPersonPayment?: (person: Person, paymentId: string) => Promise<void>;
  } = {},
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

  let g = await gather(r, kind, agreement);
  if (opts.revertPersonPayment && g.livePersonSettlementCount > 0) {
    const found = await findPersonRepayments(r, agreement, new Set(g.installmentIds));
    if (found.blocked) throw new AgreementDeletionBlockedError(`${found.blocked} Nothing was changed.`);
    opts.onStage?.("reversing");
    // Each repayment is one atomic, idempotent People revert (cash leg, ledger entries, person balance). If a later step
    // fails, what was reverted stays reverted and the agreement is untouched — retrying simply continues.
    for (const rep of found.payments) {
      const snap = await getDoc(doc(r.people, rep.personId));
      if (!snap.exists()) continue;
      await opts.revertPersonPayment(snap.data(), rep.paymentId);
      await purgeRevertedRepayment(firestore, r, rep);
    }
    g = await gather(r, kind, agreement);
  }
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
    // The repayment guard is re-evaluated HERE, against current documents, not only before the transaction started: a
    // person's repayment recorded since then (another tab/device) must still stop the delete. (A query can't run inside a
    // Firestore transaction, so this is a fresh read immediately before the writes — the window is milliseconds, not the
    // whole gather. Closing it completely needs a server-side check; see docs/backend-server-side-protection.md.)
    //
    // The participants' own documents are READ through the transaction first. Every repayment writes its person's balance,
    // so one that commits after this point makes THIS transaction conflict and retry — and the retry's recount then sees it.
    // (Without these reads the recount is a plain query: a repayment landing between it and the commit would go unnoticed.)
    for (const personId of participantPersonIds(g.agreement)) await tx.get(doc(r.people, personId));
    const liveSettlements = await countLivePersonSettlements(r, g.agreement, new Set(g.installmentIds));
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
      livePersonSettlementCount: liveSettlements,
    });
    const accounts = new Map<string, Account>();
    for (const id of plan.accountDeltas.keys()) {
      const snap = await tx.get(doc(r.accounts, id));
      // An account the user already deleted took its balance with it — nothing left to correct there.
      if (snap.exists()) accounts.set(id, snap.data());
    }
    // Expenses linked to this agreement's payments: they stay (their money was counted once, on their own account) but
    // must stop pointing at an agreement that is about to stop existing, or they would stay locked to it for good.
    const linkedToRelease: Transaction[] = [];
    for (const id of g.linkedExpenseTransactionIds) {
      if (ownedIds.includes(id)) continue;
      const snap = await tx.get(doc(r.transactions, id));
      if (snap.exists() && snap.data().earlierPaymentLink?.ownerId === agreementId) linkedToRelease.push(snap.data());
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
    for (const t of linkedToRelease) tx.set(doc(r.transactions, t.id), { ...t, earlierPaymentLink: null });
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
    // Best effort: a failure here only leaves harmless postponement/reminder records behind.
    if (committed != null) await removePeopleTracking(firestore, r, kind, g.agreement, g.installmentIds).catch(() => undefined);
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
