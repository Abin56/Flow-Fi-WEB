/**
 * Direct port of `lib/features/emi/data/{emi_repository,
 * emi_payment_breakdown_repository}.dart` (`EmiRepository`,
 * `EmiPaymentBreakdownRepository`). EMI-specific persistence on top of the
 * generic CRUD/soft-delete repository. Bridges the feature-agnostic
 * `PaymentScheduleRepository`/`InstallmentRepository` (payment tracking) and
 * `calculate` (see `lib/engines/interest-calculator.ts`, interest math) —
 * neither of those core engines knows what an "EMI" is; this repository is
 * where the two are composed, mirroring `LoanRepository`
 * (`lib/repositories/loan-repository.ts`) almost exactly — EMI always
 * repays via installments (no one-time mode), and carries its own
 * lender/category metadata.
 *
 * Note: the Dart `EmiRepository` also schedules/cancels local push
 * notifications via `ReminderNotificationService` (best-effort,
 * fire-and-forget) on create/edit/close/delete — `_scheduleReminders`,
 * `_scheduleEndingReminder`, `_cancelReminders`, `_cancelEndingReminder`,
 * and the public `rescheduleReminders`. There is no web
 * notification-scheduling feature to port that call into (see the same
 * documented omission in `lib/repositories/bill-repository.ts`), so those
 * calls are simply not present here — every other side effect is ported.
 */

import {
  type CollectionReference,
  collection,
  doc,
  getDocs,
  writeBatch,
} from "firebase/firestore";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import { calculate, type InterestPeriodBreakdown } from "@/lib/engines/interest-calculator";
import type { Emi, EmiInterest, EmiLoanType, EmiPaymentBreakdown } from "@/lib/models/emi";
import { nextDueDate, type Installment, type PaymentSchedule, type ScheduleType } from "@/lib/models/payment-schedule";
import type {
  InstallmentRepository,
  PaymentScheduleRepository,
  PrecomputedInstallmentAmount,
} from "@/lib/repositories/payment-schedule-repository";
import { generateId } from "@/lib/utils/id-generator";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function precomputedFromPeriods(periods: InterestPeriodBreakdown[]): PrecomputedInstallmentAmount[] {
  return periods.map((p) => ({
    amountDue: p.paymentAmount,
    principalPortion: p.principalPortion,
    interestPortion: p.interestPortion,
  }));
}

/**
 * True per-installment count for `calculate`'s `installmentsPerYear` rate
 * normalization — weekly gets its own exact value (52) instead of being
 * forced through the monthly bucket, which previously overstated weekly
 * interest by ~4.3x. "custom" isn't offered by the EMI form, so 12
 * (monthly) is a safe placeholder if that ever changes; "oneTime" isn't a
 * valid EMI installment frequency but is included for exhaustiveness.
 */
function installmentsPerYearFor(scheduleType: ScheduleType): number {
  switch (scheduleType) {
    case "weekly":
      return 52;
    case "monthly":
    case "oneTime":
    case "custom":
      return 12;
  }
}

export interface CreateEmiParams {
  name: string;
  principalAmount: number;
  startDate: Date;
  installmentFrequency: ScheduleType;
  installmentCount: number;
  lenderName?: string | null;
  categoryId?: string | null;
  interest?: EmiInterest | null;
  notes?: string;
  loanNumber?: string | null;
  loanType?: EmiLoanType;
  branch?: string | null;
  customerId?: string | null;
  sanctionDate?: Date | null;
  disbursementDate?: Date | null;
  processingFee?: number;
  insuranceAmount?: number;
  extraCharges?: number;
  foreclosureAmount?: number | null;
  prepaymentCharges?: number | null;
  isAutoDebitEnabled?: boolean;
  autoDebitAccount?: string | null;
  linkedCreditCardId?: string | null;
  dueDayOfMonth?: number | null;
}

