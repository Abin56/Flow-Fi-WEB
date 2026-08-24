/**
 * Direct port of
 * `lib/core/payment_schedule/domain/{payment_schedule,installment,
 * installment_payment,schedule_type,owner_type,installment_status}.dart`.
 * Field names, Firestore document shape, and computed getters must stay
 * identical to the Flutter model — both apps read/write the same documents
 * under `users/{uid}/paymentSchedules/{scheduleId}/installments/{installmentId}/payments/{paymentId}`.
 *
 * Note: `cycle_engine.dart`/`cycle_anchor.dart`/`cycle_period.dart`/
 * `cycle_item.dart` are ported separately (`lib/engines/cycle-engine.ts`) —
 * not part of this file.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

// --- OwnerType (owner_type.dart) ---

export type OwnerType = "loan" | "emi" | "splitExpense" | "bill";

const OWNER_TYPES: OwnerType[] = ["loan", "emi", "splitExpense", "bill"];

/** Mirrors `OwnerTypeX.fromName` — unrecognized names fall back to "loan". */
export function ownerTypeFromName(name: string): OwnerType {
  return (OWNER_TYPES as string[]).includes(name) ? (name as OwnerType) : "loan";
}

// --- ScheduleType (schedule_type.dart) ---

export type ScheduleType = "oneTime" | "weekly" | "monthly" | "custom";

const SCHEDULE_TYPES: ScheduleType[] = ["oneTime", "weekly", "monthly", "custom"];

/** Mirrors `ScheduleTypeX.fromName` — unrecognized names fall back to "oneTime". */
export function scheduleTypeFromName(name: string): ScheduleType {
  return (SCHEDULE_TYPES as string[]).includes(name) ? (name as ScheduleType) : "oneTime";
}

/**
 * Mirrors `ScheduleTypeX.nextDueDate`. `customDays` is required (and only
 * meaningful) for "custom". Month addition clamps to the target month's
 * last valid day (e.g. Jan 31 monthly -> Feb 28/29, never rolls into March).
 */
