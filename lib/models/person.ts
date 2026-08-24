/**
 * Direct port of `lib/features/people/domain/{person,ledger_entry,
 * ledger_entry_type}.dart`. Field names, Firestore document shape, and
 * derived-field semantics must stay identical to the Flutter models — both
 * apps read/write the same `users/{uid}/people/{personId}` and
 * `.../people/{personId}/ledger/{entryId}` documents.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

export type LedgerEntryType = "gave" | "borrowed" | "receivedBack" | "repaid" | "adjustment";

const LEDGER_ENTRY_TYPES: LedgerEntryType[] = ["gave", "borrowed", "receivedBack", "repaid", "adjustment"];

/** Mirrors `LedgerEntryTypeX.fromName` — unrecognized names fall back to "adjustment". */
export function ledgerEntryTypeFromName(name: string): LedgerEntryType {
  return (LEDGER_ENTRY_TYPES as string[]).includes(name) ? (name as LedgerEntryType) : "adjustment";
}

/**
 * Mirrors `LedgerEntryTypeX.signFor` — applies this type's sign convention
 * to a positive `amount`. For "adjustment", `amount` is expected to already
 * carry the user's chosen sign and is passed through unchanged.
 */
export function signFor(type: LedgerEntryType, amount: number): number {
  switch (type) {
    case "gave":
    case "repaid":
      return amount;
    case "borrowed":
    case "receivedBack":
      return -amount;
    case "adjustment":
      return amount;
  }
}

/**
 * Someone you track a running money balance with — friend, family, business
 * contact. Whether they're a "creditor" (they owe you) or "debtor" (you owe
 * them) is never stored; it's derived from the sign of `currentBalance` via
 * `isCreditor`/`isDebtor`, since the same person can flip sides over time as
 * ledger entries are added.
 */
export interface Person extends SoftDeletableEntity {
  name: string;
  phone: string | null;
  email: string | null;
  notes: string;
  avatarColorValue: number;
  /**
   * Set once at creation and never edited afterward — mirrors
   * `Account.openingBalance`. Corrections after the fact go through an
   * explicit, dated "Manual adjustment" ledger entry instead, so the
   * timeline's starting point is never silently rewritten.
   */
  openingBalance: number;
  /**
   * Cached running balance (opening balance + every active ledger entry's
   * signed amount), kept in sync atomically by `LedgerRepository`'s
   * `addEntry`/`editEntryAmount`/`softDeleteEntry`/`restoreEntry` (each
   * applies `PersonRepository.applyBalanceDelta` inside its own
   * `runTransaction`) on every ledger write — the ledger subcollection
   * remains the source of truth; this is a read optimization, not a
   * second ledger.
   */
  currentBalance: number;
  createdAt: Date;
}

/** Positive balance: this person owes you money. */
export function isCreditor(person: Person): boolean {
  return person.currentBalance > 0;
}

/** Negative balance: you owe this person money. */
export function isDebtor(person: Person): boolean {
  return person.currentBalance < 0;
}

/**
 * A single movement in a Person's ledger — append-only in the general case
 * (soft-delete, which reverses its balance effect, and restore are the
 * usual ways its effect on the running balance changes), with one
 * deliberate exception: `LedgerRepository.editEntryAmount` corrects
 * `amount` in place when the split/assigned expense backing this entry is
 * edited, so the same history line the user tapped reflects the new amount
 * instead of leaving it stale alongside a separate adjustment line. Every
 * other field stays fixed for the entry's lifetime.
 */
export interface LedgerEntry extends SoftDeletableEntity {
  personId: string;
  type: LedgerEntryType;
  /**
   * Always positive — direction comes from `type` (via `signFor`) for every
   * type except "adjustment", where `increasesBalance` carries the
   * direction instead (an adjustment can correct the balance either way).
   * Mutable only via `LedgerRepository.editEntryAmount`.
   */
  amount: number;
  date: Date;
  note: string;
  /**
   * Only meaningful for type "adjustment" — whether this correction
   * increases or decreases the person's balance. Ignored for every other
   * type, whose direction is fixed by `signFor`.
   */
  increasesBalance: boolean;
  /**
   * Optional link to a Transaction.id — e.g. a repayment that also hit an
   * account transaction. Stored but not validated against the Transactions
   * collection in this milestone.
   */
  transactionRef: string | null;
  createdAt: Date;
}

/**
 * The signed delta this entry applies (and applied) to its person's running
 * balance — the single source of truth `LedgerRepository` uses both when
 * posting the entry and when reversing it on soft-delete, so the two can
 * never disagree about which direction this entry moved the balance.
 */
export function signedAmount(entry: LedgerEntry): number {
  return entry.type === "adjustment"
    ? entry.increasesBalance
      ? entry.amount
      : -entry.amount
    : signFor(entry.type, entry.amount);
}

function auditEntryFromMap(map: Record<string, unknown>): AuditEntry {
  return {
    timestamp: (map.timestamp as Timestamp).toDate(),
    field: map.field as string,
    oldValue: map.oldValue as string,
    newValue: map.newValue as string,
  };
}

function auditEntryToMap(entry: AuditEntry) {
  return {
    timestamp: Timestamp.fromDate(entry.timestamp),
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
  };
}

export function personFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Person {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name as string,
    phone: (data.phone as string | undefined) ?? null,
    email: (data.email as string | undefined) ?? null,
    notes: (data.notes as string | undefined) ?? "",
    avatarColorValue: data.avatarColorValue as number,
    openingBalance: (data.openingBalance as number) ?? 0,
    currentBalance: (data.currentBalance as number) ?? 0,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function personToFirestore(person: Person): DocumentData {
  return {
    name: person.name,
    phone: person.phone,
    email: person.email,
    notes: person.notes,
    avatarColorValue: person.avatarColorValue,
    openingBalance: person.openingBalance,
    currentBalance: person.currentBalance,
    createdAt: Timestamp.fromDate(person.createdAt),
    deletedAt: person.deletedAt == null ? null : Timestamp.fromDate(person.deletedAt),
    lastEditedAt: person.lastEditedAt == null ? null : Timestamp.fromDate(person.lastEditedAt),
    editHistory: person.editHistory.map(auditEntryToMap),
  };
}

export function ledgerEntryFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): LedgerEntry {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    personId: data.personId as string,
    type: ledgerEntryTypeFromName(data.type as string),
    amount: (data.amount as number) ?? 0,
    date: (data.date as Timestamp).toDate(),
    note: (data.note as string | undefined) ?? "",
    transactionRef: (data.transactionRef as string | undefined) ?? null,
    increasesBalance: (data.increasesBalance as boolean) ?? true,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function ledgerEntryToFirestore(entry: LedgerEntry): DocumentData {
  return {
    personId: entry.personId,
    type: entry.type,
    amount: entry.amount,
    date: Timestamp.fromDate(entry.date),
    note: entry.note,
    transactionRef: entry.transactionRef,
    increasesBalance: entry.increasesBalance,
    createdAt: Timestamp.fromDate(entry.createdAt),
    deletedAt: entry.deletedAt == null ? null : Timestamp.fromDate(entry.deletedAt),
    lastEditedAt: entry.lastEditedAt == null ? null : Timestamp.fromDate(entry.lastEditedAt),
    editHistory: entry.editHistory.map(auditEntryToMap),
  };
}
