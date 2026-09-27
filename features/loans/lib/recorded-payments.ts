/**
 * The Loan & EMI "recorded payment" read model: what the user actually entered, as opposed to the
 * scheduled installments it was allocated across. One payment action can write several
 * `InstallmentPayment` docs (one per installment touched, plus a Loan's ledger-only extra-principal
 * record); this groups them back into the single ₹ amount the user paid, by the ids the write paths
 * persist — never by amount/date heuristics:
 *   - Loan: every doc of an action shares its `transactionId`.
 *   - EMI:  docs are `emi_{key}_p{n}`; an older EMI payment (random id) is its own action.
 * Pure.
 */

import type { InstallmentPayment, Installment, PaymentAllocationType } from "@/lib/models/payment-schedule";

export type PaymentSource = "loan" | "emi";

export interface RecordedPaymentAction {
  id: string;
  source: PaymentSource;
  /** Installment portions, in schedule order. */
  portions: InstallmentPayment[];
  /** A Loan's ledger-only extra-principal record, when the action had one. */
  overflow: InstallmentPayment | null;
  amount: number;
  date: Date;
  note: string;
  createdAt: Date;
  allocationType: PaymentAllocationType;
  transactionId: string | null;
  installmentSeqs: number[];
  /** What was still owed on the last installment it touched, right after it — null for extra principal. */
  remainingAfter: number | null;
  /** Soft-deleted — reversed, or replaced by an edit. Shown in history, never editable. */
  reversed: boolean;
}

export type EditEligibility = { ok: true } | { ok: false; reason: string };

const EMI_ACTION_ID = /^emi_(.+)_p\d+$/;

function groupKey(payment: InstallmentPayment, source: PaymentSource): string {
  if (source === "loan") return payment.transactionId != null ? `txn:${payment.transactionId}` : `legacy:${payment.id}`;
  const match = EMI_ACTION_ID.exec(payment.id);
  return match ? `emi:${match[1]}` : `legacy:${payment.id}`;
}

export function groupRecordedPayments(payments: InstallmentPayment[], installments: Installment[], source: PaymentSource): RecordedPaymentAction[] {
  const seqById = new Map(installments.map((i) => [i.id, i.sequenceNumber]));
  const unique = Array.from(new Map(payments.map((p) => [p.id, p])).values());
  const groups = new Map<string, InstallmentPayment[]>();
  for (const payment of unique) {
    // An edit soft-deletes the original docs and writes new ones with new ids, so active and reversed
    // docs never share a group — keyed separately anyway, so a half-state can't merge them.
    const key = `${groupKey(payment, source)}:${payment.deletedAt != null ? "reversed" : "active"}`;
    groups.set(key, [...(groups.get(key) ?? []), payment]);
  }

  const actions = Array.from(groups.entries()).map(([key, docs]): RecordedPaymentAction => {
    const overflow = docs.find((d) => d.allocationType === "principalPrepayment") ?? null;
    const portions = docs.filter((d) => d !== overflow).sort((a, b) => (seqById.get(a.installmentId) ?? 0) - (seqById.get(b.installmentId) ?? 0));
    const lead = portions[0] ?? overflow!;
    const amount = Math.round(docs.reduce((s, d) => s + d.amount, 0) * 100) / 100;
    const last = portions[portions.length - 1];
    return {
      id: key,
      source,
      portions,
      overflow,
      amount,
      date: lead.date,
      note: lead.note,
      createdAt: docs.reduce((min, d) => (d.createdAt < min ? d.createdAt : min), lead.createdAt),
      allocationType: overflow ? "principalPrepayment" : lead.allocationType,
      transactionId: lead.transactionId,
      installmentSeqs: portions.map((p) => seqById.get(p.installmentId)).filter((n): n is number => n != null),
      remainingAfter: last?.remainingBalanceAfterPayment ?? null,
      reversed: lead.deletedAt != null,
    };
  });
  return actions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.date.getTime() - a.date.getTime());
}

/**
 * Whether `action` can be corrected. Mirrors the repositories' own rule (`assertReversible`): only the most
 * recent active payment action — editing an older one would rewrite the payments recorded after it.
 */
export function editEligibility(action: RecordedPaymentAction, all: RecordedPaymentAction[], opts: { closed: boolean }): EditEligibility {
  if (action.reversed) return { ok: false, reason: "This payment was reversed or replaced by a correction." };
  if (opts.closed) return { ok: false, reason: `Reopen this ${action.source === "loan" ? "loan" : "EMI"} to edit its payments.` };
  if (action.source === "loan" && action.transactionId == null) {
    return { ok: false, reason: "Recorded before account tracking — this payment can't be corrected automatically." };
  }
  const latest = all.filter((a) => !a.reversed).reduce<RecordedPaymentAction | null>((best, a) => (best == null || a.createdAt > best.createdAt ? a : best), null);
  if (latest != null && latest.id !== action.id) {
    return { ok: false, reason: "Only the latest payment can be edited — a later payment was recorded after this one." };
  }
  return { ok: true };
}

/** The latest active payment action that touched `installmentId` — what tapping a paid installment opens. */
export function latestActionForInstallment(actions: RecordedPaymentAction[], installmentId: string): RecordedPaymentAction | null {
  return actions.find((a) => !a.reversed && a.portions.some((p) => p.installmentId === installmentId)) ?? null;
}

/** "Payment type" copy for the details surface. */
export function paymentTypeLabel(action: RecordedPaymentAction): string {
  switch (action.allocationType) {
    case "principalPrepayment":
      return "Extra principal payment";
    case "advanceEmi":
      return "Advance payment";
    default:
      return action.portions.length > 1 ? "Installment + advance" : action.remainingAfter != null && action.remainingAfter > 0 ? "Partial payment" : "Installment payment";
  }
}

/** "#2" / "#1–#3" / "#1, #4". */
export function installmentRangeLabel(seqs: number[]): string {
  if (seqs.length === 0) return "—";
  const sorted = [...seqs].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  if (sorted.length === 1) return `#${sorted[0]}`;
  return contiguous ? `#${sorted[0]}–#${sorted[sorted.length - 1]}` : sorted.map((n) => `#${n}`).join(", ");
}

/** The parallel id arrays the edit repositories take for the original action. */
export function originalRefs(action: RecordedPaymentAction) {
  return {
    paymentIds: action.portions.map((p) => p.id),
    installmentIds: action.portions.map((p) => p.installmentId),
    overflowPaymentId: action.overflow?.id ?? null,
    overflowInstallmentId: action.overflow?.installmentId ?? null,
  };
}

/**
 * What tapping an installment row does: "view" its latest recorded payment (where it can be corrected),
 * "pay" an installment with nothing recorded yet, or nothing (skipped / closed and unpaid).
 */
export function installmentRowAction(
  installment: Installment,
  actions: RecordedPaymentAction[],
  closed: boolean,
): { kind: "view"; action: RecordedPaymentAction } | { kind: "pay" } | null {
  const action = installment.amountPaid > 0 ? latestActionForInstallment(actions, installment.id) : null;
  if (action) return { kind: "view", action };
  if (!closed && !installment.isSkipped && installment.amountDue - installment.amountPaid > 0) return { kind: "pay" };
  return null;
}
