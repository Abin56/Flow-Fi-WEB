/**
 * "A person paid the LENDER directly" — the one set of rules every screen that records it must hold to
 * (Pay now, Pay several, and finishing a People record that didn't save). Pure: nothing here writes.
 *
 * The two records stay what they already are — the lender payment (`InstallmentPayment`, `recordedEarlier`,
 * note starting `Paid directly by `) and each person's receipt (`LedgerEntry`, `recordedEarlier`, note
 * starting `PAID_DIRECTLY_NOTE`). No new field links them, so what is still missing is DERIVED per
 * installment by comparing the two sides:
 *  - no direct lender record                         → nothing direct happened (or it never started);
 *  - lender paid, nothing credited, a share open     → `notCredited`;
 *  - lender paid, part credited, a share still open  → `partlyCredited` — this is a fact, not a verdict: who
 *    was MEANT to be credited isn't stored, so a failed second person and a deliberately unpaid one look alike;
 *  - no share open, or all of it credited            → `complete`;
 *  - more credited than was paid directly            → `overCredited` (e.g. the lender payment was undone).
 *
 * LIMIT: recognition rests on the two note prefixes. A lender payment whose note was rewritten is no longer
 * seen as direct.
 */

import { isPaidDirectlyEntry, type ReimbursementItem, type ReimbursementLine } from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { formatCurrencyExact } from "@/lib/format";
import type { InstallmentPayment } from "@/lib/models/payment-schedule";
import type { LedgerEntry } from "@/lib/models/person";

export const LENDER_DIRECT_NOTE_PREFIX = "Paid directly by ";

/** The lender record's note: only the people actually credited, with what each covered. */
export function directLenderNote(items: readonly Pick<ReimbursementItem, "personId" | "personName" | "amount">[], fallback: string): string {
  const byPerson = new Map<string, { name: string; amount: number }>();
  for (const i of items) {
    const p = byPerson.get(i.personId) ?? { name: i.personName, amount: 0 };
    byPerson.set(i.personId, { name: p.name, amount: round2(p.amount + i.amount) });
  }
  const payers = [...byPerson.values()].map((p) => `${p.name} ${formatCurrencyExact(p.amount)}`);
  return `${LENDER_DIRECT_NOTE_PREFIX}${payers.length > 0 ? payers.join(", ") : fallback}`;
}

export function isDirectLenderPayment(p: Pick<InstallmentPayment, "recordedEarlier" | "note" | "deletedAt">): boolean {
  return p.deletedAt == null && p.recordedEarlier != null && typeof p.note === "string" && p.note.startsWith(LENDER_DIRECT_NOTE_PREFIX);
}

/** What one lender payment puts on one installment. */
export interface LenderPortion {
  installmentId: string;
  sequenceNumber: number;
  amount: number;
}

/**
 * Why these People credits can't go with this lender payment (null = they can). Checked BEFORE the lender
 * write: it commits first, so anything wrong here would otherwise already be half saved.
 */
export function directSettlementError(params: {
  lender: readonly LenderPortion[];
  items: readonly Pick<ReimbursementItem, "personId" | "personName" | "installmentId" | "amount" | "recordedEarlier">[];
  lines: readonly Pick<ReimbursementLine, "personId" | "installmentId" | "remaining">[];
  /** A new direct payment must name its payer on every installment that still has an open share. */
  requirePayer: boolean;
}): string | null {
  const seen = new Set<string>();
  for (const item of params.items) {
    const portion = params.lender.find((p) => p.installmentId === item.installmentId);
    if (!portion) return `${item.personName}'s amount belongs to an installment this lender payment doesn't cover.`;
    if (!(item.amount > 0)) return "Enter an amount above zero.";
    if (!item.recordedEarlier) return "Money paid to the lender never reaches your account, so it can't be added to one.";
    const key = `${item.personId}|${item.installmentId}`;
    if (seen.has(key)) return `${item.personName} is listed twice for #${portion.sequenceNumber}.`;
    seen.add(key);
    const line = params.lines.find((l) => l.personId === item.personId && l.installmentId === item.installmentId);
    if (!line || item.amount > line.remaining + PAYMENT_EPSILON) return `That's more than ${item.personName} still owes for #${portion.sequenceNumber}.`;
  }
  for (const portion of params.lender) {
    const own = params.items.filter((i) => i.installmentId === portion.installmentId);
    const open = params.lines.some((l) => l.installmentId === portion.installmentId && l.remaining > PAYMENT_EPSILON);
    if (params.requirePayer && open && own.length === 0) {
      return `Choose who paid #${portion.sequenceNumber}. If nobody sharing it paid, record it as a past payment instead.`;
    }
    if (round2(own.reduce((t, i) => t + i.amount, 0)) > portion.amount + PAYMENT_EPSILON) {
      return `The people chosen for #${portion.sequenceNumber} cover more than the ${formatCurrencyExact(portion.amount)} paid to the lender.`;
    }
  }
  return null;
}

