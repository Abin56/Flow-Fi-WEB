/**
 * The SAVE-BOUNDARY lock on who repays a Loan / EMI. A person's balance is "what their share owes" less "what they
 * have repaid". Taking the share away while their repayments need it would leave those repayments reading as money I
 * owe them. So a save that stops counting someone is refused when either:
 *  1. something they paid or applied is recorded against this agreement's installments; or
 *  2. what they paid toward their overall balance (a general payment, tied to no item) is more than their OTHER open
 *     items could account for — part of it is covered only by this share.
 * A general payment other items still cover, and an advance held but not applied here, don't block. Adding a repayer
 * (including switching one back on) is never refused. Nothing is reversed: the person's payment has to be reverted in
 * People first.
 *
 * It runs inside the whole-document write's transaction (`writeKeepingStoredConfirmation`) and compares the STORED
 * document with the one about to be written, so a stale copy held by any screen is covered too. Documents are only
 * read. Same technique as `people-share-cap.ts` against a payment saved at the same moment: the person's document and
 * each advance entry are read in the transaction before the queries, so a competing write fails this commit and the
 * retry queries again; the other way round, a share receipt reads the agreement document, which this write changes.
 *
 * Rule 2 is judged by the People statement engine over the whole history (future installments included) — no second
 * calculation. Other agreements are read as stored; a change to one of them at the same instant isn't locked against.
 */

import { collection, doc, getDocs, query, where, type DocumentReference, type Transaction } from "firebase/firestore";
import { hasOwnershipShares, personSharesInstallments, type OwnershipSource } from "@/lib/engines/debt-ownership";
import { buildPersonCycleStatement, type StatementInstallment } from "@/lib/engines/person-cycle-statement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { formatCurrencyExact } from "@/lib/format";
import { emiFromFirestore, type Emi } from "@/lib/models/emi";
import { loanFromFirestore, type Loan } from "@/lib/models/loan";
import { installmentFromFirestore } from "@/lib/models/payment-schedule";
import { advanceApplicationFromFirestore, ledgerEntryFromFirestore, personFromFirestore, type AdvanceApplication, type LedgerEntry, type Person } from "@/lib/models/person";

export class RepaymentLinkLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepaymentLinkLockedError";
  }
}

/** Everyone counted as repaying a share of this agreement (ignores whether it is in Trash). */
export function repayerIds(source: OwnershipSource): string[] {
  if (hasOwnershipShares(source)) return source.ownershipShares!.flatMap((s) => (s.personId != null && s.amount > 0 ? [s.personId] : []));
  return source.beneficiaryPersonId && source.beneficiaryRepaysInstallments === true ? [source.beneficiaryPersonId] : [];
}

type Agreement = OwnershipSource & { id: string; scheduleId: string };

