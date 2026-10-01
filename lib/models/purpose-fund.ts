/**
 * Purpose money — part of a real People receipt that I am holding for a specific purpose
 * ("₹2,000 of what Amma sent is for the KSEB bill"). Stored in
 * `users/{uid}/people/{personId}/purposeFunds/{id}` — a separate subcollection, never a ledger entry,
 * exactly like `AdvanceApplication`: it moves neither cash nor the person's balance.
 *
 *  - CASH: the money arrived once, inside the Record Payment cash leg (`receiptTransactionRef`,
 *    `isPersonLedgerMovement` — so never Income). A purpose never creates or moves cash itself.
 *  - USE: spending it is a separate, real outgoing Transaction (`uses[].transactionId`) — created from
 *    the purpose ("Record use") or an existing payment linked to it. How much is used is DERIVED from
 *    the uses whose Transaction is still active, so deleting that Transaction anywhere reopens the
 *    purpose by exactly that amount — nothing stored can drift.
 *  - NOT AN ADVANCE: it never reduces what the person owes. Only an explicit release to "advance"
 *    (a normal advance ledger entry on the same payment) does that.
 *
 * `state`:
 *  - "active"     — a purpose; pending / partially used / completed are derived from its uses;
 *  - "unassigned" — money freed from a purpose (cancelled, or its amount lowered) waiting for a decision;
 *  - "released"   — unassigned money turned into an advance or income (`release`); kept for the audit trail;
 *  - "cancelled"  — a purpose cancelled before anything was used (its amount moved to an unassigned doc).
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";

export type PurposeFundState = "active" | "unassigned" | "released" | "cancelled";

/** What the purpose is for, when FlowFi already tracks it. Never required. */
export type PurposeLinkKind = "card" | "loan" | "emi" | "bill" | "person";

export interface PurposeLink {
  kind: PurposeLinkKind;
  /** Card: the card's account id. Loan / EMI / Bill / Person: that entity's id. */
  id: string;
  /** Display name at the time it was linked (the entity stays authoritative). */
  label: string;
}

export interface PurposeUse {
  id: string;
  /** The real outgoing Transaction (for a card payment, the outflow leg of the transfer). */
  transactionId: string;
  /** How much of that Transaction this purpose accounts for (≤ the transaction's amount). */
  amount: number;
  date: Date;
  /** True when "Record use" created the Transaction — undoing the use then deletes it too. */
  createdHere: boolean;
  createdAt: Date;
}

export interface PurposeRelease {
  kind: "advance" | "income";
  /** Advance: the advance ledger entry id. Income: the Income Transaction id. */
  ref: string;
  date: Date;
}

export interface PurposeFund {
  id: string;
  personId: string;
  /** The Record Payment group (`LedgerEntry.paymentId`) this money arrived with. */
  paymentId: string;
  /** The Record Payment cash leg the money arrived in. */
  receiptTransactionRef: string;
  receivedDate: Date;
  /** The same receipt's separate Income transaction, if its extra was divided into purposes + income. */
  incomeTransactionRef?: string | null;
  title: string;
  /** Allocated amount. */
  amount: number;
  dueDate: Date | null;
  note: string;
  link: PurposeLink | null;
  uses: PurposeUse[];
  state: PurposeFundState;
  release: PurposeRelease | null;
  /** Set when the purpose was fully used. */
  completedAt: Date | null;
  createdAt: Date;
  lastEditedAt: Date | null;
  deletedAt: Date | null;
}

const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null);
const fromDate = (d: Date | null) => (d == null ? null : Timestamp.fromDate(d));

export function purposeFundFromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>, _options?: SnapshotOptions): PurposeFund {
  const data = snapshot.data();
  const release = data.release as Record<string, unknown> | null | undefined;
  return {
    id: snapshot.id,
    personId: data.personId as string,
    paymentId: data.paymentId as string,
    receiptTransactionRef: data.receiptTransactionRef as string,
    receivedDate: toDate(data.receivedDate)!,
    // Only receipts divided into purposes + income carry it — older docs keep their exact shape.
    ...(typeof data.incomeTransactionRef === "string" ? { incomeTransactionRef: data.incomeTransactionRef } : {}),
    title: (data.title as string | undefined) ?? "",
    amount: (data.amount as number) ?? 0,
    dueDate: toDate(data.dueDate),
    note: (data.note as string | undefined) ?? "",
    link: (data.link as PurposeLink | null | undefined) ?? null,
    uses: ((data.uses as Record<string, unknown>[] | undefined) ?? []).map((u) => ({
      id: u.id as string,
      transactionId: u.transactionId as string,
      amount: (u.amount as number) ?? 0,
      date: toDate(u.date)!,
      createdHere: (u.createdHere as boolean | undefined) ?? false,
      createdAt: toDate(u.createdAt)!,
    })),
    state: (data.state as PurposeFundState | undefined) ?? "active",
    release: release ? { kind: release.kind as "advance" | "income", ref: release.ref as string, date: toDate(release.date)! } : null,
    completedAt: toDate(data.completedAt),
    createdAt: toDate(data.createdAt)!,
    lastEditedAt: toDate(data.lastEditedAt),
    deletedAt: toDate(data.deletedAt),
  };
}

export function purposeFundToFirestore(f: PurposeFund): DocumentData {
  return {
    personId: f.personId,
    paymentId: f.paymentId,
    receiptTransactionRef: f.receiptTransactionRef,
    receivedDate: Timestamp.fromDate(f.receivedDate),
    incomeTransactionRef: f.incomeTransactionRef ?? null,
    title: f.title,
    amount: f.amount,
    dueDate: fromDate(f.dueDate),
    note: f.note,
    link: f.link,
    uses: f.uses.map((u) => ({ ...u, date: Timestamp.fromDate(u.date), createdAt: Timestamp.fromDate(u.createdAt) })),
    state: f.state,
    release: f.release ? { ...f.release, date: Timestamp.fromDate(f.release.date) } : null,
    completedAt: fromDate(f.completedAt),
    createdAt: Timestamp.fromDate(f.createdAt),
    lastEditedAt: fromDate(f.lastEditedAt),
    deletedAt: fromDate(f.deletedAt),
  };
}
