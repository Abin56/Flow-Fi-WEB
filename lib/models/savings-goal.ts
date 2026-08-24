/**
 * Direct port of `lib/features/savings/domain/savings_goal.dart`
 * (`SavingsGoal`). Field names, Firestore document shape, and computed
 * getters must stay identical to the Flutter model — both apps read/write
 * the same `users/{uid}/savingsGoals/{id}` documents.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

/**
 * A savings target the user is contributing toward over time — e.g. "New
 * laptop, ₹80,000 by December". `currentAmount` only ever moves via
 * `SavingsRepository.contribute`, so every change is captured in
 * `editHistory` (the "Goal History" requirement).
 */
export interface SavingsGoal extends SoftDeletableEntity {
  name: string;
  targetAmount: number;
  currentAmount: number;
  dueDate: Date | null;
  notes: string;
  isCompleted: boolean;
  isArchived: boolean;
  createdAt: Date;
}

/**
 * Mirrors `NumX.clampedProgress` applied to `currentAmount / targetAmount`
 * — clamped into a safe 0–1 range for progress indicators, avoiding
 * NaN/Infinity when `targetAmount` is 0.
 */
export function progress(goal: SavingsGoal): number {
  const ratio = goal.currentAmount / goal.targetAmount;
  if (Number.isNaN(ratio) || !Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
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

export function savingsGoalFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): SavingsGoal {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name as string,
    targetAmount: (data.targetAmount as number) ?? 0,
    currentAmount: (data.currentAmount as number) ?? 0,
    dueDate: (data.dueDate as Timestamp | undefined)?.toDate() ?? null,
    notes: (data.notes as string | undefined) ?? "",
    isCompleted: (data.isCompleted as boolean) ?? false,
    isArchived: (data.isArchived as boolean) ?? false,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function savingsGoalToFirestore(goal: SavingsGoal): DocumentData {
  return {
    name: goal.name,
    targetAmount: goal.targetAmount,
    currentAmount: goal.currentAmount,
    dueDate: goal.dueDate == null ? null : Timestamp.fromDate(goal.dueDate),
    notes: goal.notes,
    isCompleted: goal.isCompleted,
    isArchived: goal.isArchived,
    createdAt: Timestamp.fromDate(goal.createdAt),
    deletedAt: goal.deletedAt == null ? null : Timestamp.fromDate(goal.deletedAt),
    lastEditedAt: goal.lastEditedAt == null ? null : Timestamp.fromDate(goal.lastEditedAt),
    editHistory: goal.editHistory.map(auditEntryToMap),
  };
}
