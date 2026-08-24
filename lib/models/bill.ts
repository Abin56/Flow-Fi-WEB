/**
 * Direct port of `lib/features/bills/domain/{bill,bill_occurrence,
 * bill_recurrence,bill_status,payment_record}.dart`. Field names, Firestore
 * document shape, and derived-field semantics must stay identical to the
 * Flutter models — both apps read/write the same `users/{uid}/bills/{billId}`,
 * `.../bills/{billId}/occurrences/{occurrenceId}`, and
 * `.../bills/{billId}/payments/{paymentId}` documents.
 *
 * Note on `bill_reminder.dart`: `BillReminder` is a pure calculator over a
 * due date and a set of offsets (days-until-due, "is a reminder due today",
 * offset labels) used to drive local-notification scheduling
 * (`ReminderNotificationService`) — it has no Firestore representation of
 * its own and is never stored. Only its input, `Bill.reminderOffsets`, is a
 * stored field (ported below). The calculator itself is intentionally not
 * ported here since there is no web notification-scheduling feature yet.
 *
 * Note on `bill_occurrence_cycle_item.dart`: `BillOccurrenceCycleItem` is a
 * view-only adapter (never persisted) onto the shared cycle-engine
 * (`lib/engines/cycle-engine.ts`) — a UI/engine concern, not a Firestore
 * model, so it is out of scope for this model/repository port.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

// --- BillRecurrence (bill_recurrence.dart) ---

export type BillRecurrence = "oneTime" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

const BILL_RECURRENCES: BillRecurrence[] = ["oneTime", "daily", "weekly", "monthly", "yearly", "custom"];

/** Mirrors `BillRecurrenceX.fromName` — unrecognized names fall back to "oneTime". */
export function billRecurrenceFromName(name: string): BillRecurrence {
  return (BILL_RECURRENCES as string[]).includes(name) ? (name as BillRecurrence) : "oneTime";
}

/**
 * Mirrors `BillRecurrenceX.nextDueDate`. `customDays` is required (and only
 * meaningful) for "custom". Month/year addition clamps to the target month's
 * last valid day (e.g. Jan 31 monthly -> Feb 28/29, never rolls into March).
 */
