/**
 * Read-only preview of `EmiRepository.editEmiTerms` — what the unpaid tail of an EMI's schedule becomes under new
 * terms, computed with exactly the maths the repository uses (`calculate` for the interest breakdown,
 * `InstallmentRepository.buildInstallments` for dates and amounts, the same settled/untouched split and due-day
 * snapping). It writes nothing; the Edit Terms screen shows it and then calls the repository method itself.
 * `emi-terms-plan.test.ts` and the emulator integration test keep this in step with what the repository saves.
 *
 * Principal is never changed by a terms edit: paid and part-paid installments keep their own figures, and only
 * the outstanding principal is re-spread over the unpaid tail.
 */

import { calculate, type InterestPeriod, type InterestType } from "@/lib/engines/interest-calculator";
import { installmentsPerYearFor, precomputedFromPeriods, termsTailFirstDueDate, termsTailProblems } from "@/lib/engines/emi-terms-math";
import type { Emi, EmiInterest } from "@/lib/models/emi";
import { type Installment, type PaymentSchedule, type ScheduleType } from "@/lib/models/payment-schedule";
import { InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";

export interface EmiTermsInput {
  /** `null` — no interest (the unpaid principal is split evenly). */
  ratePercent: number | null;
  interestType: InterestType;
  period: InterestPeriod;
  installmentCount: number;
  frequency: ScheduleType;
  /** Monthly EMIs only; `null` keeps the current due day. */
  dueDayOfMonth: number | null;
}

export interface PlannedInstallment {
  sequenceNumber: number;
  dueDate: Date;
  amountDue: number;
  principalPortion: number | null;
  interestPortion: number | null;
}

export interface TermsSnapshot {
  /** The next unpaid installment's amount (what the user will actually pay next). */
  emiAmount: number | null;
  /** Everything still to pay: part-paid remainders plus the unpaid tail. */
  remainingPayable: number;
  remainingInterest: number;
  installmentCount: number;
  endDate: Date | null;
}

export interface EmiTermsPlan {
  errors: string[];
  /** Nothing differs from the saved terms. */
  unchanged: boolean;
  settledCount: number;
  principalPaid: number;
  /** Unchanged by a terms edit — shown so the user can see it stays put. */
  outstandingPrincipal: number;
  currentTail: PlannedInstallment[];
  newTail: PlannedInstallment[];
  before: TermsSnapshot;
  after: TermsSnapshot;
  /** The first installment the new terms apply to. */
  effectiveFrom: { sequenceNumber: number; dueDate: Date } | null;
  interest: EmiInterest | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const isSettled = (i: Pick<Installment, "amountPaid" | "isSkipped">) => i.amountPaid > 0 || i.isSkipped;

/** The EMI's saved terms in the form the editor starts from. */
export function currentEmiTerms(emi: Emi, installments: readonly Installment[]): EmiTermsInput {
  return {
    ratePercent: emi.interest?.ratePercent ?? null,
    interestType: emi.interest?.type ?? "reducingBalance",
    period: emi.interest?.period ?? "yearly",
    installmentCount: installments.filter((i) => i.deletedAt == null).length || emi.installmentCount,
    frequency: emi.installmentFrequency,
    dueDayOfMonth: emi.dueDayOfMonth,
  };
}

function toPlanned(i: Installment): PlannedInstallment {
  return { sequenceNumber: i.sequenceNumber, dueDate: i.dueDate, amountDue: i.amountDue, principalPortion: i.principalPortion, interestPortion: i.interestPortion };
}

function snapshot(settled: readonly Installment[], tail: readonly PlannedInstallment[], emi: Emi): TermsSnapshot {
  const partial = settled.filter((i) => !i.isSkipped).reduce((s, i) => s + clamp(i.amountDue - i.amountPaid, 0, i.amountDue), 0);
  const last = tail.length > 0 ? tail[tail.length - 1]!.dueDate : settled.length > 0 ? settled[settled.length - 1]!.dueDate : emi.startDate;
  const nextPartial = settled.find((i) => !i.isSkipped && i.amountPaid < i.amountDue);
  return {
    emiAmount: nextPartial ? round2(nextPartial.amountDue) : tail[0] ? round2(tail[0].amountDue) : null,
    remainingPayable: round2(partial + tail.reduce((s, i) => s + i.amountDue, 0)),
    remainingInterest: round2(tail.reduce((s, i) => s + (i.interestPortion ?? 0), 0)),
    installmentCount: settled.length + tail.length,
    endDate: tail.length > 0 || settled.length > 0 ? last : null,
  };
}

/**
 * `installments` must be every ACTIVE installment on the EMI's schedule (the repository's `currentInstallments`).
 * Mirrors `EmiRepository.editEmiTerms` step for step; the extra errors below are guards the repository does not
 * enforce but that would leave a wrong schedule.
 */
export function planEmiTermsEdit(emi: Emi, installments: readonly Installment[], proposed: EmiTermsInput): EmiTermsPlan {
  const sorted = [...installments].filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const settled = sorted.filter(isSettled);
  const untouched = sorted.filter((i) => !isSettled(i));
  const errors: string[] = [];

  const principalPaid = settled.reduce((sum, i) => {
    if (i.amountPaid <= 0) return sum;
    const share = i.principalPortion ?? i.amountDue;
    return i.amountPaid >= i.amountDue ? sum + share : sum + share * (i.amountPaid / i.amountDue);
  }, 0);
  const outstandingPrincipal = round2(clamp(emi.principalAmount - principalPaid, 0, emi.principalAmount));
  const remainingCount = proposed.installmentCount - settled.length;

  if (!Number.isInteger(proposed.installmentCount) || proposed.installmentCount < 1) errors.push("Enter a whole number of installments (at least 1).");
  else if (proposed.installmentCount < settled.length) errors.push(`At least ${settled.length} — that many installments already carry a payment.`);
  else if (remainingCount < 1 && outstandingPrincipal > 0.005) errors.push(`More than ${settled.length}: ₹${outstandingPrincipal.toLocaleString("en-IN")} is still owed and needs at least one unpaid installment.`);
  if (proposed.ratePercent != null && (!Number.isFinite(proposed.ratePercent) || proposed.ratePercent < 0)) errors.push("Interest rate can't be negative.");
  else if (proposed.ratePercent != null && proposed.ratePercent > 100) errors.push("Interest rate must be 100% or less.");
  if (proposed.dueDayOfMonth != null && (!Number.isInteger(proposed.dueDayOfMonth) || proposed.dueDayOfMonth < 1 || proposed.dueDayOfMonth > 31)) errors.push("Monthly due date must be between 1 and 31.");

  const interest: EmiInterest | null =
    proposed.ratePercent != null && proposed.ratePercent > 0 ? { type: proposed.interestType, ratePercent: proposed.ratePercent, period: proposed.period } : null;

  const currentTail = untouched.map(toPlanned);
  const before = snapshot(settled, currentTail, emi);
  const emptyPlan = (): EmiTermsPlan => ({
    errors, unchanged: false, settledCount: settled.length, principalPaid: round2(principalPaid), outstandingPrincipal,
    currentTail, newTail: currentTail, before, after: before, effectiveFrom: null, interest,
  });
  if (errors.length > 0) return emptyPlan();

  let newTail: Installment[] = [];
  if (remainingCount > 0 && outstandingPrincipal > 0) {
    const precomputed =
      interest != null
        ? precomputedFromPeriods(
            calculate({
              principal: outstandingPrincipal,
              type: interest.type,
              ratePercent: interest.ratePercent,
              period: interest.period,
              installmentCount: remainingCount,
              installmentFrequency: "monthly",
              installmentsPerYear: installmentsPerYearFor(proposed.frequency),
            }).periods,
          )
        : undefined;
    const dueDay = proposed.dueDayOfMonth ?? emi.dueDayOfMonth;
    const lastSettled = settled.length === 0 ? null : settled[settled.length - 1]!;
    const nextDue = termsTailFirstDueDate({ frequency: proposed.frequency, startDate: emi.startDate, lastSettledDueDate: lastSettled?.dueDate ?? null, dueDayOfMonth: dueDay ?? null });
    const tailTotal = precomputed == null ? outstandingPrincipal : precomputed.reduce((s, p) => s + p.amountDue, 0);
    const shape: PaymentSchedule = {
      id: emi.scheduleId, ownerType: "emi", ownerId: emi.id, totalAmount: tailTotal, scheduleType: proposed.frequency, firstDueDate: nextDue,
      customIntervalDays: null, installmentCount: remainingCount, notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [],
    };
    newTail = InstallmentRepository.buildInstallments(shape, { precomputedAmounts: precomputed, startingSequenceNumber: settled.length, dueDayOfMonth: dueDay ?? undefined });
  }
  const plannedTail = newTail.map(toPlanned);
  const problems = termsTailProblems({
    tail: plannedTail,
    outstandingPrincipal,
    firstDueDate: plannedTail[0]?.dueDate ?? emi.startDate,
    lastSettledDueDate: settled.length > 0 ? settled[settled.length - 1]!.dueDate : null,
  });
  if (problems.length > 0) {
    errors.push(...problems);
    return emptyPlan();
  }
  const after = snapshot(settled, plannedTail, emi);

  const same =
    (emi.interest?.ratePercent ?? null) === (interest?.ratePercent ?? null) &&
    (emi.interest?.type ?? null) === (interest?.type ?? null) &&
    (emi.interest?.period ?? null) === (interest?.period ?? null) &&
    emi.installmentFrequency === proposed.frequency &&
    proposed.installmentCount === sorted.length &&
    (proposed.dueDayOfMonth ?? null) === (emi.dueDayOfMonth ?? null);

  return {
    errors, unchanged: same, settledCount: settled.length, principalPaid: round2(principalPaid), outstandingPrincipal,
    currentTail, newTail: plannedTail, before, after,
    effectiveFrom: plannedTail[0] ? { sequenceNumber: plannedTail[0].sequenceNumber, dueDate: plannedTail[0].dueDate } : null,
    interest,
  };
}

/**
 * Identity of a schedule's money state: every active installment with what has been paid on it. The Edit Terms screen
 * compares this between the schedule its preview was computed from and a fresh server read just before saving —
 * the repository retires whatever installments it is handed, so a changed schedule must never reach it.
 */
export function scheduleFingerprint(installments: readonly Pick<Installment, "id" | "amountPaid" | "isSkipped" | "deletedAt">[]): string {
  return installments
    .filter((i) => i.deletedAt == null)
    .map((i) => `${i.id}:${i.amountPaid}:${i.isSkipped}`)
    .sort()
    .join("|");
}

/** Why Edit terms is unavailable for this EMI — null when it is safe. */
export function emiTermsEditBlocker(emi: Pick<Emi, "isClosed" | "ownershipShares" | "beneficiaryRepaysInstallments">, installments: readonly Installment[]): string | null {
  if (emi.isClosed) return "This EMI is closed. Reopen it to change its terms.";
  if ((emi.ownershipShares?.length ?? 0) > 0 || emi.beneficiaryRepaysInstallments === true) {
    return "This EMI is shared. Each person's share of every installment is tracked against the current schedule, and replacing the unpaid installments would orphan those shares. Changing terms on a shared EMI isn't supported yet.";
  }
  const active = installments.filter((i) => i.deletedAt == null);
  if (active.length > 0 && active.every((i) => i.amountPaid >= i.amountDue || i.isSkipped)) return "Every installment is already paid, so there is nothing left to re-plan.";
  return null;
}