export function nextDueDate(scheduleType: ScheduleType, current: Date, customDays?: number | null): Date {
  switch (scheduleType) {
    case "oneTime":
      return current;
    case "weekly":
      return addDays(current, 7);
    case "monthly":
      return addMonths(current, 1);
    case "custom":
      return addDays(current, customDays ?? 1);
  }
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  const targetMonthIndex = date.getMonth() + months;
  const targetYear = date.getFullYear() + Math.trunc(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const targetDay = date.getDate() > lastDayOfTargetMonth ? lastDayOfTargetMonth : date.getDate();
  return new Date(targetYear, targetMonth, targetDay, date.getHours(), date.getMinutes(), date.getSeconds());
}

// --- InstallmentStatus (installment_status.dart) ---

export type InstallmentStatus = "paid" | "partiallyPaid" | "skipped" | "overdue" | "upcoming";

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// --- PaymentSchedule (payment_schedule.dart) ---

export interface PaymentSchedule extends SoftDeletableEntity {
  ownerType: OwnerType;
  ownerId: string;
  totalAmount: number;
  scheduleType: ScheduleType;
  /**
   * The first (or only) installment's due date — not the owning entity's
   * origination/disbursement date, which the owner (e.g. `Loan.loanDate`)
   * tracks separately.
   */
  firstDueDate: Date;
  /** Only meaningful when `scheduleType` is "custom". */
  customIntervalDays: number | null;
  /**
   * Number of installments to generate. Null means open-ended/rolling —
   * not used by Lending; reserved for a future recurring-schedule owner.
   */
  installmentCount: number | null;
  notes: string;
  createdAt: Date;
}

/** Mirrors `PaymentSchedule.isFixedCount`. */
export function isFixedCount(schedule: PaymentSchedule): boolean {
  return schedule.installmentCount != null;
}

// --- Installment (installment.dart) ---

export interface Installment extends SoftDeletableEntity {
  scheduleId: string;
  /**
   * Denormalized from the owning `PaymentSchedule` so a future cross-owner
   * query doesn't need an extra read per installment.
   */
  ownerType: OwnerType;
  ownerId: string;
  /** 1-based position within the schedule, for display/ordering. */
  sequenceNumber: number;
  dueDate: Date;
  amountDue: number;
  amountPaid: number;
  isSkipped: boolean;
  /**
   * Only populated when the owning schedule carries interest (currently:
   * interest-bearing Loans). Null for Bills, split expenses, and
   * non-interest loans.
   */
  principalPortion: number | null;
  interestPortion: number | null;
  createdAt: Date;
}

/** Mirrors `Installment.remainingAmount`. */
export function remainingAmount(installment: Installment): number {
  const remaining = installment.amountDue - installment.amountPaid;
  return Math.min(Math.max(remaining, 0), installment.amountDue);
}

/** Mirrors `Installment.status`. */
export function installmentStatus(installment: Installment, now: Date = new Date()): InstallmentStatus {
  if (installment.amountPaid >= installment.amountDue) return "paid";
  if (installment.isSkipped) return "skipped";
  if (installment.amountPaid > 0) return "partiallyPaid";

  const today = dateOnly(now);
  if (dateOnly(installment.dueDate).getTime() < today.getTime()) return "overdue";
  return "upcoming";
}

// --- InstallmentPayment (installment_payment.dart) ---

export interface InstallmentPayment extends SoftDeletableEntity {
  installmentId: string;
  /**
   * Denormalized so a schedule-wide "full payment history" query doesn't
   * need to fan out per-installment.
   */
  scheduleId: string;
  ownerType: OwnerType;
  ownerId: string;
  /** Always positive — payments only ever add toward `Installment.amountPaid`. */
  amount: number;
  date: Date;
  note: string;
  createdAt: Date;
  /**
   * How this payment was made (e.g. "Cash", "UPI", "Bank Transfer") —
   * nullable free-text, only meaningfully populated for split-expense
   * settlements today; other owner types never set it.
   */
  settlementMethod: string | null;
  /**
   * Display label (e.g. "Jul 2026") for the billing cycle this payment was
   * recorded in, per `CycleAnchor` — nullable, computed at write time by
   * the caller.
   */
  billingCycleLabel: string | null;
  /**
   * This installment's `remainingAmount` immediately after this payment was
   * applied — nullable, filled at write time from the installment already
   * in hand.
   */
  remainingBalanceAfterPayment: number | null;
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

export function paymentScheduleFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): PaymentSchedule {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ownerType: ownerTypeFromName(data.ownerType as string),
    ownerId: data.ownerId as string,
    totalAmount: (data.totalAmount as number),
    scheduleType: scheduleTypeFromName(data.scheduleType as string),
    firstDueDate: (data.firstDueDate as Timestamp).toDate(),
    customIntervalDays: (data.customIntervalDays as number | undefined) ?? null,
    installmentCount: (data.installmentCount as number | undefined) ?? null,
    notes: (data.notes as string | undefined) ?? "",
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function paymentScheduleToFirestore(schedule: PaymentSchedule): DocumentData {
  return {
    ownerType: schedule.ownerType,
    ownerId: schedule.ownerId,
    totalAmount: schedule.totalAmount,
    scheduleType: schedule.scheduleType,
    firstDueDate: Timestamp.fromDate(schedule.firstDueDate),
    customIntervalDays: schedule.customIntervalDays,
    installmentCount: schedule.installmentCount,
    notes: schedule.notes,
    createdAt: Timestamp.fromDate(schedule.createdAt),
    deletedAt: schedule.deletedAt == null ? null : Timestamp.fromDate(schedule.deletedAt),
    lastEditedAt: schedule.lastEditedAt == null ? null : Timestamp.fromDate(schedule.lastEditedAt),
    editHistory: schedule.editHistory.map(auditEntryToMap),
  };
}

export function installmentFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Installment {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    scheduleId: data.scheduleId as string,
    ownerType: ownerTypeFromName(data.ownerType as string),
    ownerId: data.ownerId as string,
    sequenceNumber: (data.sequenceNumber as number),
    dueDate: (data.dueDate as Timestamp).toDate(),
    amountDue: (data.amountDue as number),
    amountPaid: (data.amountPaid as number | undefined) ?? 0,
    isSkipped: (data.isSkipped as boolean | undefined) ?? false,
    principalPortion: (data.principalPortion as number | undefined) ?? null,
    interestPortion: (data.interestPortion as number | undefined) ?? null,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function installmentToFirestore(installment: Installment): DocumentData {
  return {
    scheduleId: installment.scheduleId,
    ownerType: installment.ownerType,
    ownerId: installment.ownerId,
    sequenceNumber: installment.sequenceNumber,
    dueDate: Timestamp.fromDate(installment.dueDate),
    amountDue: installment.amountDue,
    amountPaid: installment.amountPaid,
    isSkipped: installment.isSkipped,
    principalPortion: installment.principalPortion,
    interestPortion: installment.interestPortion,
    createdAt: Timestamp.fromDate(installment.createdAt),
    deletedAt: installment.deletedAt == null ? null : Timestamp.fromDate(installment.deletedAt),
    lastEditedAt: installment.lastEditedAt == null ? null : Timestamp.fromDate(installment.lastEditedAt),
    editHistory: installment.editHistory.map(auditEntryToMap),
  };
}

export function installmentPaymentFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): InstallmentPayment {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    installmentId: data.installmentId as string,
    scheduleId: data.scheduleId as string,
    ownerType: ownerTypeFromName(data.ownerType as string),
    ownerId: data.ownerId as string,
    amount: (data.amount as number),
    date: (data.date as Timestamp).toDate(),
    note: (data.note as string | undefined) ?? "",
    createdAt: (data.createdAt as Timestamp).toDate(),
    settlementMethod: (data.settlementMethod as string | undefined) ?? null,
    billingCycleLabel: (data.billingCycleLabel as string | undefined) ?? null,
    remainingBalanceAfterPayment: (data.remainingBalanceAfterPayment as number | undefined) ?? null,
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function installmentPaymentToFirestore(payment: InstallmentPayment): DocumentData {
  return {
    installmentId: payment.installmentId,
    scheduleId: payment.scheduleId,
    ownerType: payment.ownerType,
    ownerId: payment.ownerId,
    amount: payment.amount,
    date: Timestamp.fromDate(payment.date),
    note: payment.note,
    createdAt: Timestamp.fromDate(payment.createdAt),
    settlementMethod: payment.settlementMethod,
    billingCycleLabel: payment.billingCycleLabel,
    remainingBalanceAfterPayment: payment.remainingBalanceAfterPayment,
    deletedAt: payment.deletedAt == null ? null : Timestamp.fromDate(payment.deletedAt),
    lastEditedAt: payment.lastEditedAt == null ? null : Timestamp.fromDate(payment.lastEditedAt),
    editHistory: payment.editHistory.map(auditEntryToMap),
  };
}
