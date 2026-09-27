/**
 * Pure allocation for one EMI payment — the single place an EMI payment amount is turned into
 * installment updates, payment records and charge breakdowns. Both the Record Payment surface (to
 * validate/preview) and `useEmiActions().recordPayment` (to write, from FRESH in-transaction reads)
 * call this, so the schedule, the stored payments and the UI can never disagree.
 *
 * Allocation reuses the shared `planInstallmentSettlement` engine (the same one Loans use):
 *   - the target installment (the one picked, else the next unpaid) is filled first;
 *   - anything left fills the following unpaid installments in schedule order (an advance payment);
 *   - the amount can never exceed the EMI's total remaining — an EMI has no principal-prepayment /
 *     re-amortization engine, so there is nowhere correct for money above what is owed to go.
 *
 * One `InstallmentPayment` is written per installment touched, each for exactly the portion applied,
 * so payment history sums to the amount paid and no installment is over-applied. Each portion's
 * principal/interest split uses that installment's own ratio (`defaultEmiPaymentSplit`), so an
 * interest-bearing EMI never books interest as principal. One-off charges (GST, fees…) are recorded
 * once, on the first portion's breakdown.
 */

import { planInstallmentSettlement } from "@/lib/engines/installment-settlement";
import { mergeInstallmentWrites, reversePaymentPortions } from "@/lib/engines/payment-correction";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import { defaultEmiPaymentSplit, type EmiPaymentBreakdown } from "@/lib/models/emi";
import {
  installmentStatus,
  remainingAmount,
  type Installment,
  type InstallmentPayment,
  type PaymentAllocationType,
} from "@/lib/models/payment-schedule";

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Sub-paisa float residue from summing rupee-and-paisa figures is not money. */
const EPSILON = 0.005;

export interface EmiPaymentPortion {
  installment: Installment;
  amount: number;
  allocationType: PaymentAllocationType;
  /** This installment's remaining amount once the portion is applied. */
  remainingAfter: number;
  principalPaid: number;
  interestPaid: number;
}

export type EmiPaymentAllocation =
  | {
      ok: true;
      portions: EmiPaymentPortion[];
      /** Always equals the amount paid. */
      applied: number;
      /** The EMI's total remaining across every payable installment, before / after this payment. */
      remainingBefore: number;
      remainingAfter: number;
      /** First installment still owing after the payment — null once the EMI is settled. */
      nextAfter: { installment: Installment; remaining: number } | null;
    }
  | { ok: false; error: string };