/**
 * `name`/`lenderName`/`categoryId`/`notes` and the bank/charges metadata
 * fields below are editable post-creation. `principalAmount` locks once
 * `hasPayments` is true (mirrors `LoanRepository.editLoan`'s posture).
 * `interest`/`installmentFrequency`/`installmentCount` are edited through
 * `editEmiTerms` instead, which regenerates the unpaid tail of the
 * schedule; `startDate` stays immutable here (it seeds the schedule's
 * `firstDueDate`, which only matters for the very first installment) — see
 * `editStartDate`.
 */
export interface EditEmiParams {
  hasPayments: boolean;
  name?: string;
  lenderName?: string | null;
  categoryId?: string | null;
  principalAmount?: number;
  notes?: string;
  loanNumber?: string | null;
  loanType?: EmiLoanType;
  branch?: string | null;
  customerId?: string | null;
  sanctionDate?: Date | null;
  disbursementDate?: Date | null;
  processingFee?: number;
  insuranceAmount?: number;
  extraCharges?: number;
  foreclosureAmount?: number | null;
  prepaymentCharges?: number | null;
  isAutoDebitEnabled?: boolean;
  autoDebitAccount?: string | null;
  linkedCreditCardId?: string | null;
  clearLinkedCreditCardId?: boolean;
}

export interface EditEmiTermsParams {
  currentInstallments: Installment[];
  interest?: EmiInterest | null;
  installmentFrequency?: ScheduleType;
  newInstallmentCount: number;
  dueDayOfMonth?: number | null;
}

export interface EditEmiStartDateParams {
  newStartDate: Date;
  hasPayments: boolean;
  currentInstallments: Installment[];
}

/**
 * EMI-specific persistence on top of the generic CRUD/soft-delete
 * repository. Bridges the feature-agnostic `PaymentScheduleRepository`/
 * `InstallmentRepository` (payment tracking) and `calculate` (interest
 * math) — neither of those core engines knows what an "EMI" is; this
 * repository is where the two are composed, mirroring `LoanRepository`.
 */
export class EmiRepository extends FirestoreCrudRepository<Emi> {
  constructor(
    collectionRef: CollectionReference<Emi>,
    private readonly paymentScheduleRepository: PaymentScheduleRepository,
    /**
     * Resolves an `InstallmentRepository` scoped to a given schedule id —
     * supplied by the provider layer, mirrors `LoanRepository`'s dependency
     * shape exactly.
     */
    private readonly installmentRepositoryFor: (scheduleId: string) => InstallmentRepository,
  ) {
    super(collectionRef);
  }

