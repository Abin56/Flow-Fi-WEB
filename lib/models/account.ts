/**
 * Direct port of `lib/features/accounts/domain/{account,account_type}.dart`.
 * Field names, Firestore document shape, and defaults must stay identical
 * to the Flutter model — both apps read/write the same documents.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

export type AccountType = "cash" | "bank" | "card" | "wallet" | "business" | "other";

const ACCOUNT_TYPES: AccountType[] = ["cash", "bank", "card", "wallet", "business", "other"];

/** Mirrors `AccountTypeX.fromName` — unrecognized names fall back to "other". */
export function accountTypeFromName(name: string): AccountType {
  return (ACCOUNT_TYPES as string[]).includes(name) ? (name as AccountType) : "other";
}

/**
 * Only meaningful when `Account.type === "bank"` — which real-world bank
 * product this account represents. Purely a display/behavior refinement of
 * `type: "bank"`, not a separate type: an FD/RD is still a `bank` account
 * that happens to carry maturity/interest fields too.
 */
export type BankAccountSubtype =
  | "savings"
  | "current"
  | "salary"
  | "fixedDeposit"
  | "recurringDeposit"
  | "nre"
  | "nro"
  | "other";

const BANK_ACCOUNT_SUBTYPES: BankAccountSubtype[] = [
  "savings",
  "current",
  "salary",
  "fixedDeposit",
  "recurringDeposit",
  "nre",
  "nro",
  "other",
];

/** Unrecognized/absent names fall back to null — a pre-existing bank account with no subtype set is simply "unspecified", not defaulted to "savings". */
export function bankAccountSubtypeFromName(name: string | null | undefined): BankAccountSubtype | null {
  if (name == null) return null;
  return (BANK_ACCOUNT_SUBTYPES as string[]).includes(name) ? (name as BankAccountSubtype) : null;
}

/**
 * Only meaningful when `Account.type === "card"` — which real-world card
 * product this account represents. This is the field that decides whether a
 * card gets a `CreditCardProfile` (see `lib/models/credit-card.ts`'s doc
 * comment): ONLY `"credit"` cards do. Every other subtype is a plain
 * `Account` of type `"card"` with no linked credit profile, so it never
 * appears in the Credit Cards section — see `useCreditCards()`.
 */
export type CardSubtype = "credit" | "debit" | "prepaid" | "forex" | "gift" | "other";

const CARD_SUBTYPES: CardSubtype[] = ["credit", "debit", "prepaid", "forex", "gift", "other"];

/** Unrecognized/absent names fall back to null — mirrors `bankAccountSubtypeFromName`'s convention. */
export function cardSubtypeFromName(name: string | null | undefined): CardSubtype | null {
  if (name == null) return null;
  return (CARD_SUBTYPES as string[]).includes(name) ? (name as CardSubtype) : null;
}

export interface Account extends SoftDeletableEntity {
  name: string;
  type: AccountType;
  openingBalance: number;
  currentBalance: number;
  colorValue: number;
  isDefault: boolean;
  createdAt: Date;
  bankId: string | null;
  accountHolderName: string | null;
  notes: string | null;
  accountNumberLast4: string | null;
  /** Only set when `type === "bank"`. */
  bankAccountSubtype: BankAccountSubtype | null;
  /** Savings/Current/Salary only — the minimum balance the bank requires this account to hold. */
  minimumBalance: number | null;
  /** FD/RD only — the annual interest rate the deposit earns. */
  interestRatePercent: number | null;
  /** FD/RD only — the date the deposit matures. */
  maturityDate: Date | null;
  /** FD/RD only — the deposit's tenure in months. */
  tenureMonths: number | null;
  /** Only set when `type === "card"`. */
  cardSubtype: CardSubtype | null;
  /**
   * Non-bank card issuer name — Prepaid/Forex/Gift cards are frequently
   * issued by a fintech/platform rather than a bank in `bankId`'s registry
   * (e.g. "Amazon Pay", "Niyo", "EzeTap"). Free text, not used by
   * Credit/Debit cards, which use `bankId` instead.
   */
  cardProvider: string | null;
  /** Debit card only — the `Account` (a bank account) this card draws from and is the payment instrument for. */
  linkedAccountId: string | null;
  /** Prepaid card only — whether the card can be topped up again after the initial load. */
  reloadable: boolean | null;
  /** Forex card only — the currency this card's balance is held in (e.g. "USD"). */
  currency: string | null;
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

export function accountFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Account {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name as string,
    type: accountTypeFromName(data.type as string),
    openingBalance: (data.openingBalance as number) ?? 0,
    currentBalance: (data.currentBalance as number) ?? 0,
    colorValue: data.colorValue as number,
    isDefault: (data.isDefault as boolean) ?? false,
    createdAt: (data.createdAt as Timestamp).toDate(),
    bankId: (data.bankId as string | undefined) ?? null,
    accountHolderName: (data.accountHolderName as string | undefined) ?? null,
    notes: (data.notes as string | undefined) ?? null,
    accountNumberLast4: (data.accountNumberLast4 as string | undefined) ?? null,
    bankAccountSubtype: bankAccountSubtypeFromName(data.bankAccountSubtype as string | undefined),
    minimumBalance: (data.minimumBalance as number | undefined) ?? null,
    interestRatePercent: (data.interestRatePercent as number | undefined) ?? null,
    maturityDate: (data.maturityDate as Timestamp | undefined)?.toDate() ?? null,
    tenureMonths: (data.tenureMonths as number | undefined) ?? null,
    cardSubtype: cardSubtypeFromName(data.cardSubtype as string | undefined),
    cardProvider: (data.cardProvider as string | undefined) ?? null,
    linkedAccountId: (data.linkedAccountId as string | undefined) ?? null,
    reloadable: (data.reloadable as boolean | undefined) ?? null,
    currency: (data.currency as string | undefined) ?? null,
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function accountToFirestore(account: Account): DocumentData {
  return {
    name: account.name,
    type: account.type,
    openingBalance: account.openingBalance,
    currentBalance: account.currentBalance,
    colorValue: account.colorValue,
    isDefault: account.isDefault,
    createdAt: Timestamp.fromDate(account.createdAt),
    bankId: account.bankId,
    accountHolderName: account.accountHolderName,
    notes: account.notes,
    accountNumberLast4: account.accountNumberLast4,
    bankAccountSubtype: account.bankAccountSubtype,
    minimumBalance: account.minimumBalance,
    interestRatePercent: account.interestRatePercent,
    maturityDate: account.maturityDate == null ? null : Timestamp.fromDate(account.maturityDate),
    tenureMonths: account.tenureMonths,
    cardSubtype: account.cardSubtype,
    cardProvider: account.cardProvider,
    linkedAccountId: account.linkedAccountId,
    reloadable: account.reloadable,
    currency: account.currency,
    deletedAt: account.deletedAt == null ? null : Timestamp.fromDate(account.deletedAt),
    lastEditedAt: account.lastEditedAt == null ? null : Timestamp.fromDate(account.lastEditedAt),
    editHistory: account.editHistory.map(auditEntryToMap),
  };
}