export function billRecurrenceNextDueDate(
  recurrence: BillRecurrence,
  current: Date,
  customDays?: number | null,
): Date {
  switch (recurrence) {
    case "oneTime":
      return current;
    case "daily":
      return addDays(current, 1);
    case "weekly":
      return addDays(current, 7);
    case "monthly":
      return addMonths(current, 1);
    case "yearly":
      return addMonths(current, 12);
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

// --- BillStatus (bill_status.dart) ---

/**
 * A `BillOccurrence`'s current standing — never stored, always computed by
 * `billOccurrenceStatus` (mirrors `isCreditor`/`isDebtor` being derived from
 * balance sign rather than persisted).
 */
export type BillStatus = "paid" | "partiallyPaid" | "skipped" | "overdue" | "dueToday" | "upcoming";

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// --- Bill (bill.dart) ---

/**
 * A recurring or one-time payment obligation's template — rent, a
 * subscription, a utility bill. Describes what occurrence to materialize
 * next (`nextDueDate`/`amount`/`recurrence`); the occurrence itself (due
 * date, progress, paid/skipped state) lives in its own immutable
 * `BillOccurrence` document, one per billing cycle (see
 * `BillOccurrenceRepository`). This template is never mutated by a payment
 * or rollover — only `BillRepository.editBill` changes it, and only
 * `BillOccurrenceRepository` advances `nextDueDate` once a new occurrence is
 * materialized.
 */
export interface Bill extends SoftDeletableEntity {
  name: string;
  amount: number;
  /**
   * The due date the next `BillOccurrence` should be materialized at —
   * advanced by `BillOccurrenceRepository` each time a new occurrence is
   * created from this template, never by a payment or edit directly.
   */
  nextDueDate: Date;
  recurrence: BillRecurrence;
  accountId: string | null;
  categoryId: string | null;
  /** Only meaningful (and required by `BillRepository.createBill`) when `recurrence` is "custom". */
  customIntervalDays: number | null;
  /**
   * Days-before-due to fire a reminder — e.g. `[0, 1, 3, 7]` for
   * Today/Tomorrow/3-days-before/7-days-before. Empty means no reminders.
   */
  reminderOffsets: number[];
  notes: string;
  createdAt: Date;
}

// --- BillOccurrence (bill_occurrence.dart) ---

/**
 * One billing cycle of a `Bill` — a single due date, its own amount
 * snapshot, and its own paid/skipped progress. Immutable once its status
 * becomes "paid" or "skipped": nothing after that point writes to
 * `amountPaid`/`isSkipped`/`dueDate` again, mirroring how a closed
 * `Statement` is never rewritten once materialized. A `Bill` template only
 * ever describes what occurrence to materialize next
 * (`Bill.nextDueDate`/`Bill.amount`) — it never holds "the current"
 * occurrence's progress itself.
 */
export interface BillOccurrence extends SoftDeletableEntity {
  /** The `Bill` template this occurrence belongs to. */
  billId: string;
  dueDate: Date;
  /**
   * Snapshot of the template's `amount` at the moment this occurrence was
   * materialized — later edits to `Bill.amount` never change an already
   * materialized occurrence.
   */
  amount: number;
  /**
   * Cumulative payments applied to this occurrence. The `payments`
   * subcollection (scoped by `PaymentRecord.occurrenceId`) is the source of
   * truth; this is a read optimization kept in sync by
   * `BillOccurrenceRepository.applyPayment` — same "cached, subcollection is
   * truth" pattern as `Bill.amountPaid` used to be.
   */
  amountPaid: number;
  isSkipped: boolean;
  createdAt: Date;
}

/** Mirrors `BillOccurrence.status`. */
export function billOccurrenceStatus(occurrence: BillOccurrence, now: Date = new Date()): BillStatus {
  if (occurrence.amountPaid >= occurrence.amount) return "paid";
  if (occurrence.isSkipped) return "skipped";
  if (occurrence.amountPaid > 0) return "partiallyPaid";

  const today = dateOnly(now);
  const due = dateOnly(occurrence.dueDate);
  if (due.getTime() < today.getTime()) return "overdue";
  if (due.getTime() === today.getTime()) return "dueToday";
  return "upcoming";
}

/** Mirrors `BillOccurrence.remainingAmount`. */
export function billOccurrenceRemainingAmount(occurrence: BillOccurrence): number {
  const remaining = occurrence.amount - occurrence.amountPaid;
  return Math.min(Math.max(remaining, 0), occurrence.amount);
}

// --- PaymentRecord (payment_record.dart) ---

/**
 * A single payment applied toward a `Bill`'s occurrence. Append-only like
 * `LedgerEntry` — soft-delete (which reverses its effect on
 * `BillOccurrence.amountPaid`) and restore are the only ways its effect
 * changes.
 */
export interface PaymentRecord extends SoftDeletableEntity {
  billId: string;
  /**
   * Which `BillOccurrence` this payment paid down. Nullable only for
   * records written before this field existed — backfilled the first time
   * their bill is read post-migration (see
   * `BillOccurrenceRepository.ensureCurrentOccurrence`). Every payment
   * recorded going forward always sets this.
   */
  occurrenceId: string | null;
  /** Always positive — payments only ever add toward `BillOccurrence.amountPaid`. */
  amount: number;
  date: Date;
  note: string;
  createdAt: Date;
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

export function billFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Bill {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name as string,
    amount: data.amount as number,
    // Legacy documents (written before the one-occurrence-per-cycle
    // migration) never wrote `nextDueDate` — they only ever had `dueDate`,
    // which described the same "when's the next occurrence" concept under
    // the old single-document model. Falling back to it here means a legacy
    // Bill parses correctly forever, with no forced rewrite — see
    // `BillOccurrenceRepository.ensureCurrentOccurrence` for the one-time
    // adoption of the rest of that legacy state.
    nextDueDate: ((data.nextDueDate as Timestamp | undefined) ?? (data.dueDate as Timestamp)).toDate(),
    recurrence: billRecurrenceFromName(data.recurrence as string),
    accountId: (data.accountId as string | undefined) ?? null,
    categoryId: (data.categoryId as string | undefined) ?? null,
    customIntervalDays: (data.customIntervalDays as number | undefined) ?? null,
    reminderOffsets: (data.reminderOffsets as number[] | undefined) ?? [],
    notes: (data.notes as string | undefined) ?? "",
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function billToFirestore(bill: Bill): DocumentData {
  return {
    name: bill.name,
    amount: bill.amount,
    nextDueDate: Timestamp.fromDate(bill.nextDueDate),
    recurrence: bill.recurrence,
    accountId: bill.accountId,
    categoryId: bill.categoryId,
    customIntervalDays: bill.customIntervalDays,
    reminderOffsets: bill.reminderOffsets,
    notes: bill.notes,
    createdAt: Timestamp.fromDate(bill.createdAt),
    deletedAt: bill.deletedAt == null ? null : Timestamp.fromDate(bill.deletedAt),
    lastEditedAt: bill.lastEditedAt == null ? null : Timestamp.fromDate(bill.lastEditedAt),
    editHistory: bill.editHistory.map(auditEntryToMap),
  };
}

export function billOccurrenceFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): BillOccurrence {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    billId: data.billId as string,
    dueDate: (data.dueDate as Timestamp).toDate(),
    amount: data.amount as number,
    amountPaid: (data.amountPaid as number | undefined) ?? 0,
    isSkipped: (data.isSkipped as boolean | undefined) ?? false,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function billOccurrenceToFirestore(occurrence: BillOccurrence): DocumentData {
  return {
    billId: occurrence.billId,
    dueDate: Timestamp.fromDate(occurrence.dueDate),
    amount: occurrence.amount,
    amountPaid: occurrence.amountPaid,
    isSkipped: occurrence.isSkipped,
    createdAt: Timestamp.fromDate(occurrence.createdAt),
    deletedAt: occurrence.deletedAt == null ? null : Timestamp.fromDate(occurrence.deletedAt),
    lastEditedAt: occurrence.lastEditedAt == null ? null : Timestamp.fromDate(occurrence.lastEditedAt),
    editHistory: occurrence.editHistory.map(auditEntryToMap),
  };
}

export function paymentRecordFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): PaymentRecord {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    billId: data.billId as string,
    amount: data.amount as number,
    date: (data.date as Timestamp).toDate(),
    note: (data.note as string | undefined) ?? "",
    occurrenceId: (data.occurrenceId as string | undefined) ?? null,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function paymentRecordToFirestore(payment: PaymentRecord): DocumentData {
  return {
    billId: payment.billId,
    amount: payment.amount,
    date: Timestamp.fromDate(payment.date),
    note: payment.note,
    occurrenceId: payment.occurrenceId,
    createdAt: Timestamp.fromDate(payment.createdAt),
    deletedAt: payment.deletedAt == null ? null : Timestamp.fromDate(payment.deletedAt),
    lastEditedAt: payment.lastEditedAt == null ? null : Timestamp.fromDate(payment.lastEditedAt),
    editHistory: payment.editHistory.map(auditEntryToMap),
  };
}
