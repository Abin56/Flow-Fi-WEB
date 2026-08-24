/**
 * Direct port of
 * `lib/features/expense/domain/{expense,expense_participant,split_type}.dart`.
 * Field names, Firestore document shape, and derived-field semantics must
 * stay identical to the Flutter models — both apps read/write the same
 * `users/{uid}/expenses/{expenseId}` documents.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

// --- SplitType (split_type.dart) ---

export type SplitType = "equal" | "custom" | "percentage" | "none";

const SPLIT_TYPES: SplitType[] = ["equal", "custom", "percentage", "none"];

/** Mirrors `SplitTypeX.fromName` — unrecognized names fall back to "none". */
export function splitTypeFromName(name: string): SplitType {
  return (SPLIT_TYPES as string[]).includes(name) ? (name as SplitType) : "none";
}

/** Mirrors `SplitTypeX.label`. */
export function splitTypeLabel(type: SplitType): string {
  switch (type) {
    case "equal":
      return "Split equally";
    case "custom":
      return "Custom amounts";
    case "percentage":
      return "Split by percentage";
    case "none":
      return "Not split";
  }
}

// --- ExpenseParticipant (expense_participant.dart) ---

/**
 * One participant's share of a split `Expense`. Embedded directly on the
 * expense document (not its own subcollection) since this is the fixed
 * definition of who owes what — the corresponding `Installment` (via
 * `OwnerType.splitExpense`) is the payable/trackable projection of the same
 * share, kept in step by `ExpenseRepository`.
 */
export interface ExpenseParticipant {
  /** Null when the participant isn't tracked as a Person. */
  personId: string | null;
  /** Display name — always populated, even for a linked Person. */
  name: string;
  /** This participant's portion of the expense's total. Always positive. */
  share: number;
  /**
   * The Installment tracking this participant's settlement — null until
   * `ExpenseRepository.createExpense` generates the schedule, and always
   * null for `isMe`.
   */
  installmentId: string | null;
  /**
   * Whether this is the permanent "Me" participant representing the payer's
   * own share (see `myShare`). Defaults to `false`.
   */
  isMe: boolean;
}

export function expenseParticipantFromMap(map: Record<string, unknown>): ExpenseParticipant {
  return {
    personId: (map.personId as string | undefined) ?? null,
    name: map.name as string,
    share: (map.share as number),
    installmentId: (map.installmentId as string | undefined) ?? null,
    isMe: (map.isMe as boolean | undefined) ?? false,
  };
}

export function expenseParticipantToMap(participant: ExpenseParticipant): DocumentData {
  return {
    personId: participant.personId,
    name: participant.name,
    share: participant.share,
    installmentId: participant.installmentId,
    isMe: participant.isMe,
  };
}

/** Mirrors `ExpenseParticipant.copyWith` — only `installmentId` is ever replaced after creation. */
export function copyExpenseParticipant(
  participant: ExpenseParticipant,
  params: { installmentId?: string | null },
): ExpenseParticipant {
  return {
    ...participant,
    installmentId: params.installmentId ?? participant.installmentId,
  };
}

// --- Expense (expense.dart) ---

/**
 * An expense you paid, optionally split across other people (or assigned
 * entirely to one person — the degenerate single-participant case of the
 * same `splitType`/`participants` shape). Every expense also has a matching
 * `Transaction` (tracked by `transactionId`) for account-balance purposes —
 * `Expense` owns split/assignment metadata, `Transaction` owns the account
 * balance effect, so neither duplicates the other's source of truth.
 */
export interface Expense extends SoftDeletableEntity {
  description: string;
  totalAmount: number;
  date: Date;
  categoryId: string;
  accountId: string;
  /** The Transaction this expense posted for account-balance purposes. */
  transactionId: string;
  /**
   * Mutable so `ExpenseRepository.convertToSplit` can turn a plain ("none")
   * expense into a split one after the fact, without touching
   * `transactionId`.
   */
  splitType: SplitType;
  /** Empty when `splitType` is "none" (a plain, unsplit expense). */
  participants: ExpenseParticipant[];
  /**
   * The PaymentSchedule ("splitExpense" ownerType) tracking participant
   * settlements — null when `splitType` is "none". Set once by
   * `ExpenseRepository.convertToSplit` if a plain expense is later split;
   * never cleared afterward.
   */
  scheduleId: string | null;
  notes: string;
  createdAt: Date;
}

/** Mirrors `Expense.isSplit`. */
export function isSplit(expense: Expense): boolean {
  return expense.splitType !== "none" && expense.participants.length > 0;
}

/**
 * The permanent "Me" participant, if this expense has one — split expenses
 * created before this field existed have none. Mirrors `Expense.meParticipant`.
 */
export function meParticipant(expense: Expense): ExpenseParticipant | null {
  return expense.participants.find((p) => p.isMe) ?? null;
}

/**
 * How much of this expense was actually mine: the full amount for a plain or
 * single-assignee expense, or the "Me" participant's own share for a split
 * expense. Split expenses with no "Me" participant report 0 rather than
 * guessing. Mirrors `Expense.myShare`.
 *
 * Derived (not a stored field), per the Dart getter and the compatibility
 * report.
 */
export function myShare(expense: Expense): number {
  return !isSplit(expense) ? expense.totalAmount : (meParticipant(expense)?.share ?? 0);
}

/** The portion of this expense other people are responsible for. Mirrors `Expense.othersShare`. */
export function othersShare(expense: Expense): number {
  return expense.totalAmount - myShare(expense);
}

/**
 * Whether a transaction linked to `expense` (`null` if no Expense document
 * exists yet) can still be turned into — or re-targeted as — a
 * split/assignment via `ExpenseRepository.convertToSplit`/`.convertToAssigned`.
 * Mirrors `Expense.canReassign`.
 */
export function canReassign(params: { expense: Expense | null; isExpenseTransaction: boolean }): boolean {
  return (params.expense == null || !isSplit(params.expense)) && params.isExpenseTransaction;
}

// --- Firestore converters ---

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

export function expenseFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Expense {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    description: data.description as string,
    totalAmount: (data.totalAmount as number),
    date: (data.date as Timestamp).toDate(),
    categoryId: data.categoryId as string,
    accountId: data.accountId as string,
    transactionId: data.transactionId as string,
    splitType: splitTypeFromName(data.splitType as string),
    participants: ((data.participants as Record<string, unknown>[] | undefined) ?? []).map(
      expenseParticipantFromMap,
    ),
    scheduleId: (data.scheduleId as string | undefined) ?? null,
    notes: (data.notes as string | undefined) ?? "",
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function expenseToFirestore(expense: Expense): DocumentData {
  return {
    description: expense.description,
    totalAmount: expense.totalAmount,
    date: Timestamp.fromDate(expense.date),
    categoryId: expense.categoryId,
    accountId: expense.accountId,
    transactionId: expense.transactionId,
    splitType: expense.splitType,
    participants: expense.participants.map(expenseParticipantToMap),
    scheduleId: expense.scheduleId,
    notes: expense.notes,
    createdAt: Timestamp.fromDate(expense.createdAt),
    deletedAt: expense.deletedAt == null ? null : Timestamp.fromDate(expense.deletedAt),
    lastEditedAt: expense.lastEditedAt == null ? null : Timestamp.fromDate(expense.lastEditedAt),
    editHistory: expense.editHistory.map(auditEntryToMap),
  };
}