export async function assertRepayersKept(params: {
  /** `users/{uid}`. */
  userDoc: DocumentReference;
  tx: Transaction;
  kind: "loan" | "emi";
  stored: Agreement;
  next: Agreement;
}): Promise<void> {
  const kept = new Set(repayerIds(params.next));
  const removed = repayerIds(params.stored).filter((id) => !kept.has(id));
  if (removed.length === 0) return;

  const { userDoc, tx, kind } = params;
  const agreementName = kind === "emi" ? "EMI" : "Loan";
  // Retired (re-planned) installments are included: a repayment recorded against one is still a repayment.
  const installments = await getDocs(collection(userDoc, FirestoreCollections.paymentSchedules, params.stored.scheduleId, FirestoreCollections.installments));
  const keys = new Set(installments.docs.map((d) => `${kind}-inst:${d.id}`));

  for (const personId of removed) {
    const personRef = doc(userDoc, FirestoreCollections.people, personId);
    const personSnap = await tx.get(personRef);
    if (!personSnap.exists()) continue;
    const ledger = await getDocs(collection(personRef, FirestoreCollections.ledger));
    for (const entry of ledger.docs) {
      if (entry.data().deletedAt == null && entry.data().sourceKind === "advance") await tx.get(entry.ref);
    }
    const applications = await getDocs(query(collection(personRef, FirestoreCollections.advanceApplications), where("deletedAt", "==", null)));
    const name = (personSnap.data().name as string | undefined) ?? "This person";

    if (
      ledger.docs.some((d) => d.data().deletedAt == null && keys.has(d.data().obligationRef as string)) ||
      applications.docs.some((d) => keys.has(d.data().obligationKey as string))
    ) {
      throw new RepaymentLinkLockedError(`${name} already has repayments recorded for this ${agreementName}, so “repays me” can't be changed. Revert those payments in People first.`);
    }

    const uncovered = await generalMoneyOnlyThisShareCovers({
      userDoc,
      kind,
      next: params.next,
      person: personFromFirestore(personSnap as never),
      ledgerEntries: ledger.docs.map((d) => ledgerEntryFromFirestore(d)),
      applications: applications.docs.map((d) => advanceApplicationFromFirestore(d)),
    });
    if (uncovered > PAYMENT_EPSILON) {
      throw new RepaymentLinkLockedError(
        `${name} has paid toward their overall balance, and ${formatCurrencyExact(uncovered)} of it is only covered by this ${agreementName}. Changing “repays me” would show it as money you owe them. Revert that payment in People first.`,
      );
    }
  }
}

/**
 * How much of the person's general repayments (money they paid, linked to no existing item) would be left with no open
 * item to account for once this agreement stops counting them. 0 when they have made none.
 */
async function generalMoneyOnlyThisShareCovers(params: {
  userDoc: DocumentReference;
  kind: "loan" | "emi";
  next: Agreement;
  person: Person;
  ledgerEntries: LedgerEntry[];
  applications: AdvanceApplication[];
}): Promise<number> {
  const { userDoc, kind, next, person, ledgerEntries, applications } = params;
  // Cheap exit: only an unlinked "they paid me" entry can be general money.
  if (!ledgerEntries.some((e) => e.deletedAt == null && e.type === "receivedBack" && e.sourceKind !== "advance" && !e.obligationRef)) return 0;

  const [emiDocs, loanDocs] = await Promise.all([getDocs(collection(userDoc, FirestoreCollections.emis)), getDocs(collection(userDoc, FirestoreCollections.loans))]);
  // This agreement as it is ABOUT to be saved; every other one as stored.
  const emis: Emi[] = emiDocs.docs.map((d) => (kind === "emi" && d.id === next.id ? (next as unknown as Emi) : emiFromFirestore(d)));
  const loans: Loan[] = loanDocs.docs.map((d) => (kind === "loan" && d.id === next.id ? (next as unknown as Loan) : loanFromFirestore(d)));
  const schedules = new Set<string>([
    ...emis.filter((e) => personSharesInstallments(e, person.id)).map((e) => e.scheduleId),
    ...loans.filter((l) => personSharesInstallments(l, person.id) || (l.deletedAt == null && l.personId === person.id)).map((l) => l.scheduleId),
  ]);
  const installments = (
    await Promise.all([...schedules].map(async (id) => (await getDocs(collection(userDoc, FirestoreCollections.paymentSchedules, id, FirestoreCollections.installments))).docs.map((d) => installmentFromFirestore(d))))
  ).flat() as unknown as StatementInstallment[];

  const after = buildPersonCycleStatement({
    person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
    ledgerEntries,
    loanIds: new Set(loans.map((l) => l.id)),
    emis,
    loans,
    installments,
    advanceApplications: applications,
    cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) },
  });
  const general = round2(after.rows.filter((r) => r.kind === "settlement" && r.category === "received" && r.settlesKey == null && r.loan == null).reduce((t, r) => t + r.amount, 0));
  const stillOpen = round2(after.rows.filter((r) => r.kind === "obligation" && r.signedAmount > 0).reduce((t, r) => t + (r.remainingNow ?? 0), 0));
  return round2(Math.max(0, general - stillOpen));
}
