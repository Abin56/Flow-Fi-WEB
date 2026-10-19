/**
 * "Already paid earlier" — a Loan / EMI installment payment the user made BEFORE it was tracked in FlowFi.
 * The current account balance already reflects it, so recording it must settle the schedule without moving
 * money again. Pure rules shared by the Loan and EMI write paths (see `InstallmentPayment.recordedEarlier`):
 *
 *  - It never moves an account: a Loan's Transaction is posted with `excludeFromCalculations: true` (zero
 *    `balanceEffect` when posted, reversed, edited or deleted with its agreement); an EMI posts none.
 *  - It is dated in the past (or today) — never in the future. An unknown date is stored as the
 *    installment's due date with `dateKnown: false`, never presented as a real payment date.
 *  - It lands exactly on the installment the user picked: if that one is already paid by the time it is
 *    saved (another tab, a retry with a new key), nothing is written — never silently moved to the next.
 *  - It covers installments only — no extra principal, so it never re-plans the schedule.
 *  - It is the user's statement of a past fact: People shares are not touched and stay owed (the lender
 *    payment and each person's reimbursement are separate records).
 */

import type { UnsettledPeopleAcknowledgement } from "@/lib/engines/linked-people-readiness";
import type { InstallmentPayment, RecordedEarlier } from "@/lib/models/payment-schedule";

/** Stamped on the description of a Loan payment recorded as "already paid earlier" — also how lists recognise it. */
export const RECORDED_EARLIER_DESCRIPTION_SUFFIX = " (already paid earlier)";

export class RecordedEarlierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordedEarlierError";
  }
}

/** End of the local day — "today" is still "earlier" for a payment made before opening FlowFi. */
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function assertRecordedEarlierDate(date: Date, now: Date = new Date()): void {
  if (date.getTime() > endOfDay(now).getTime()) {
    throw new RecordedEarlierError("A payment already made can't be dated in the future — nothing was recorded.");
  }
}

/** The first installment the allocation reached must be the one the user picked. */
export function assertRecordedEarlierTarget(firstInstallmentId: string | undefined, expectedInstallmentId: string | null | undefined): void {
  if (expectedInstallmentId != null && firstInstallmentId !== expectedInstallmentId) {
    throw new RecordedEarlierError("This installment is already paid — nothing was recorded. Close this and check the schedule.");
  }
}

/** Bulk: one historical payment per installment — an amount that would reach a second one is refused. */
export function assertRecordedEarlierSingle(portionCount: number): void {
  if (portionCount !== 1) {
    throw new RecordedEarlierError("That's more than this installment still owes — nothing was recorded. Check the amount.");
  }
}

export function assertRecordedEarlierNoExtra(overflow: number): void {
  if (overflow > 0) {
    throw new RecordedEarlierError(
      "That's more than the installments still owe. A past payment can only cover installments — record extra principal as a normal payment.",
    );
  }
}

/**
 * An edit keeps the original's treatment: a payment recorded as already paid earlier stays one (still no
 * account movement). Its date becomes "known" once the user changes it.
 */
export function carriedRecordedEarlier(original: Pick<InstallmentPayment, "recordedEarlier" | "date"> | null | undefined, newDate: Date): RecordedEarlier | null {
  const mark = original?.recordedEarlier;
  if (!mark) return null;
  return { dateKnown: mark.dateKnown || newDate.getTime() !== original!.date.getTime() };
}

/**
 * The write gate's explicit acknowledgement for a past payment: the lender was already paid, so waiting for
 * People shares is moot. Their shares stay owed — nothing in People is written or marked received.
 */
export const RECORDED_EARLIER_PEOPLE_ACK: UnsettledPeopleAcknowledgement = {
  acknowledgedUnsettledPeople: true,
  reason: "Recorded as already paid earlier (before FlowFi) — People shares unchanged",
};