export type DirectSettlementState = "notCredited" | "partlyCredited" | "complete" | "overCredited";

export interface DirectSettlementStatus {
  state: DirectSettlementState;
  /** Active direct lender payments on this installment. */
  lenderDirect: number;
  /** Active People receipts on this installment recorded as paid directly to the lender. */
  credited: number;
  /** `lenderDirect − credited`, never below zero. */
  uncredited: number;
  /** What the people sharing it still owe for it. */
  openShare: number;
  /** The latest direct lender payment's date. */
  paidOn: Date | null;
}

type CreditEntry = Pick<LedgerEntry, "obligationRef" | "amount" | "note" | "recordedEarlier" | "deletedAt">;

export function directCreditedFor(entries: readonly CreditEntry[], obligationKey: string): number {
  return round2(entries.filter((e) => e.deletedAt == null && e.obligationRef === obligationKey && isPaidDirectlyEntry(e)).reduce((t, e) => t + e.amount, 0));
}

export function directLenderPaidFor(payments: readonly Pick<InstallmentPayment, "installmentId" | "amount" | "recordedEarlier" | "note" | "deletedAt">[], installmentId: string): number {
  return round2(payments.filter((p) => p.installmentId === installmentId && isDirectLenderPayment(p)).reduce((t, p) => t + p.amount, 0));
}

/** One installment's two sides. Null when neither side has anything recorded as paid directly. */
export function directSettlementStatus(params: {
  installmentId: string;
  /** `emi-inst:{id}` / `loan-inst:{id}`. */
  obligationKey: string;
  payments: readonly Pick<InstallmentPayment, "installmentId" | "amount" | "date" | "recordedEarlier" | "note" | "deletedAt">[];
  /** Every person's ledger entries. */
  entries: readonly CreditEntry[];
  lines: readonly Pick<ReimbursementLine, "installmentId" | "remaining">[];
}): DirectSettlementStatus | null {
  const lenderDirect = directLenderPaidFor(params.payments, params.installmentId);
  const credited = directCreditedFor(params.entries, params.obligationKey);
  if (lenderDirect <= PAYMENT_EPSILON && credited <= PAYMENT_EPSILON) return null;
  const uncredited = round2(Math.max(0, lenderDirect - credited));
  const openShare = round2(params.lines.filter((l) => l.installmentId === params.installmentId).reduce((t, l) => t + l.remaining, 0));
  const paidOn = params.payments
    .filter((p) => p.installmentId === params.installmentId && isDirectLenderPayment(p))
    .reduce<Date | null>((latest, p) => (latest == null || p.date > latest ? p.date : latest), null);
  const state: DirectSettlementState =
    credited > lenderDirect + PAYMENT_EPSILON
      ? "overCredited"
      : openShare <= PAYMENT_EPSILON || uncredited <= PAYMENT_EPSILON
        ? "complete"
        : credited <= PAYMENT_EPSILON
          ? "notCredited"
          : "partlyCredited";
  return { state, lenderDirect, credited, uncredited, openShare, paidOn };
}

/**
 * Installments where People would credit more than the direct lender payments left on them — what an edit or
 * "Mark as unpaid" would strand. `payments` is every direct-capable payment that will remain afterwards.
 */
export function strandedDirectCredits(params: {
  installments: readonly { installmentId: string; sequenceNumber: number; obligationKey: string }[];
  payments: Parameters<typeof directLenderPaidFor>[0];
  entries: readonly CreditEntry[];
}): { sequenceNumber: number; credited: number; lenderDirect: number }[] {
  return params.installments
    .map((i) => ({ sequenceNumber: i.sequenceNumber, credited: directCreditedFor(params.entries, i.obligationKey), lenderDirect: directLenderPaidFor(params.payments, i.installmentId) }))
    .filter((r) => r.credited > r.lenderDirect + PAYMENT_EPSILON);
}
