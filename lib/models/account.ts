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
    deletedAt: account.deletedAt == null ? null : Timestamp.fromDate(account.deletedAt),
    lastEditedAt: account.lastEditedAt == null ? null : Timestamp.fromDate(account.lastEditedAt),
    editHistory: account.editHistory.map(auditEntryToMap),
  };
}
