/** Reset one agreement's recorded activity in a single owner-scoped Firestore transaction. */
import {
  collection, doc, getDocFromServer, getDocsFromServer, query, runTransaction, where,
  type CollectionReference, type DocumentData, type DocumentReference, type DocumentSnapshot,
  type Firestore, type QueryDocumentSnapshot,
} from "firebase/firestore";
import { MAX_ATOMIC_DELETION_WRITES, type AgreementKind } from "@/lib/engines/agreement-deletion";
import { AgreementResetBlockedError, planLoanScheduleReset } from "@/lib/engines/agreement-recording-reset";
import { isPaidDirectlyEntry } from "@/lib/engines/historical-reimbursement";
import { isOriginationTransactionId } from "@/lib/engines/loan-origination";
import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import { round2 } from "@/lib/engines/person-payment";
import { FirestoreCollections as C } from "@/lib/firestore/collections";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore } from "@/lib/models/loan";
import { loanAdditionalDisbursementFromFirestore } from "@/lib/models/loan-additional-disbursement";
import { loanReamortizationEventFromFirestore } from "@/lib/models/loan-reamortization-event";
import { installmentFromFirestore, installmentPaymentFromFirestore, paymentScheduleFromFirestore } from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, personFromFirestore, personToFirestore, signedAmount } from "@/lib/models/person";
import { transactionFromFirestore, type Transaction } from "@/lib/models/transaction";

export { AgreementResetBlockedError } from "@/lib/engines/agreement-recording-reset";

export class AgreementResetChangedError extends Error {
  constructor() {
    super("The linked records changed since you reviewed them. Refresh the preview to continue.");
    this.name = "AgreementResetChangedError";
  }
}

export interface AgreementResetPreview {
  revision: string;
  installmentCount: number;
  paymentCount: number;
  transactionCount: number;
  disbursementCount: number;
  lenderChargeCount: number;
  receiptCount: number;
  releasedReceiptCount: number;
  releasedExpenseCount: number;
  advanceCount: number;
  trackingCount: number;
  accountEffects: { accountName: string; delta: number }[];
  personEffects: { personName: string; delta: number }[];
  hasRecordings: boolean;
}

type Row = QueryDocumentSnapshot<DocumentData>;
type Mutation = { ref: DocumentReference; patch: DocumentData | null };
const active = (row: Row) => row.get("deletedAt") == null;
const stringIds = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];

function requireRow(snap: DocumentSnapshot, label: string): Row {
  if (!snap.exists()) throw new AgreementResetBlockedError(`${label} could not be found.`);
  return snap;
}

function rowsByPath<T extends DocumentSnapshot>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.ref.path, row])).values()];
}

async function lookup(ref: CollectionReference, field: string, values: unknown[]): Promise<Row[]> {
  const ids = stringIds(values);
  const queries = [];
  for (let offset = 0; offset < ids.length; offset += 30) {
    queries.push(getDocsFromServer(query(ref, where(field, "in", ids.slice(offset, offset + 30)))));
  }
  return (await Promise.all(queries)).flatMap((snapshot) => snapshot.docs);
}

