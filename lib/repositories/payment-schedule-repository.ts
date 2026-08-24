/**
 * Direct port of
 * `lib/core/payment_schedule/data/{payment_schedule_repository,
 * installment_repository,installment_payment_repository}.dart`.
 * Schedule/installment/payment persistence on top of the generic
 * CRUD/soft-delete repository — same validation, same audit-trail edit
 * semantics, same amortization-agnostic contract the Lending layer depends
 * on (this file never computes interest itself — see
 * `lib/engines/interest-calculator.ts`).
 */

import type { CollectionReference } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import {
  type Installment,
  type InstallmentPayment,
  installmentStatus,
  type OwnerType,
  type PaymentSchedule,
  type ScheduleType,
  nextDueDate,
  remainingAmount,
} from "@/lib/models/payment-schedule";
import { generateId } from "@/lib/utils/id-generator";

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday-start week, mirroring `DateExtensions.startOfWeek`/`endOfWeek`. */
function startOfWeek(d: Date): Date {
  const weekday = d.getDay() === 0 ? 7 : d.getDay(); // Dart weekday: Mon=1..Sun=7
  const start = new Date(d);
  start.setDate(start.getDate() - (weekday - 1));
  return dateOnly(start);
}

function endOfWeek(d: Date): Date {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 0);
  return end;
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// --- PrecomputedInstallmentAmount (precomputed_installment_amount.dart) ---

export interface PrecomputedInstallmentAmount {
  amountDue: number;
  principalPortion?: number | null;
  interestPortion?: number | null;
}

// --- PaymentScheduleRepository (payment_schedule_repository.dart) ---

export interface CreateScheduleParams {
  ownerType: OwnerType;
  ownerId: string;
  totalAmount: number;
  scheduleType: ScheduleType;
  firstDueDate: Date;
  customIntervalDays?: number | null;
  installmentCount?: number | null;
  notes?: string;
}

export interface EditScheduleParams {
  totalAmount?: number;
  firstDueDate?: Date;
  notes?: string;
  installmentCount?: number;
}

export class PaymentScheduleRepository extends FirestoreCrudRepository<PaymentSchedule> {
  constructor(collection: CollectionReference<PaymentSchedule>) {
    super(collection);
  }

  async createSchedule(params: CreateScheduleParams): Promise<PaymentSchedule> {
    if (params.totalAmount <= 0) {
      throw new Error("Total amount must be greater than 0");
    }
    if (
      params.scheduleType === "custom" &&
      (params.customIntervalDays == null || params.customIntervalDays <= 0)
    ) {
      throw new Error("Custom schedules need a repeat interval greater than 0 days");
    }

    const schedule: PaymentSchedule = {
      id: generateId(),
      ownerType: params.ownerType,
      ownerId: params.ownerId,
      totalAmount: params.totalAmount,
      scheduleType: params.scheduleType,
      firstDueDate: params.firstDueDate,
      customIntervalDays: params.scheduleType === "custom" ? (params.customIntervalDays ?? null) : null,
      installmentCount: params.installmentCount ?? null,
      notes: params.notes ?? "",
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(schedule.id, schedule);
    return schedule;
  }

  async editSchedule(schedule: PaymentSchedule, params: EditScheduleParams): Promise<void> {
    if (params.totalAmount != null && params.totalAmount <= 0) {
      throw new Error("Total amount must be greater than 0");
    }
    if (params.installmentCount != null && params.installmentCount < 1) {
      throw new Error("Schedule needs at least 1 installment");
    }

    let updated = schedule;
    updated = updateField(updated, "totalAmount", updated.totalAmount, params.totalAmount, (e, v) => ({
      ...e,
      totalAmount: v,
    }));
    updated = updateField(updated, "firstDueDate", updated.firstDueDate, params.firstDueDate, (e, v) => ({
      ...e,
      firstDueDate: v,
    }));
    updated = updateField(updated, "notes", updated.notes, params.notes, (e, v) => ({ ...e, notes: v }));
    updated = updateField(
      updated,
      "installmentCount",
      updated.installmentCount,
      params.installmentCount,
      (e, v) => ({ ...e, installmentCount: v }),
    );

    await this.update(updated);
  }
}

// --- InstallmentRepository (installment_repository.dart) ---

export interface GenerateInstallmentsOptions {
  precomputedAmounts?: PrecomputedInstallmentAmount[];
  startingSequenceNumber?: number;
  dueDayOfMonth?: number;
}

export class InstallmentRepository extends FirestoreCrudRepository<Installment> {
  constructor(collection: CollectionReference<Installment>) {
    super(collection);
  }

