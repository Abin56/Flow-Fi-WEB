/**
 * How far a Loan / EMI schedule has been paid, read straight off its installments (`amountDue` /
 * `amountPaid` — the documents every payment, advance payment, edit and reversal write). Pure and
 * read-only: no allocation happens here; `planInstallmentSettlement` stays the one allocator.
 *
 * An installment an advance only partly covered counts as `partial`, never as paid, and the next
 * installment reports what is already covered and what is still due on it — so ₹6,500 against
 * ₹1,000 installments reads "6 paid · 1 partial", next ₹500 still due, and no remainder is lost.
 */

import { installmentStatus, remainingAmount, type Installment } from "@/lib/models/payment-schedule";

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Sub-paisa float residue is not money (same tolerance as the EMI allocator). */
const EPSILON = 0.005;

export interface InstallmentProgressNext {
  installment: Installment;
  /** The installment's scheduled amount. */
  original: number;
  /** Already paid / covered by an earlier (advance) payment. */
  covered: number;
  stillDue: number;
}

export interface InstallmentProgressSummary {
  total: number;
  paid: number;
  partial: number;
  /** Not started yet (nothing paid on it). */
  unpaid: number;
  scheduledTotal: number;
  paidTotal: number;
  remainingTotal: number;
  /** Paid share of the scheduled total, 0–100 (whole number). */
  percentPaid: number;
  next: InstallmentProgressNext | null;
}

export function installmentProgress(installments: readonly Installment[]): InstallmentProgressSummary {
  const live = installments.filter((i) => i.deletedAt == null && !i.isSkipped).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  let paid = 0;
  let partial = 0;
  let scheduledTotal = 0;
  let paidTotal = 0;
  let next: InstallmentProgressNext | null = null;
  for (const i of live) {
    const covered = round2(Math.min(Math.max(i.amountPaid, 0), i.amountDue));
    const stillDue = round2(remainingAmount(i));
    scheduledTotal += i.amountDue;
    paidTotal += covered;
    if (installmentStatus(i) === "paid" || stillDue <= EPSILON) paid++;
    else if (covered > EPSILON) partial++;
    if (next == null && stillDue > EPSILON) next = { installment: i, original: i.amountDue, covered, stillDue };
  }
  scheduledTotal = round2(scheduledTotal);
  paidTotal = round2(paidTotal);
  return {
    total: live.length,
    paid,
    partial,
    unpaid: live.length - paid - partial,
    scheduledTotal,
    paidTotal,
    remainingTotal: round2(Math.max(0, scheduledTotal - paidTotal)),
    percentPaid: scheduledTotal > 0 ? Math.min(100, Math.floor((paidTotal / scheduledTotal) * 100)) : 0,
    next,
  };
}
