/**
 * Direct port of
 * `lib/features/transactions/domain/{transaction,transaction_type}.dart`.
 * Field names, Firestore document shape, and computed getters must stay
 * identical to the Flutter model — both apps read/write the same documents
 * and every aggregation (Net Worth, Cash Flow, Reports) depends on
 * `signedAmount`/`effectiveMonth`/`balanceEffect` matching exactly.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

export type TransactionType = "income" | "expense";

/** Mirrors `TransactionTypeX.fromName` — unrecognized names fall back to "expense". */
export function transactionTypeFromName(name: string): TransactionType {
  return name === "income" ? "income" : "expense";
}

/**
 * B8 (transaction-studio-implementation-roadmap.md) — additive, web-only
 * field, same pattern as `transferMatchedAt`: absent/undefined on read is
 * treated identically to `"posted"`, so pre-B8 documents and the mobile app
 * (which never writes it) are unaffected. `"pending"` is for future-dated or
 * not-yet-settled transactions; `"reversed"` marks one that a refund/
 * chargeback (B23/B24) has since reversed without deleting the audit trail.
 */
export type TransactionStatus = "posted" | "pending" | "reversed";

const TRANSACTION_STATUSES: TransactionStatus[] = ["posted", "pending", "reversed"];

/** Unrecognized/missing names fall back to "posted" — matches every pre-B8 document's implicit state. */
export function transactionStatusFromName(name: string | undefined): TransactionStatus {
  return name != null && (TRANSACTION_STATUSES as string[]).includes(name) ? (name as TransactionStatus) : "posted";
}

/**
 * SMS Transaction Intelligence — additive, web-only field (not present in
 * the Flutter model), same pattern as `status`/`isBusiness`/
 * `transferMatchedAt`: absent/undefined on read is treated identically to
 * `null` ("unknown/pre-existing"), so every transaction created before this
 * field existed and the mobile app (which never writes it) are unaffected.
 * `"manual"` is not auto-assigned on read for old documents — `null` means
 * "we don't know," not "definitely manual," since a pre-source transaction
 * could have come from any path.
 */
export type TransactionSource = "manual" | "pdf" | "sms" | "other";

const TRANSACTION_SOURCES: TransactionSource[] = ["manual", "pdf", "sms", "other"];

/** `null` for unrecognized/missing names — mirrors `transferMatchedAt`'s "never defaulted" convention, not `status`'s "always defaulted" one, since a wrong guess here would misattribute a transaction's real origin. */
export function transactionSourceFromName(name: string | undefined): TransactionSource | null {
  return name != null && (TRANSACTION_SOURCES as string[]).includes(name) ? (name as TransactionSource) : null;
}

export interface Transaction extends SoftDeletableEntity {
  type: TransactionType;
  amount: number;
  dateTime: Date;
  accountId: string;
  categoryId: string;
  description: string;
  notes: string;
  receiptPurpose: string | null;
  transferId: string | null;
  excludeFromCalculations: boolean;
  accountingMonth: Date | null;
  linkedPersonId: string | null;
  owesPersonToggle: boolean;
  createdAt: Date;
  /**
   * Set only when `transferId` was assigned retroactively by the Transfer
   * Reconciliation Engine (B11, `lib/engines/transfer-reconciliation-engine.ts`)
   * instead of at creation time by `TransactionRepository.createTransferPair`.
   * `null` for every transaction created before this field existed and for
   * both legs of a same-session `createTransferPair` transfer — additive,
   * web-only field (not present in the Flutter model); absent/undefined on
   * read is treated identically to `null`, so older documents and the mobile
   * app (which never writes it) are unaffected. Purely an audit/idempotency
   * marker — never read by `isTransfer`/`balanceEffect`/aggregation.
   */
  transferMatchedAt: Date | null;
  /** B8 — see `TransactionStatus`. */
  status: TransactionStatus;
  /**
   * B22 — the Business modifier (`RecordModifiers.business`), carried onto
   * the committed transaction so reports can break business spend out from
   * personal spend. Additive, same pattern as `transferMatchedAt`/`status`.
   */
  isBusiness: boolean;
  /** See `TransactionSource` — null means "unknown/pre-existing," not "manual." */
  source: TransactionSource | null;
}

/** Set on both legs of a transfer between two of the user's own accounts. */
export function isTransfer(transaction: Transaction): boolean {
  return transaction.transferId != null;
}

/** The signed delta this transaction applies to its account's balance. */
export function signedAmount(transaction: Transaction): number {
  return transaction.type === "income" ? transaction.amount : -transaction.amount;
}

/** Which month every monthly aggregation must bucket this transaction under. */
export function effectiveMonth(transaction: Transaction): Date {
  if (transaction.accountingMonth) return transaction.accountingMonth;
  return new Date(transaction.dateTime.getFullYear(), transaction.dateTime.getMonth());
}

/** signedAmount, or zero when excludeFromCalculations is true. */
export function balanceEffect(transaction: Transaction): number {
  return transaction.excludeFromCalculations ? 0 : signedAmount(transaction);
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

export function transactionFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Transaction {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    type: transactionTypeFromName(data.type as string),
    amount: (data.amount as number) ?? 0,
    dateTime: (data.dateTime as Timestamp).toDate(),
    accountId: data.accountId as string,
    categoryId: data.categoryId as string,
    description: (data.description as string | undefined) ?? "",
    notes: (data.notes as string | undefined) ?? "",
    receiptPurpose: (data.receiptPurpose as string | undefined) ?? null,
    transferId: (data.transferId as string | undefined) ?? null,
    excludeFromCalculations: (data.excludeFromCalculations as boolean) ?? false,
    accountingMonth: (data.accountingMonth as Timestamp | undefined)?.toDate() ?? null,
    linkedPersonId: (data.linkedPersonId as string | undefined) ?? null,
    owesPersonToggle: (data.owesPersonToggle as boolean) ?? false,
    createdAt: (data.createdAt as Timestamp).toDate(),
    transferMatchedAt: (data.transferMatchedAt as Timestamp | undefined)?.toDate() ?? null,
    status: transactionStatusFromName(data.status as string | undefined),
    isBusiness: (data.isBusiness as boolean | undefined) ?? false,
    source: transactionSourceFromName(data.source as string | undefined),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function transactionToFirestore(transaction: Transaction): DocumentData {
  return {
    type: transaction.type,
    amount: transaction.amount,
    dateTime: Timestamp.fromDate(transaction.dateTime),
    accountId: transaction.accountId,
    categoryId: transaction.categoryId,
    description: transaction.description,
    notes: transaction.notes,
    receiptPurpose: transaction.receiptPurpose,
    transferId: transaction.transferId,
    excludeFromCalculations: transaction.excludeFromCalculations,
    accountingMonth: transaction.accountingMonth == null ? null : Timestamp.fromDate(transaction.accountingMonth),
    linkedPersonId: transaction.linkedPersonId,
    owesPersonToggle: transaction.owesPersonToggle,
    createdAt: Timestamp.fromDate(transaction.createdAt),
    transferMatchedAt: transaction.transferMatchedAt == null ? null : Timestamp.fromDate(transaction.transferMatchedAt),
    status: transaction.status,
    isBusiness: transaction.isBusiness,
    source: transaction.source,
    deletedAt: transaction.deletedAt == null ? null : Timestamp.fromDate(transaction.deletedAt),
    lastEditedAt: transaction.lastEditedAt == null ? null : Timestamp.fromDate(transaction.lastEditedAt),
    editHistory: transaction.editHistory.map(auditEntryToMap),
  };
}