  /**
   * Materializes `schedule`'s installments. When `precomputedAmounts` is
   * omitted, `schedule.totalAmount` is split evenly across
   * `schedule.installmentCount` with the last installment absorbing the
   * rounding remainder. When provided, its length must equal
   * `schedule.installmentCount` and each entry supplies that installment's
   * exact amountDue plus optional principal/interest split.
   *
   * `startingSequenceNumber` offsets every generated installment's
   * `sequenceNumber` (default 0, i.e. numbering starts at 1).
   *
   * `dueDayOfMonth` (1-31), when set on a "monthly" schedule, pins every
   * installment *after* the first to that fixed day of the month —
   * installment #1 always stays exactly on `schedule.firstDueDate`
   * regardless of its own day. Ignored for every other scheduleType and
   * when omitted (the default), in which case each date chains off the
   * previous installment's via `nextDueDate`.
   */
  async generateInstallments(
    schedule: PaymentSchedule,
    options: GenerateInstallmentsOptions = {},
  ): Promise<Installment[]> {
    const { precomputedAmounts, startingSequenceNumber = 0, dueDayOfMonth } = options;

    const count = schedule.installmentCount;
    if (count == null || count < 1) {
      throw new Error("Schedule needs at least 1 installment to generate");
    }
    if (precomputedAmounts != null && precomputedAmounts.length !== count) {
      throw new Error("precomputedAmounts must have one entry per installment");
    }

    const amounts = precomputedAmounts ?? this.evenSplit(schedule.totalAmount, count);
    const pinToDueDay = dueDayOfMonth != null && schedule.scheduleType === "monthly";

    const installments: Installment[] = [];
    let dueDate = schedule.firstDueDate;
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        dueDate = pinToDueDay
          ? this.addMonthsTargetingDay(schedule.firstDueDate, i, dueDayOfMonth!)
          : nextDueDate(schedule.scheduleType, dueDate, schedule.customIntervalDays);
      }
      const installment: Installment = {
        id: generateId(),
        scheduleId: schedule.id,
        ownerType: schedule.ownerType,
        ownerId: schedule.ownerId,
        sequenceNumber: startingSequenceNumber + i + 1,
        dueDate,
        amountDue: amounts[i].amountDue,
        amountPaid: 0,
        isSkipped: false,
        principalPortion: amounts[i].principalPortion ?? null,
        interestPortion: amounts[i].interestPortion ?? null,
        createdAt: new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      await this.add(installment.id, installment);
      installments.push(installment);
    }
    return installments;
  }

  private addMonthsTargetingDay(firstDueDate: Date, monthsAhead: number, targetDay: number): Date {
    const targetMonthIndex = firstDueDate.getMonth() + monthsAhead;
    const targetYear = firstDueDate.getFullYear() + Math.trunc(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
    const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
    const day = targetDay > lastDayOfTargetMonth ? lastDayOfTargetMonth : targetDay;
    return new Date(
      targetYear,
      targetMonth,
      day,
      firstDueDate.getHours(),
      firstDueDate.getMinutes(),
      firstDueDate.getSeconds(),
    );
  }

  private evenSplit(total: number, count: number): PrecomputedInstallmentAmount[] {
    const share = round2(total / count);
    const shares = new Array(count).fill(share);
    const remainder = round2(total - share * count);
    shares[count - 1] = round2(shares[count - 1] + remainder);
    return shares.map((amountDue: number) => ({ amountDue }));
  }

  /**
   * Applies a payment delta toward this installment, clamped so
   * `amountPaid` never exceeds `amountDue`.
   */
  async applyPayment(installment: Installment, delta: number): Promise<void> {
    if (delta === 0) return;
    const newAmountPaid = clamp(installment.amountPaid + delta, 0, installment.amountDue);
    let updated = recordEdit(installment, "amountPaid", String(installment.amountPaid), String(newAmountPaid));
    updated = { ...updated, amountPaid: newAmountPaid };
    await this.update(updated);
  }

  /**
   * Changes how much is owed on `installment` — used when editing a split
   * expense's amount/shares after the fact. Guards against setting the new
   * amount below what's already been collected.
   */
  async editInstallmentAmount(installment: Installment, newAmountDue: number): Promise<void> {
    if (newAmountDue < installment.amountPaid) {
      throw new Error("Cannot set an amount lower than what has already been paid");
    }
    if (newAmountDue === installment.amountDue) return;
    let updated = recordEdit(
      installment,
      "amountDue",
      String(installment.amountDue),
      String(newAmountDue),
    );
    updated = { ...updated, amountDue: newAmountDue };
    await this.update(updated);
  }

  /** Changes when `installment` is due — used when editing a split expense's due date after the fact. */
  async editInstallmentDueDate(installment: Installment, newDueDate: Date): Promise<void> {
    if (newDueDate.getTime() === installment.dueDate.getTime()) return;
    let updated = recordEdit(
      installment,
      "dueDate",
      installment.dueDate.toISOString(),
      newDueDate.toISOString(),
    );
    updated = { ...updated, dueDate: newDueDate };
    await this.update(updated);
  }

  async skipInstallment(installment: Installment): Promise<void> {
    if (installment.isSkipped) return;
    let updated = recordEdit(installment, "isSkipped", "false", "true");
    updated = { ...updated, isSkipped: true };
    await this.update(updated);
  }

  async unskipInstallment(installment: Installment): Promise<void> {
    if (!installment.isSkipped) return;
    let updated = recordEdit(installment, "isSkipped", "true", "false");
    updated = { ...updated, isSkipped: false };
    await this.update(updated);
  }

  /**
   * Early closure: soft-deletes every not-fully-paid installment in
   * `remaining` so they drop out of `getAll()`/`remainingAmount()`. Fully
   * paid installments are left untouched. Returns the installments that
   * were soft-deleted.
   */
  async closeOutRemaining(remaining: Installment[]): Promise<Installment[]> {
    const toClose = remaining.filter((i) => installmentStatus(i) !== "paid");
    for (const installment of toClose) {
      await this.softDelete(installment);
    }
    return toClose;
  }

  /**
   * Soft-deletes every installment in `installments` with no payment
   * recorded against it at all (`amountPaid == 0`) — used to clear the
   * untouched tail of a schedule before regenerating it under new terms.
   */
  async replaceUnpaid(installments: Installment[]): Promise<Installment[]> {
    const untouched = installments.filter((i) => i.amountPaid === 0 && !i.isSkipped);
    for (const installment of untouched) {
      await this.softDelete(installment);
    }
    return untouched;
  }

  /** Installments due within the calendar week (Monday-Sunday) containing `now`. */
  thisWeek(all: Installment[], now: Date = new Date()): Installment[] {
    const start = startOfWeek(now);
    const end = endOfWeek(now);
    return all.filter((i) => i.dueDate.getTime() >= start.getTime() && i.dueDate.getTime() <= end.getTime());
  }

  /** Installments due within the calendar month containing `now`. */
  thisMonth(all: Installment[], now: Date = new Date()): Installment[] {
    return all.filter((i) => isSameMonth(i.dueDate, now));
  }

  /** Installments due within the calendar month immediately after `now`'s. */
  nextMonth(all: Installment[], now: Date = new Date()): Installment[] {
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return all.filter((i) => isSameMonth(i.dueDate, next));
  }

  /** Installments due strictly after `now`'s next calendar month (i.e. not this month, not next month). */
  future(all: Installment[], now: Date = new Date()): Installment[] {
    const endOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);
    return all.filter((i) => i.dueDate.getTime() > endOfNextMonth.getTime());
  }