  async createEmi(params: CreateEmiParams): Promise<Emi> {
    const {
      name,
      principalAmount,
      startDate,
      installmentFrequency,
      installmentCount,
      lenderName = null,
      categoryId = null,
      interest = null,
      notes = "",
      loanNumber = null,
      loanType = "other",
      branch = null,
      customerId = null,
      sanctionDate = null,
      disbursementDate = null,
      processingFee = 0,
      insuranceAmount = 0,
      extraCharges = 0,
      foreclosureAmount = null,
      prepaymentCharges = null,
      isAutoDebitEnabled = false,
      autoDebitAccount = null,
      linkedCreditCardId = null,
      dueDayOfMonth = null,
    } = params;

    if (name.trim().length === 0) {
      throw new Error("EMI name is required");
    }
    if (principalAmount <= 0) {
      throw new Error("Principal amount must be greater than 0");
    }
    if (installmentCount < 1) {
      throw new Error("EMI needs at least 1 installment");
    }
    if (interest != null && interest.ratePercent < 0) {
      throw new Error("Interest rate cannot be negative");
    }
    if (dueDayOfMonth != null && (dueDayOfMonth < 1 || dueDayOfMonth > 31)) {
      throw new Error("Monthly due date must be between 1 and 31");
    }

    let precomputed: PrecomputedInstallmentAmount[] | undefined;
    if (interest != null) {
      const breakdown = calculate({
        principal: principalAmount,
        type: interest.type,
        ratePercent: interest.ratePercent,
        period: interest.period,
        installmentCount,
        installmentFrequency: "monthly",
        installmentsPerYear: installmentsPerYearFor(installmentFrequency),
      });
      precomputed = precomputedFromPeriods(breakdown.periods);
    }

    const emiId = generateId();
    const totalAmount = precomputed == null ? principalAmount : precomputed.reduce((sum, p) => sum + p.amountDue, 0);

    const schedule = await this.paymentScheduleRepository.createSchedule({
      ownerType: "emi",
      ownerId: emiId,
      totalAmount,
      scheduleType: installmentFrequency,
      firstDueDate: startDate,
      installmentCount,
    });

    const installments = await this.installmentRepositoryFor(schedule.id).generateInstallments(schedule, {
      precomputedAmounts: precomputed,
      dueDayOfMonth: dueDayOfMonth ?? undefined,
    });

    const emi: Emi = {
      id: emiId,
      name,
      lenderName,
      categoryId,
      principalAmount,
      interest,
      startDate,
      installmentFrequency,
      installmentCount,
      endDate: installments[installments.length - 1].dueDate,
      notes,
      scheduleId: schedule.id,
      createdAt: new Date(),
      loanNumber,
      loanType,
      branch,
      customerId,
      sanctionDate,
      disbursementDate,
      processingFee,
      insuranceAmount,
      extraCharges,
      foreclosureAmount,
      prepaymentCharges,
      isAutoDebitEnabled,
      autoDebitAccount,
      isDefaulted: false,
      linkedCreditCardId,
      dueDayOfMonth,
      isClosed: false,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(emi.id, emi);
    return emi;
  }

  async editEmi(emi: Emi, params: EditEmiParams): Promise<void> {
    const {
      hasPayments,
      name,
      lenderName,
      categoryId,
      principalAmount,
      notes,
      loanNumber,
      loanType,
      branch,
      customerId,
      sanctionDate,
      disbursementDate,
      processingFee,
      insuranceAmount,
      extraCharges,
      foreclosureAmount,
      prepaymentCharges,
      isAutoDebitEnabled,
      autoDebitAccount,
      linkedCreditCardId,
      clearLinkedCreditCardId = false,
    } = params;

    if (principalAmount != null) {
      if (principalAmount <= 0) {
        throw new Error("Principal amount must be greater than 0");
      }
      if (hasPayments) {
        throw new Error("Principal amount cannot be changed after a payment has been recorded");
      }
    }

    let updated = emi;
    updated = updateField(updated, "name", updated.name, name, (e, v) => ({ ...e, name: v }));
    updated = updateField(updated, "lenderName", updated.lenderName, lenderName, (e, v) => ({
      ...e,
      lenderName: v,
    }));
    updated = updateField(updated, "categoryId", updated.categoryId, categoryId, (e, v) => ({
      ...e,
      categoryId: v,
    }));
    updated = updateField(updated, "principalAmount", updated.principalAmount, principalAmount, (e, v) => ({
      ...e,
      principalAmount: v,
    }));
    updated = updateField(updated, "notes", updated.notes, notes, (e, v) => ({ ...e, notes: v }));
    updated = updateField(updated, "loanNumber", updated.loanNumber, loanNumber, (e, v) => ({
      ...e,
      loanNumber: v,
    }));
    updated = updateField(updated, "loanType", updated.loanType, loanType, (e, v) => ({ ...e, loanType: v }));
    updated = updateField(updated, "branch", updated.branch, branch, (e, v) => ({ ...e, branch: v }));
    updated = updateField(updated, "customerId", updated.customerId, customerId, (e, v) => ({
      ...e,
      customerId: v,
    }));
    updated = updateField(updated, "sanctionDate", updated.sanctionDate, sanctionDate, (e, v) => ({
      ...e,
      sanctionDate: v,
    }));
    updated = updateField(updated, "disbursementDate", updated.disbursementDate, disbursementDate, (e, v) => ({
      ...e,
      disbursementDate: v,
    }));
    updated = updateField(updated, "processingFee", updated.processingFee, processingFee, (e, v) => ({
      ...e,
      processingFee: v,
    }));
    updated = updateField(updated, "insuranceAmount", updated.insuranceAmount, insuranceAmount, (e, v) => ({
      ...e,
      insuranceAmount: v,
    }));
    updated = updateField(updated, "extraCharges", updated.extraCharges, extraCharges, (e, v) => ({
      ...e,
      extraCharges: v,
    }));
    updated = updateField(updated, "foreclosureAmount", updated.foreclosureAmount, foreclosureAmount, (e, v) => ({
      ...e,
      foreclosureAmount: v,
    }));
    updated = updateField(updated, "prepaymentCharges", updated.prepaymentCharges, prepaymentCharges, (e, v) => ({
      ...e,
      prepaymentCharges: v,
    }));
    updated = updateField(
      updated,
      "isAutoDebitEnabled",
      updated.isAutoDebitEnabled,
      isAutoDebitEnabled,
      (e, v) => ({ ...e, isAutoDebitEnabled: v }),
    );
    updated = updateField(updated, "autoDebitAccount", updated.autoDebitAccount, autoDebitAccount, (e, v) => ({
      ...e,
      autoDebitAccount: v,
    }));
    if (clearLinkedCreditCardId) {
      updated = recordEdit(updated, "linkedCreditCardId", updated.linkedCreditCardId ?? "none", "none");
      updated = { ...updated, linkedCreditCardId: null };
    } else {
      updated = updateField(
        updated,
        "linkedCreditCardId",
        updated.linkedCreditCardId,
        linkedCreditCardId,
        (e, v) => ({ ...e, linkedCreditCardId: v }),
      );
    }
    await this.update(updated);
  }

  /**
   * Changes `interest`/`installmentFrequency`/`installmentCount` on an EMI
   * that may already have payments recorded against it. Unlike `editEmi`'s
   * other fields, these drive the installment schedule, so this doesn't
   * just overwrite the `Emi` document — it re-amortizes the *outstanding*
   * principal (principal already paid down, via fully- or partially-paid
   * installments, is left alone) over the new terms and regenerates only
   * the untouched (zero-payment) tail of the schedule.
   *
   * `params.currentInstallments` must be every installment currently on
   * `emi.scheduleId` (the caller already has this stream watched).
   * `params.newInstallmentCount` must be at least the number of
   * installments that already carry a payment (fully or partially paid) —
   * you can't shrink the schedule below what's already been paid for.
   */
  async editEmiTerms(emi: Emi, params: EditEmiTermsParams): Promise<void> {
    const { currentInstallments, interest = null, installmentFrequency, newInstallmentCount, dueDayOfMonth } = params;

    if (newInstallmentCount < 1) {
      throw new Error("EMI needs at least 1 installment");
    }
    if (interest != null && interest.ratePercent < 0) {
      throw new Error("Interest rate cannot be negative");
    }
    if (dueDayOfMonth != null && (dueDayOfMonth < 1 || dueDayOfMonth > 31)) {
      throw new Error("Monthly due date must be between 1 and 31");
    }

    const sorted = [...currentInstallments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const settled = sorted.filter((i) => i.amountPaid > 0 || i.isSkipped);
    const untouched = sorted.filter((i) => i.amountPaid === 0 && !i.isSkipped);

    if (newInstallmentCount < settled.length) {
      throw new Error("Number of payments can't be less than the payments already made");
    }

    // Principal already paid down: for interest-bearing installments, only
    // the principalPortion counts (interest already paid isn't principal);
    // for non-interest ones, the whole amountPaid is principal.
    const principalPaid = settled.reduce((sum, i) => {
      if (i.amountPaid <= 0) return sum;
      const principalShare = i.principalPortion ?? i.amountDue;
      // A fully-paid installment counts its whole principal share. One
      // that's only partially paid (including a partial payment later
      // skipped) counts only the principal fraction of what was actually
      // paid — crediting the full share here would overstate principal
      // paid down and understate outstandingPrincipal below.
      if (i.amountPaid >= i.amountDue) return sum + principalShare;
      return sum + principalShare * (i.amountPaid / i.amountDue);
    }, 0);
    const outstandingPrincipal = clamp(emi.principalAmount - principalPaid, 0, emi.principalAmount);
    const remainingCount = newInstallmentCount - settled.length;

    const effectiveFrequency = installmentFrequency ?? emi.installmentFrequency;

    let newTail: Installment[] = [];
    if (remainingCount > 0 && outstandingPrincipal > 0) {
      let precomputed: PrecomputedInstallmentAmount[] | undefined;
      if (interest != null) {
        const breakdown = calculate({
          principal: outstandingPrincipal,
          type: interest.type,
          ratePercent: interest.ratePercent,
          period: interest.period,
          installmentCount: remainingCount,
          installmentFrequency: "monthly",
          installmentsPerYear: installmentsPerYearFor(effectiveFrequency),
        });
        precomputed = precomputedFromPeriods(breakdown.periods);
      }

      const installmentRepository = this.installmentRepositoryFor(emi.scheduleId);
      await installmentRepository.replaceUnpaid(untouched);

      const effectiveDueDayOfMonth = dueDayOfMonth ?? emi.dueDayOfMonth;
      const lastSettled = settled.length === 0 ? null : settled[settled.length - 1];
      let nextDue =
        lastSettled == null
          ? nextDueDate(effectiveFrequency, emi.startDate)
          : nextDueDate(effectiveFrequency, lastSettled.dueDate);
      // Unlike `createEmi`'s installment #1 (always the real First EMI
      // Date), the tail's first installment here is a *continuation* of an
      // existing EMI, not a fresh "first payment" — so when a due day is
      // set, it snaps too, same as every installment after it. Only
      // installment #1 of the EMI as a whole (still intact among `settled`
      // or, if nothing's settled yet, `emi.startDate` itself) is ever
      // exempt from this snapping.
      if (effectiveDueDayOfMonth != null && effectiveFrequency === "monthly" && lastSettled != null) {
        const lastDayOfMonth = new Date(nextDue.getFullYear(), nextDue.getMonth() + 1, 0).getDate();
        const snappedDay = effectiveDueDayOfMonth > lastDayOfMonth ? lastDayOfMonth : effectiveDueDayOfMonth;
        nextDue = new Date(nextDue.getFullYear(), nextDue.getMonth(), snappedDay);
      }
      const tailTotal =
        precomputed == null ? outstandingPrincipal : precomputed.reduce((s, p) => s + p.amountDue, 0);

      // In-memory only (never persisted as its own document) — just a
      // parameter object so `generateInstallments` can compute due dates
      // and stamp every new installment with the EMI's real scheduleId.
      const tailScheduleShape: PaymentSchedule = {
        id: emi.scheduleId,
        ownerType: "emi",
        ownerId: emi.id,
        totalAmount: tailTotal,
        scheduleType: effectiveFrequency,
        firstDueDate: nextDue,
        customIntervalDays: null,
        installmentCount: remainingCount,
        notes: "",
        createdAt: new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      newTail = await installmentRepository.generateInstallments(tailScheduleShape, {
        precomputedAmounts: precomputed,
        startingSequenceNumber: settled.length,
        dueDayOfMonth: effectiveDueDayOfMonth ?? undefined,
      });
    }

    let updated = recordEdit(
      emi,
      "loanTerms",
      `${emi.interest?.ratePercent}/${emi.installmentFrequency}/${emi.installmentCount}`,
      `${interest?.ratePercent}/${effectiveFrequency}/${newInstallmentCount}`,
    );
    updated = {
      ...updated,
      interest,
      installmentFrequency: effectiveFrequency,
      installmentCount: newInstallmentCount,
      dueDayOfMonth: dueDayOfMonth ?? updated.dueDayOfMonth,
      endDate:
        newTail.length > 0
          ? newTail[newTail.length - 1].dueDate
          : settled.length === 0
            ? emi.startDate
            : settled[settled.length - 1].dueDate,
    };
    await this.update(updated);

    const schedule = await this.paymentScheduleRepository.getByKey(emi.scheduleId);
    if (schedule != null) {
      const settledTotal = settled.reduce((sum, i) => sum + i.amountDue, 0);
      const newTailTotal = newTail.reduce((sum, i) => sum + i.amountDue, 0);
      await this.paymentScheduleRepository.editSchedule(schedule, {
        installmentCount: newInstallmentCount,
        totalAmount: settledTotal + newTailTotal,
      });
    }
  }

  /**
   * Changes `Emi.startDate` ("First EMI Date") — only permitted before any
   * payment exists anywhere on the EMI, since installment #1's due date is
   * `startDate` itself and a paid installment's due date must never be
   * rewritten after the fact (same posture as `principalAmount` locking
   * once `hasPayments` is true). Regenerates every installment from
   * scratch against the new date, reusing the EMI's existing
   * interest/frequency/count/dueDayOfMonth — equivalent to what `createEmi`
   * would have produced had the user picked this date originally.
   */
  async editStartDate(emi: Emi, params: EditEmiStartDateParams): Promise<void> {
    const { newStartDate, hasPayments, currentInstallments } = params;

    if (hasPayments) {
      throw new Error("First EMI Date can't be changed after a payment has been recorded");
    }

    const installmentRepository = this.installmentRepositoryFor(emi.scheduleId);
    // Unlike editEmiTerms's replaceUnpaid (which only clears a tail and
    // deliberately leaves skipped installments alone), the whole schedule
    // is being thrown away here — a skipped-but-unpaid installment must be
    // removed too, or it's left behind as a stale orphan once every
    // installment is regenerated against the new date.
    for (const installment of currentInstallments) {
      await installmentRepository.softDelete(installment);
    }

    let precomputed: PrecomputedInstallmentAmount[] | undefined;
    const interest = emi.interest;
    if (interest != null) {
      const breakdown = calculate({
        principal: emi.principalAmount,
        type: interest.type,
        ratePercent: interest.ratePercent,
        period: interest.period,
        installmentCount: emi.installmentCount,
        installmentFrequency: "monthly",
        installmentsPerYear: installmentsPerYearFor(emi.installmentFrequency),
      });
      precomputed = precomputedFromPeriods(breakdown.periods);
    }

    const schedule = await this.paymentScheduleRepository.getByKey(emi.scheduleId);
    const totalAmount =
      precomputed == null ? emi.principalAmount : precomputed.reduce((sum, p) => sum + p.amountDue, 0);
    if (schedule != null) {
      await this.paymentScheduleRepository.editSchedule(schedule, {
        totalAmount,
        firstDueDate: newStartDate,
      });
    }

    const newInstallments = await installmentRepository.generateInstallments(
      {
        id: emi.scheduleId,
        ownerType: "emi",
        ownerId: emi.id,
        totalAmount,
        scheduleType: emi.installmentFrequency,
        firstDueDate: newStartDate,
        customIntervalDays: null,
        installmentCount: emi.installmentCount,
        notes: "",
        createdAt: emi.createdAt,
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      },
      {
        precomputedAmounts: precomputed,
        dueDayOfMonth: emi.dueDayOfMonth ?? undefined,
      },
    );

    let updated = recordEdit(emi, "startDate", emi.startDate.toISOString(), newStartDate.toISOString());
    updated = {
      ...updated,
      startDate: newStartDate,
      endDate: newInstallments[newInstallments.length - 1].dueDate,
    };
    await this.update(updated);
  }

  async closeEmi(emi: Emi): Promise<void> {
    if (emi.isClosed) return;
    let updated = recordEdit(emi, "isClosed", "false", "true");
    updated = { ...updated, isClosed: true };
    await this.update(updated);
  }

  /**
   * Marks an EMI as defaulted — an explicit user action distinct from
   * "overdue" (a derived, automatically-clearing state); mirrors
   * `closeEmi`/`reopenEmi`'s audit-trail posture. Doesn't touch reminders:
   * a defaulted loan still has real installments the user may want
   * reminders about (moot here, see the file-level note on reminders).
   */
  async markDefaulted(emi: Emi): Promise<void> {
    if (emi.isDefaulted) return;
    let updated = recordEdit(emi, "isDefaulted", "false", "true");
    updated = { ...updated, isDefaulted: true };
    await this.update(updated);
  }

  async clearDefaulted(emi: Emi): Promise<void> {
    if (!emi.isDefaulted) return;
    let updated = recordEdit(emi, "isDefaulted", "true", "false");
    updated = { ...updated, isDefaulted: false };
    await this.update(updated);
  }

  /**
   * Early closure with an outstanding balance: soft-deletes every
   * not-fully-paid installment in `installments` (shortening the schedule
   * to what was actually paid — see `InstallmentRepository.closeOutRemaining`)
   * before closing the EMI. Use plain `closeEmi` when every installment is
   * already fully paid; this variant is specifically for writing off a
   * remaining balance.
   */
  async closeEmiEarly(emi: Emi, installments: Installment[]): Promise<void> {
    if (emi.isClosed) return;
    await this.installmentRepositoryFor(emi.scheduleId).closeOutRemaining(installments);
    await this.closeEmi(emi);
  }

  async reopenEmi(emi: Emi): Promise<void> {
    if (!emi.isClosed) return;
    let updated = recordEdit(emi, "isClosed", "true", "false");
    updated = { ...updated, isClosed: false };
    await this.update(updated);
  }

  /**
   * Wipes `emi` and everything under it — unlike plain `permanentlyDelete`
   * (inherited from `FirestoreCrudRepository`, which only removes the
   * `emis/{emiId}` document itself), this also deletes every `Installment`
   * on the linked schedule, each installment's own `payments` subcollection,
   * the `PaymentSchedule` document, and every `EmiPaymentBreakdown` — so
   * nothing orphaned is left in Firestore that credit-card utilization,
   * Dashboard, Reports, or Cash Flow could pick up after the fact. For "I
   * added this by mistake" — skips Trash/soft-delete entirely, unlike
   * `FirestoreCrudRepository.softDelete`.
   *
   * Deletion order mirrors the Dart repository exactly: (1) every
   * installment (active + trashed), each installment's `payments`
   * subcollection first, then the installment doc itself; (2) every
   * `EmiPaymentBreakdown` under this EMI; (3) the linked `PaymentSchedule`
   * document; (4) the `Emi` document itself.
   *
   * `this.collection` is `users/{uid}/emis` (a document's own converter-
   * bound collection is protected on the base class, so subcollection paths
   * below are rebuilt from `this.collection`'s parent user document — the
   * same `users/{uid}` root every other user-scoped collection hangs off
   * of, per `FirestoreCollections`).
   */
  async permanentlyDeleteEmi(emi: Emi): Promise<void> {
    const installmentRepository = this.installmentRepositoryFor(emi.scheduleId);
    const installments = await installmentRepository.getAll();
    const trashedInstallments = await installmentRepository.getTrash();

    const userDocRef = this.collection.parent;
    if (userDocRef == null) {
      throw new Error("emis collection must be nested under a user document");
    }

    // All reads happen first, then every delete is queued onto one
    // WriteBatch and committed atomically — a mid-operation failure can no
    // longer leave orphaned installments/payments/breakdowns behind, and
    // reads run in parallel instead of blocking one-by-one in a loop.
    const paymentsSnapshots = await Promise.all(
      [...installments, ...trashedInstallments].map((installment) =>
        getDocs(
          collection(
            userDocRef,
            FirestoreCollections.paymentSchedules,
            emi.scheduleId,
            FirestoreCollections.installments,
            installment.id,
            FirestoreCollections.payments,
          ),
        ),
      ),
    );

    const breakdownsSnapshot = await getDocs(
      collection(this.collection, emi.id, FirestoreCollections.paymentBreakdowns),
    );

    const batch = writeBatch(this.collection.firestore);

    for (const paymentsSnapshot of paymentsSnapshots) {
      for (const paymentDoc of paymentsSnapshot.docs) {
        batch.delete(paymentDoc.ref);
      }
    }
    for (const installment of [...installments, ...trashedInstallments]) {
      batch.delete(
        doc(
          userDocRef,
          FirestoreCollections.paymentSchedules,
          emi.scheduleId,
          FirestoreCollections.installments,
          installment.id,
        ),
      );
    }
    for (const breakdownDoc of breakdownsSnapshot.docs) {
      batch.delete(breakdownDoc.ref);
    }
    batch.delete(doc(userDocRef, FirestoreCollections.paymentSchedules, emi.scheduleId));
    batch.delete(doc(this.collection, emi.id));

    await batch.commit();
  }
}

export interface CreateEmiPaymentBreakdownParams {
  paymentId: string;
  scheduleId: string;
  installmentId: string;
  principalPaid?: number;
  interestPaid?: number;
  gst?: number;
  igst?: number;
  processingFee?: number;
  insuranceCharge?: number;
  serviceCharge?: number;
  penalty?: number;
  otherCharges?: number;
  notes?: string;
}

/**
 * Persistence for one EMI's `paymentBreakdowns` subcollection — documents
 * are keyed by the `InstallmentPayment.id` they belong to (see
 * `EmiPaymentBreakdown.paymentId`), which trivially enforces the 1:1
 * relationship: creating a second breakdown for the same payment just
 * overwrites, never duplicates. No validation beyond non-negative amounts
 * (mirrors `Statement`'s optional manually-logged fees, per the Dart
 * source's comment) — the total isn't cross-checked against the underlying
 * payment's `amount` since the user may record charges paid through a
 * separate transaction.
 */
export class EmiPaymentBreakdownRepository extends FirestoreCrudRepository<EmiPaymentBreakdown> {
  constructor(collectionRef: CollectionReference<EmiPaymentBreakdown>) {
    super(collectionRef);
  }

  async createBreakdown(params: CreateEmiPaymentBreakdownParams): Promise<EmiPaymentBreakdown> {
    const {
      paymentId,
      scheduleId,
      installmentId,
      principalPaid = 0,
      interestPaid = 0,
      gst = 0,
      igst = 0,
      processingFee = 0,
      insuranceCharge = 0,
      serviceCharge = 0,
      penalty = 0,
      otherCharges = 0,
      notes = "",
    } = params;

    // Document id set EQUAL to `paymentId` (the `InstallmentPayment.id`),
    // not a freshly generated id — the one deliberate
    // doc-id-equals-parent-id case in this schema, ported exactly from
    // `EmiPaymentBreakdownRepository.createBreakdown`.
    const breakdown: EmiPaymentBreakdown = {
      id: paymentId,
      paymentId,
      scheduleId,
      installmentId,
      createdAt: new Date(),
      principalPaid,
      interestPaid,
      gst,
      igst,
      processingFee,
      insuranceCharge,
      serviceCharge,
      penalty,
      otherCharges,
      notes,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(breakdown.id, breakdown);
    return breakdown;
  }
}
