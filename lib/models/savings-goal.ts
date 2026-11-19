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
  /**
   * Web-only, additive (absent on documents the mobile app wrote — read with safe fallbacks).
   *
   * `openingAmount` — money that was already on the goal before it had a contribution history (a goal made
   * by the mobile app, whose `currentAmount` was typed in). Saved money = openingAmount + the goal's
   * contribution entries (see `lib/engines/savings-goals.ts`); `currentAmount` is then only a cache kept for
   * the mobile app, never the source of truth on the web.
   */
  openingAmount: number;
  /** Lucide-style icon key + accent token for the goal card. Purely cosmetic. */
  icon: string | null;
  accent: string | null;
  /** Set by "Mark completed" below the target — a goal the user closed early (so it is not flagged as slipped). */
  closedEarly: boolean;
  completedAt: Date | null;
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
    // Additive web-only fields: a document the mobile app wrote has none. `openingAmount` falls back to
    // `currentAmount` only while the goal has never been written by the web (no `openingAmount` key at all).
    openingAmount: typeof data.openingAmount === "number" ? data.openingAmount : ((data.currentAmount as number) ?? 0),
    icon: (data.icon as string | undefined) ?? null,
    accent: (data.accent as string | undefined) ?? null,
    closedEarly: (data.closedEarly as boolean | undefined) ?? false,
    completedAt: (data.completedAt as Timestamp | undefined)?.toDate() ?? null,
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
    openingAmount: goal.openingAmount,
    icon: goal.icon,
    accent: goal.accent,
    closedEarly: goal.closedEarly,
    completedAt: goal.completedAt == null ? null : Timestamp.fromDate(goal.completedAt),
    deletedAt: goal.deletedAt == null ? null : Timestamp.fromDate(goal.deletedAt),
    lastEditedAt: goal.lastEditedAt == null ? null : Timestamp.fromDate(goal.lastEditedAt),
    editHistory: goal.editHistory.map(auditEntryToMap),
  };
}