  /** Installments currently overdue as of `now` (defaults to today). */
  overdue(all: Installment[], now: Date = new Date()): Installment[] {
    const today = dateOnly(now);
    return all.filter((i) => {
      if (i.amountPaid >= i.amountDue || i.isSkipped || i.amountPaid > 0) return false;
      return dateOnly(i.dueDate).getTime() < today.getTime();
    });
  }

  /** Sum of remaining amounts across non-skipped installments. */
  remainingAmount(all: Installment[]): number {
    return all
      .filter((i) => installmentStatus(i) !== "skipped")
      .reduce((total, i) => total + remainingAmount(i), 0);
  }
}

// --- InstallmentPaymentRepository (installment_payment_repository.dart) ---

export interface RecordPaymentParams {
  amount: number;
  date: Date;
  note?: string;
  settlementMethod?: string | null;
  billingCycleLabel?: string | null;
}

export class InstallmentPaymentRepository extends FirestoreCrudRepository<InstallmentPayment> {
  constructor(
    collection: CollectionReference<InstallmentPayment>,
    private readonly installmentRepository: InstallmentRepository,
  ) {
    super(collection);
  }

  /**
   * Records a payment and applies it toward the installment. Supports
   * partial payments (amount < remaining) and early/advance payments (date
   * before the installment's due date) with no special-case code.
   */
  async recordPayment(installment: Installment, params: RecordPaymentParams): Promise<InstallmentPayment> {
    if (params.amount <= 0) {
      throw new Error("Payment amount must be greater than 0");
    }

    const remainingAfter = clamp(remainingAmount(installment) - params.amount, 0, installment.amountDue);
    const payment: InstallmentPayment = {
      id: generateId(),
      installmentId: installment.id,
      scheduleId: installment.scheduleId,
      ownerType: installment.ownerType,
      ownerId: installment.ownerId,
      amount: params.amount,
      date: params.date,
      note: params.note ?? "",
      createdAt: new Date(),
      settlementMethod: params.settlementMethod ?? null,
      billingCycleLabel: params.billingCycleLabel ?? null,
      remainingBalanceAfterPayment: remainingAfter,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(payment.id, payment);
    await this.installmentRepository.applyPayment(installment, payment.amount);
    return payment;
  }

  /** Reverses the payment's effect, then soft-deletes it. */
  async softDeletePayment(installment: Installment, payment: InstallmentPayment): Promise<void> {
    await this.installmentRepository.applyPayment(installment, -payment.amount);
    await this.softDelete(payment);
  }

  /** Re-applies the payment's effect, then restores it. */
  async restorePayment(installment: Installment, payment: InstallmentPayment): Promise<void> {
    await this.installmentRepository.applyPayment(installment, payment.amount);
    await this.restore(payment);
  }

  /** No balance change — already reversed at soft-delete time. */
  async permanentlyDeletePayment(payment: InstallmentPayment): Promise<void> {
    await this.permanentlyDelete(payment);
  }
}
