/**
 * Direct port of `lib/features/budget/domain/{budget,budget_type}.dart`.
 * Field names, Firestore document shape, and defaults must stay identical
 * to the Flutter model — both apps read/write the same documents.
 *
 * An ongoing spending limit — daily, monthly, or monthly-per-category
 * (when `categoryId` is set). Holds only the limit amount; "used" and
 * "remaining" are always computed live from transactions in the current
 * period rather than stored here (see `lib/engines/budget-insight.ts`), so
 * a new day/month "resets" for free — there's nothing to reset.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

/**
 * Mirrors `BudgetType` — `daily` tracks a single day, `monthly` tracks a
 * calendar month. Category budgets reuse `monthly`; there is no separate
 * `category` enum value in Dart.
 */
export type BudgetType = "daily" | "monthly";

const BUDGET_TYPES: BudgetType[] = ["daily", "monthly"];

/** Mirrors `BudgetTypeX.fromName` — unrecognized names fall back to "monthly". */
export function budgetTypeFromName(name: string): BudgetType {
  return (BUDGET_TYPES as string[]).includes(name) ? (name as BudgetType) : "monthly";
}

/** Mirrors `BudgetTypeX.label`. */
export function budgetTypeLabel(type: BudgetType): string {
  switch (type) {
    case "daily":
      return "Daily";
    case "monthly":
      return "Monthly";
  }
}

export interface Budget extends SoftDeletableEntity {
  type: BudgetType;
  amount: number;
  /** Null for a plain daily/monthly budget; set for a per-category budget. */
  categoryId: string | null;
  createdAt: Date;
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

export function budgetFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Budget {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    type: budgetTypeFromName(data.type as string),
    amount: (data.amount as number),
    categoryId: (data.categoryId as string | undefined) ?? null,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function budgetToFirestore(budget: Budget): DocumentData {
  return {
    type: budget.type,
    amount: budget.amount,
    categoryId: budget.categoryId,
    createdAt: Timestamp.fromDate(budget.createdAt),
    deletedAt: budget.deletedAt == null ? null : Timestamp.fromDate(budget.deletedAt),
    lastEditedAt: budget.lastEditedAt == null ? null : Timestamp.fromDate(budget.lastEditedAt),
    editHistory: budget.editHistory.map(auditEntryToMap),
  };
}