/** Installments a payment can still go to, in schedule order. */
export function payableEmiInstallments(installments: Installment[]): Installment[] {
  return installments
    .filter((i) => i.deletedAt == null && !i.isSkipped && remainingAmount(i) > EPSILON)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

export function emiTotalRemaining(installments: Installment[]): number {
  return round2(payableEmiInstallments(installments).reduce((sum, i) => sum + remainingAmount(i), 0));
}

const inr = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function planEmiPaymentAllocation(params: {
  installments: Installment[];
  amount: number;
  date: Date;
  /** The installment the user chose to pay; filled first. Defaults to the next unpaid one. */
  targetInstallmentId?: string | null;
}): EmiPaymentAllocation {
  const { amount, date } = params;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than 0." };
  const payable = payableEmiInstallments(params.installments);
  if (payable.length === 0) return { ok: false, error: "Nothing is left to pay on this EMI." };

  const target = payable.find((i) => i.id === params.targetInstallmentId) ?? payable[0];
  const order = [target, ...payable.filter((i) => i.id !== target.id)];
  const remainingBefore = emiTotalRemaining(order);
  const rounded = round2(amount);
  if (rounded > remainingBefore + EPSILON) {
    return { ok: false, error: `That's more than this EMI still owes — the most you can pay is ${inr(remainingBefore)}, which settles it.` };
  }

  const plan = planInstallmentSettlement(order, rounded);
  const portions: EmiPaymentPortion[] = plan.portions.map(({ installment, portion }) => {
    const amountPortion = round2(portion);
    const split = defaultEmiPaymentSplit(installment, amountPortion);
    return {
      installment,
      amount: amountPortion,
      allocationType: installment.dueDate.getTime() > date.getTime() ? "advanceEmi" : "regularEmi",
      remainingAfter: round2(Math.max(0, remainingAmount(installment) - amountPortion)),
      principalPaid: split.principalPaid,
      interestPaid: split.interestPaid,
    };
  });
  const applied = round2(portions.reduce((sum, p) => sum + p.amount, 0));
  const touched = new Map(portions.map((p) => [p.installment.id, p.remainingAfter]));
  const after = payable
    .map((i) => ({ installment: i, remaining: touched.get(i.id) ?? remainingAmount(i) }))
    .filter((i) => i.remaining > EPSILON);

  return {
    ok: true,
    portions,
    applied,
    remainingBefore,
    remainingAfter: round2(Math.max(0, remainingBefore - applied)),
    nextAfter: after[0] ?? null,
  };
}

export interface EmiPaymentCharges {
  gst?: number;
  igst?: number;
  processingFee?: number;
  insuranceCharge?: number;
  serviceCharge?: number;
  penalty?: number;
  otherCharges?: number;
}

export interface EmiPaymentWrites {
  installments: Installment[];
  payments: InstallmentPayment[];
  breakdowns: EmiPaymentBreakdown[];
}

/** Deterministic per-action ids — a retry of the same action finds its own first breakdown and stops. */
export function emiPaymentId(idempotencyKey: string, index: number): string {
  return `emi_${idempotencyKey}_p${index}`;
}

/**
 * The exact documents one allocated EMI payment writes: each touched installment with its new
 * `amountPaid` (clamped to `amountDue`, audit-trailed), one payment per portion, and one breakdown per
 * payment. `principalPaid`/`interestPaid` from the bank override the ratio split only when the payment
 * lands on a single installment (they describe that one installment).
 */
export function buildEmiPaymentWrites(params: {
  portions: EmiPaymentPortion[];
  idempotencyKey: string;
  date: Date;
  note?: string;
  principalPaid?: number;
  interestPaid?: number;
  charges?: EmiPaymentCharges;
  now?: Date;
}): EmiPaymentWrites {
  const { portions, date, note = "", charges = {} } = params;
  const now = params.now ?? new Date();
  const bankSplit = portions.length === 1 && params.principalPaid != null;
  const writes: EmiPaymentWrites = { installments: [], payments: [], breakdowns: [] };

  portions.forEach((portion, index) => {
    const fresh = portion.installment;
    const newAmountPaid = Math.min(Math.max(round2(fresh.amountPaid + portion.amount), 0), fresh.amountDue);
    const installment = { ...recordEdit(fresh, "amountPaid", String(fresh.amountPaid), String(newAmountPaid)), amountPaid: newAmountPaid };
    const id = emiPaymentId(params.idempotencyKey, index);
    writes.installments.push(installment);
    writes.payments.push({
      id,
      installmentId: fresh.id,
      scheduleId: fresh.scheduleId,
      ownerType: fresh.ownerType,
      ownerId: fresh.ownerId,
      amount: portion.amount,
      date,
      note,
      createdAt: now,
      settlementMethod: null,
      billingCycleLabel: null,
      remainingBalanceAfterPayment: remainingAmount(installment),
      allocationType: portion.allocationType,
      prepaymentPrincipalAmount: null,
      prepaymentPolicyApplied: null,
      reamortizationEventId: null,
      transactionId: null,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    });
    const first = index === 0;
    writes.breakdowns.push({
      id,
      paymentId: id,
      scheduleId: fresh.scheduleId,
      installmentId: fresh.id,
      createdAt: now,
      principalPaid: bankSplit ? params.principalPaid! : portion.principalPaid,
      interestPaid: bankSplit ? (params.interestPaid ?? 0) : portion.interestPaid,
      gst: first ? (charges.gst ?? 0) : 0,
      igst: first ? (charges.igst ?? 0) : 0,
      processingFee: first ? (charges.processingFee ?? 0) : 0,
      insuranceCharge: first ? (charges.insuranceCharge ?? 0) : 0,
      serviceCharge: first ? (charges.serviceCharge ?? 0) : 0,
      penalty: first ? (charges.penalty ?? 0) : 0,
      otherCharges: first ? (charges.otherCharges ?? 0) : 0,
      notes: "",
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    });
  });
  return writes;
}

/** The payment's overall classification, same rule Loans use: advance when its first installment isn't due yet. */
export function emiOverallAllocationType(portions: EmiPaymentPortion[]): PaymentAllocationType {
  return portions[0]?.allocationType ?? "regularEmi";
}

/**
 * An EMI's live figures, derived only from its installments (sorted by sequence) — what `useEmiRows`
 * shows as Outstanding / Next due / Paid, so whatever a payment writes is exactly what the next live
 * snapshot displays.
 */
export function emiScheduleFigures(installments: Installment[]): {
  remainingBalance: number;
  nextInstallment: Installment | null;
  installmentsPaid: number;
} {
  return {
    remainingBalance: installments.filter((i) => installmentStatus(i) !== "skipped").reduce((sum, i) => sum + remainingAmount(i), 0),
    nextInstallment: installments.find((i) => !i.isSkipped && remainingAmount(i) > 0) ?? null,
    installmentsPaid: installments.filter((i) => installmentStatus(i) === "paid").length,
  };
}

export type EmiPaymentEditPlan =
  | { ok: true; allocation: Extract<EmiPaymentAllocation, { ok: true }>; reversed: Installment[]; writes: EmiPaymentWrites }
  | { ok: false; error: string };

/**
 * Correcting a recorded EMI payment action: its portions are taken back out of the schedule, then the
 * corrected amount is allocated by `planEmiPaymentAllocation` against that reversed state, starting from
 * the same installment the original started on — exactly what recording the corrected payment originally
 * would have produced. `writes.installments` holds the final state of every installment that changed
 * (reversed and/or re-applied), so nothing is applied twice.
 */
export function planEmiPaymentEdit(params: {
  installments: Installment[];
  /** The original action's active payments. */
  original: InstallmentPayment[];
  amount: number;
  date: Date;
  idempotencyKey: string;
  note?: string;
  principalPaid?: number;
  interestPaid?: number;
  charges?: EmiPaymentCharges;
}): EmiPaymentEditPlan {
  if (params.original.length === 0) return { ok: false, error: "This payment was already changed — reopen it and try again." };
  const reversed = reversePaymentPortions(params.installments, params.original);
  const bySeq = new Map(params.installments.map((i) => [i.id, i.sequenceNumber]));
  const first = [...params.original].sort((a, b) => (bySeq.get(a.installmentId) ?? 0) - (bySeq.get(b.installmentId) ?? 0))[0];
  const allocation = planEmiPaymentAllocation({ installments: reversed, amount: params.amount, date: params.date, targetInstallmentId: first.installmentId });
  if (!allocation.ok) return allocation;
  const writes = buildEmiPaymentWrites({ ...params, portions: allocation.portions });
  return { ok: true, allocation, reversed, writes: { ...writes, installments: mergeInstallmentWrites(params.installments, reversed, writes.installments) } };
}

/**
 * Undoing a recorded EMI payment action — "Mark as unpaid": its portions are taken back out of the schedule
 * (the same `reversePaymentPortions` an edit starts with), and nothing is re-applied. `installments` holds
 * only the installments that changed. The caller soft-deletes the action's payments, breakdowns and card
 * Transaction in the same Firestore transaction; card available credit follows from the active breakdowns.
 */
export function planEmiPaymentReversal(params: { installments: Installment[]; original: InstallmentPayment[] }): { installments: Installment[] } | null {
  if (params.original.length === 0) return null;
  const reversed = reversePaymentPortions(params.installments, params.original);
  return { installments: mergeInstallmentWrites(params.installments, reversed) };
}