/** Used both for the reviewed preview and for comparing server-query results with transactional reads. */
function version(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function reviewedDocuments(rows: DocumentSnapshot[]) {
  const byPath = new Map<string, { row: DocumentSnapshot; version: string }>();
  for (const row of rows) {
    const next = version(row.data());
    const previous = byPath.get(row.ref.path);
    if (previous && previous.version !== next) throw new AgreementResetChangedError();
    if (!previous) byPath.set(row.ref.path, { row, version: next });
  }
  return [...byPath].sort(([a], [b]) => a.localeCompare(b));
}

function addDelta(deltas: Map<string, number>, id: string, amount: number) {
  deltas.set(id, round2((deltas.get(id) ?? 0) + amount));
}

function requireSafeTransaction(t: Transaction, kind: AgreementKind, id: string) {
  if ((t.loanId != null && (kind !== "loan" || t.loanId !== id)) || (t.emiId != null && (kind !== "emi" || t.emiId !== id)) || t.transferId != null || t.transferFeeForId != null || t.billPaymentId != null || t.fundedByPersonId != null || t.earlierPaymentLink != null || !Number.isFinite(t.amount) || t.amount <= 0) {
    throw new AgreementResetBlockedError("A linked transaction also belongs to another financial record. Resolve that link before resetting.");
  }
}

async function prepare(db: Firestore, uid: string, kind: AgreementKind, id: string) {
  const user = doc(db, C.users, uid);
  const loans = collection(user, C.loans);
  const emis = collection(user, C.emis);
  const owner = requireRow(await getDocFromServer(doc(kind === "loan" ? loans : emis, id)), "The agreement");
  if (!active(owner)) throw new AgreementResetBlockedError("Restore the agreement before resetting its recordings.");
  const scheduleId: unknown = owner.get("scheduleId");
  if (typeof scheduleId !== "string" || !scheduleId || scheduleId.includes("/")) throw new AgreementResetBlockedError("The agreement has no valid payment schedule.");
  const schedule = requireRow(await getDocFromServer(doc(user, C.paymentSchedules, scheduleId)), "The payment schedule");
  if (!active(schedule) || schedule.get("ownerId") !== id || schedule.get("ownerType") !== kind) {
    throw new AgreementResetBlockedError("The payment schedule does not belong to this agreement.");
  }

  const transactions = collection(user, C.transactions);
  const [installmentsSnap, eventsSnap, disbursementsSnap, breakdownsSnap, chargesSnap, peopleSnap, backRefs, expenseLinks] = await Promise.all([
    getDocsFromServer(collection(schedule.ref, C.installments)),
    getDocsFromServer(collection(owner.ref, C.reamortizationEvents)),
    kind === "loan" ? getDocsFromServer(collection(owner.ref, C.additionalDisbursements)) : null,
    kind === "emi" ? getDocsFromServer(collection(owner.ref, C.paymentBreakdowns)) : null,
    getDocsFromServer(collection(owner.ref, C.lenderCharges)),
    getDocsFromServer(collection(user, C.people)),
    lookup(transactions, kind === "loan" ? "loanId" : "emiId", [id]),
    lookup(transactions, "earlierPaymentLink.scheduleId", [scheduleId]),
  ]);
  const installments = installmentsSnap.docs;
  const payments = (await Promise.all(installments.map((row) => getDocsFromServer(collection(row.ref, C.payments))))).flatMap((snapshot) => snapshot.docs);
  const events = eventsSnap.docs;
  const disbursements = disbursementsSnap?.docs ?? [];
  const breakdowns = breakdownsSnap?.docs ?? [];
  const charges = chargesSnap.docs;
  const people = peopleSnap.docs;
  const installmentIds = new Set(installments.map((row) => row.id));
  const paymentIds = new Set(payments.map((row) => row.id));
  const prefix = kind === "loan" ? "loan-inst:" : "emi-inst:";
  const obligations = new Set(installments.map((row) => `${prefix}${row.id}`));
  const imports = new Set(stringIds(payments.map((row) => row.get("linkedTransactionId"))));
  const disbursementTxIds = new Set(stringIds(disbursements.map((row) => row.get("transactionId"))));
  const settlementIds = new Map<string, string>();
  const liveSettlementIds = new Set<string>();
  for (const charge of charges) {
    const settlements = charge.get("settlements") as { transactionId?: string; reversedAt?: unknown }[] | undefined;
    for (const settlement of settlements ?? []) {
      if (!settlement.transactionId || settlementIds.has(settlement.transactionId)) throw new AgreementResetBlockedError("A lender charge's settlement cannot be verified.");
      settlementIds.set(settlement.transactionId, charge.id);
      if (active(charge) && charge.get("reversedAt") == null && settlement.reversedAt == null) liveSettlementIds.add(settlement.transactionId);
    }
  }

  const now = new Date();
  const observed: DocumentSnapshot[] = [owner, schedule, ...installments, ...payments, ...events, ...disbursements, ...breakdowns, ...charges, ...people];
  const changes = new Map<string, Mutation>();
  const remove = (row: Row) => changes.set(row.ref.path, { ref: row.ref, patch: null });
  const update = (row: Row, patch: DocumentData) => {
    const existing = changes.get(row.ref.path);
    if (existing?.patch === null) throw new AgreementResetBlockedError("The linked records give conflicting ownership information.");
    changes.set(row.ref.path, { ref: row.ref, patch: { ...existing?.patch, ...patch } });
  };

  if (paymentIds.size !== payments.length || installments.some((row) => (row.get("ownerId") != null && row.get("ownerId") !== id) || (row.get("ownerType") != null && row.get("ownerType") !== kind) || (row.get("scheduleId") != null && row.get("scheduleId") !== scheduleId)) ||
    payments.some((row) => (row.get("ownerId") != null && row.get("ownerId") !== id) || (row.get("ownerType") != null && row.get("ownerType") !== kind) || (row.get("scheduleId") != null && row.get("scheduleId") !== scheduleId) || (row.get("installmentId") != null && row.get("installmentId") !== row.ref.parent.parent?.id))) {
    throw new AgreementResetBlockedError("An installment or payment is linked to a different agreement. Review the schedule first.");
  }
  if (kind === "emi" && events.some((row) => !row.get("reversed") && row.get("triggerType") != null && row.get("triggerType") !== "manualEditTerms")) {
    throw new AgreementResetBlockedError("This EMI has an adjustment whose original schedule cannot be verified. Review its terms first.");
  }

  const plan = kind === "loan" ? planLoanScheduleReset({
    loan: loanFromFirestore(owner),
    schedule: paymentScheduleFromFirestore(schedule),
    installments: installments.map((row) => installmentFromFirestore(row)),
    payments: payments.map((row) => installmentPaymentFromFirestore(row)),
    disbursements: disbursements.map((row) => loanAdditionalDisbursementFromFirestore(row)),
    events: events.map((row) => loanReamortizationEventFromFirestore(row)),
    now,
  }) : null;
  if (plan) {
    if (plan.loanAmount !== owner.get("loanAmount")) update(owner, { loanAmount: plan.loanAmount });
    if (plan.installmentDates.size > 0) {
      update(owner, { installmentCount: plan.installmentCount });
      update(schedule, { installmentCount: plan.installmentCount, totalAmount: plan.totalAmount });
    }
    for (const event of events) if (plan.financialEventIds.has(event.id)) remove(event);
  }
  const paidInstallments = installments.filter((row) => Number(row.get("amountPaid")) > 0);
  for (const row of paidInstallments) update(row, { amountPaid: 0 });
  for (const row of installments) {
    if (plan?.installmentDates.has(row.id)) update(row, { deletedAt: plan.installmentDates.get(row.id) });
  }
  for (const row of [...payments, ...disbursements, ...breakdowns, ...charges]) remove(row);

  const personDeltas = new Map<string, number>();
  const receipts = new Map<string, { personId: string; signedAmount: number }>();
  const retainedReceiptTxIds = new Set<string>();
  const receiptEntryPaths = new Set<string>();
  let receiptCount = 0;
  let releasedReceiptCount = 0;
  let advanceCount = 0;
  let trackingCount = 0;

  const perPerson = await Promise.all(people.map(async (person) => {
    const ledger = collection(person.ref, C.ledger);
    const keyList = [...obligations];
    const [settlements, legacy, applications, deferrals, reminders, advanceSources] = await Promise.all([
      lookup(ledger, "obligationRef", keyList),
      kind === "loan" && owner.get("category") === "personal" && owner.get("personId") === person.id ? lookup(ledger, "transactionRef", [id]) : [],
      lookup(collection(person.ref, C.advanceApplications), "obligationKey", keyList),
      lookup(collection(person.ref, C.paymentDeferrals), "obligationKey", keyList),
      lookup(collection(person.ref, C.followUps), "obligationKey", keyList),
      keyList.length ? lookup(ledger, "sourceKind", ["advance"]) : [],
    ]);
    const groups = stringIds(settlements.filter(active).map((row) => row.get("paymentId")));
    const [groupRows, purposeFunds] = await Promise.all([
      lookup(ledger, "paymentId", groups),
      lookup(collection(person.ref, C.purposeFunds), "paymentId", groups),
    ]);
    return { person, settlements, legacy, applications, tracking: [...deferrals, ...reminders], advanceSources, groups, groupRows, purposeFunds };
  }));

  for (const { person, settlements, legacy, applications, tracking, advanceSources, groups, groupRows, purposeFunds } of perPerson) {
    // Applying an advance writes a lock timestamp on its source entry, including when there was no prior application.
    observed.push(...settlements, ...legacy, ...applications, ...tracking, ...advanceSources.filter(active), ...groupRows, ...purposeFunds);
    for (const row of [...applications, ...tracking]) remove(row);
    advanceCount += applications.length;
    trackingCount += tracking.length;

    function removeReceiptEntry(row: Row) {
      remove(row);
      receiptEntryPaths.add(row.ref.path);
      if (!active(row)) return;
      const entry = ledgerEntryFromFirestore(row);
      if ((entry.type !== "receivedBack" && entry.type !== "repaid") || entry.personId !== person.id || entry.parentEntryId != null || entry.installmentPaymentRef != null || entry.incomeTransactionRef != null || !Number.isFinite(entry.amount) || entry.amount <= 0) {
        throw new AgreementResetBlockedError("A People receipt has additional effects. Review it in People before resetting.");
      }
      addDelta(personDeltas, person.id, -signedAmount(entry));
    }

    // Legacy personal-loan entries use transactionRef = loan id for the principal and repayments alike.
    for (const row of legacy.filter((entry) => ["receivedBack", "repaid"].includes(entry.get("type")))) {
      if (active(row) && row.get("paymentId") != null) throw new AgreementResetBlockedError("A legacy People repayment also belongs to a separate payment group. Review it in People first.");
      removeReceiptEntry(row);
      if (active(row)) receiptCount++;
    }

    for (const row of settlements.filter((item) => !active(item) || item.get("paymentId") == null)) {
      if (active(row) && row.get("transactionRef") != null) throw new AgreementResetBlockedError("A linked People receipt has no payment group. Review it in People before resetting.");
      removeReceiptEntry(row);
      if (active(row)) receiptCount++;
    }

    for (const paymentId of groups) {
      const group = groupRows.filter((row) => active(row) && row.get("paymentId") === paymentId);
      const owned = group.filter((row) => obligations.has(row.get("obligationRef")));
      if (owned.length === 0) throw new AgreementResetChangedError();
      const hasOtherAllocations = owned.length !== group.length || purposeFunds.some((row) => active(row) && row.get("paymentId") === paymentId);
      if (hasOtherAllocations) {
        // A mixed receipt is still real cash. Release this agreement's allocation to the person's overall balance.
        for (const row of owned) {
          const entry = ledgerEntryFromFirestore(row);
          if ((entry.type !== "receivedBack" && entry.type !== "repaid") || entry.personId !== person.id || !entry.transactionRef || entry.parentEntryId != null || entry.installmentPaymentRef != null || entry.incomeTransactionRef != null || isPaidDirectlyEntry(entry)) {
            throw new AgreementResetBlockedError("A People payment also settles another item and cannot be separated safely. Review it in People first.");
          }
          update(row, { obligationRef: null, sourceKind: "manual", lastEditedAt: now });
          retainedReceiptTxIds.add(entry.transactionRef);
        }
        releasedReceiptCount++;
        continue;
      }
      for (const row of owned) {
        removeReceiptEntry(row);
        const entry = ledgerEntryFromFirestore(row);
        if (!entry.transactionRef) continue;
        const receipt = receipts.get(entry.transactionRef);
        if (receipt && receipt.personId !== person.id) throw new AgreementResetBlockedError("A receipt is shared by multiple People records. Review it in People first.");
        receipts.set(entry.transactionRef, { personId: person.id, signedAmount: round2((receipt?.signedAmount ?? 0) - signedAmount(entry)) });
      }
      receiptCount++;
    }
  }

  const paymentTxIds = new Set(stringIds(payments.map((row) => row.get("transactionId"))));
  const referencedTx = stringIds([...paymentTxIds, ...imports, ...disbursementTxIds, ...settlementIds.keys(), ...receipts.keys(), ...retainedReceiptTxIds]);
  const [direct, paymentBackRefs] = await Promise.all([
    Promise.all(referencedTx.map((tId) => getDocFromServer(doc(transactions, tId)))),
    lookup(transactions, "installmentPaymentId", [...paymentIds]),
  ]);
  observed.push(...direct, ...backRefs, ...paymentBackRefs, ...expenseLinks);
  const candidateRows = rowsByPath([...backRefs, ...paymentBackRefs, ...expenseLinks, ...direct.filter((row): row is Row => row.exists())]);
  const candidateById = new Map(candidateRows.map((row) => [row.id, row]));
  for (const row of [...payments, ...disbursements].filter(active)) {
    const tId = row.get("transactionId");
    if (typeof tId === "string" && (!candidateById.has(tId) || !active(candidateById.get(tId)!))) {
      throw new AgreementResetBlockedError("A payment's linked transaction is missing or already reversed. Review the payment history first.");
    }
  }
  for (const tId of receipts.keys()) {
    if (!candidateById.has(tId) || !active(candidateById.get(tId)!)) throw new AgreementResetBlockedError("A People receipt's linked transaction is unavailable. Review it in People first.");
  }
  for (const tId of liveSettlementIds) {
    if (!candidateById.has(tId) || !active(candidateById.get(tId)!)) throw new AgreementResetBlockedError("A lender charge's linked transaction is unavailable. Review the charge first.");
  }
  for (const tId of retainedReceiptTxIds) {
    const row = candidateById.get(tId);
    if (!row || !active(row) || row.get("isPersonLedgerMovement") !== true) throw new AgreementResetBlockedError("A shared receipt's original transaction cannot be verified. Review it in People first.");
  }

  const doomed: Transaction[] = [];
  let releasedExpenseCount = 0;
  for (const row of candidateRows) {
    const t = transactionFromFirestore(row);
    const link = t.earlierPaymentLink;
    if (link?.ownerType === kind && link.ownerId === id && link.scheduleId === scheduleId) {
      const target = doc(schedule.ref, C.installments, link.installmentId, C.payments, link.paymentId);
      if (!changes.has(target.path)) {
        const existing = await getDocFromServer(target);
        observed.push(existing);
        if (existing.exists() && active(existing)) throw new AgreementResetChangedError();
      }
      update(row, { earlierPaymentLink: null });
      releasedExpenseCount++;
      continue;
    }
    if (link && imports.has(t.id)) throw new AgreementResetBlockedError("An existing expense is linked to another agreement. Review its payment link before resetting.");
    // Opening money, an existing card purchase and independent expenses are not part of payment history.
    if (t.id === owner.get("purchaseTransactionId") || isOriginationTransactionId(t.id) || imports.has(t.id)) continue;
    if (t.paymentAllocationType === "additionalDisbursement" && !disbursementTxIds.has(t.id)) {
      if (active(row)) throw new AgreementResetBlockedError("An extra-principal transaction has no matching disbursement record. Its effect on the loan cannot be verified.");
      continue;
    }
    const receipt = receipts.get(t.id);
    const lenderId = settlementIds.get(t.id);
    const belongs = (kind === "loan" ? t.loanId === id : t.emiId === id) || paymentTxIds.has(t.id) || disbursementTxIds.has(t.id) || paymentIds.has(t.installmentPaymentId ?? "") || receipt != null || lenderId != null;
    if (!belongs) continue;
    requireSafeTransaction(t, kind, id);
    if (row.get("type") !== t.type || retainedReceiptTxIds.has(t.id) || t.isPersonLedgerMovement !== (receipt != null) || (receipt != null && (t.linkedPersonId !== receipt.personId || Math.abs((t.type === "income" ? t.amount : -t.amount) - receipt.signedAmount) > 0.005)) || (t.lenderChargeId ?? undefined) !== lenderId || (t.installmentId != null && !installmentIds.has(t.installmentId))) {
      throw new AgreementResetBlockedError("A linked transaction's ownership could not be verified. No recordings were removed.");
    }
    doomed.push(t);
    remove(row);
  }

  const doomedIds = doomed.map((t) => t.id);
  const [expenses, loanPurchases, emiPurchases, peopleDependencies] = await Promise.all([
    lookup(collection(user, C.expenses), "transactionId", doomedIds),
    lookup(loans, "purchaseTransactionId", doomedIds),
    lookup(emis, "purchaseTransactionId", doomedIds),
    Promise.all(people.map((person) => {
      const ledger = collection(person.ref, C.ledger);
      return Promise.all([
        lookup(ledger, "transactionRef", doomedIds),
        lookup(ledger, "incomeTransactionRef", doomedIds),
        lookup(collection(person.ref, C.purposeFunds), "receiptTransactionRef", doomedIds),
      ]);
    })),
  ]);
  if ([...expenses, ...loanPurchases, ...emiPurchases].some(active) || peopleDependencies.flat(2).some((row) => active(row) && !receiptEntryPaths.has(row.ref.path))) {
    throw new AgreementResetBlockedError("One of these transactions also supports a separate expense, agreement or People entry. Review that link first.");
  }
  observed.push(...expenses, ...loanPurchases, ...emiPurchases, ...peopleDependencies.flat(2));

  const accountDeltas = [...netBalanceDeltas(doomed.filter((t) => t.deletedAt == null), [])].filter(([, delta]) => delta !== 0);
  const accountEffects = await Promise.all(accountDeltas.map(async ([accountId, delta]) => {
    const account = requireRow(await getDocFromServer(doc(user, C.accounts, accountId)), "A linked account");
    observed.push(account);
    const data = accountFromFirestore(account);
    if (!Number.isFinite(account.get("currentBalance")) || !Number.isFinite(data.currentBalance + delta)) throw new AgreementResetBlockedError("A linked account balance cannot be verified.");
    const currentBalance = round2(data.currentBalance + delta);
    const audited = accountToFirestore(recordEdit(data, "currentBalance", String(data.currentBalance), String(currentBalance)));
    update(account, { currentBalance, lastEditedAt: audited.lastEditedAt, editHistory: audited.editHistory });
    return { accountName: data.name, delta };
  }));
  const personEffects = [];
  for (const person of people) {
    const delta = personDeltas.get(person.id) ?? 0;
    if (!delta) continue;
    const data = personFromFirestore(person);
    if (!Number.isFinite(person.get("currentBalance")) || !Number.isFinite(data.currentBalance + delta)) throw new AgreementResetBlockedError("A linked Person's balance cannot be verified.");
    const currentBalance = round2(data.currentBalance + delta);
    const audited = personToFirestore(recordEdit(data, "currentBalance", String(data.currentBalance), String(currentBalance)));
    update(person, { currentBalance, lastEditedAt: audited.lastEditedAt, editHistory: audited.editHistory });
    personEffects.push({ personName: data.name, delta });
  }

  const hasRecordings = changes.size > 0;
  // Keep the agreement and schedule. Their update makes concurrent, schedule-aware writers re-read the reset state.
  if (hasRecordings) {
    update(owner, { lastEditedAt: now });
    update(schedule, { lastEditedAt: now });
  }
  if (changes.size > MAX_ATOMIC_DELETION_WRITES) throw new AgreementResetBlockedError("This agreement has too many linked records for one atomic reset. Review its payment history first.");
  if (observed.some((row) => row.metadata.hasPendingWrites)) throw new AgreementResetBlockedError("Wait for this device's changes to sync, then refresh the preview.");
  const reviewed = reviewedDocuments(observed);
  const current = reviewed.map(([, { row }]) => row);
  const revision = JSON.stringify(reviewed.map(([path, observed]) => [path, observed.version]));
  const preview: AgreementResetPreview = {
    revision, installmentCount: paidInstallments.length, paymentCount: payments.length,
    transactionCount: doomed.length, disbursementCount: disbursements.length, lenderChargeCount: charges.length,
    receiptCount, releasedReceiptCount, releasedExpenseCount, advanceCount, trackingCount, accountEffects, personEffects, hasRecordings,
  };
  return { preview, current, changes: [...changes.values()] };
}

export async function previewAgreementRecordingReset(db: Firestore, uid: string, kind: AgreementKind, id: string): Promise<AgreementResetPreview> {
  return (await prepare(db, uid, kind, id)).preview;
}

export async function resetAgreementRecordings(db: Firestore, uid: string, kind: AgreementKind, id: string, reviewedRevision: string): Promise<void> {
  await runTransaction(db, async (tx) => {
    // The web SDK cannot query inside a transaction. Re-run discovery for each attempt, then lock each
    // identified document through transactional reads. Payment and receipt writers also touch these records.
    const fresh = await prepare(db, uid, kind, id);
    if (fresh.preview.revision !== reviewedRevision) throw new AgreementResetChangedError();
    const checked = await Promise.all(fresh.current.map((row) => tx.get(row.ref)));
    if (checked.some((row, index) => version(row.data()) !== version(fresh.current[index].data()))) throw new AgreementResetChangedError();
    for (const { ref, patch } of fresh.changes) {
      if (patch == null) tx.delete(ref);
      else tx.update(ref, patch);
    }
  });
}
