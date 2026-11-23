/**
 * The pair behind "Already paid → people paid me back": a Loan / EMI payment to the lender and the
 * People receipts written right after it by the same Record Payment dialog (`useHistoricalReimbursement`).
 * They are two separate records (see `historical-reimbursement.ts`), so nothing stored links them directly —
 * the link is proven by what BOTH carry:
 *   - the People payment id is `pp_hist_…` (that dialog's deterministic key; a receipt typed in People later
 *     never has it, so it is never swept in),
 *   - its ledger entries settle `loan-inst:{id}` / `emi-inst:{id}` for an installment the lender payment covered,
 *   - both were written within moments of each other.
 * Pure — the I/O half lives in `features/activity/lib/undo-resolve.ts`.
 */

import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";

/** The dialog writes the lender payment, then each receipt, one after another — minutes at the very most. */
export const PAIRED_RECEIPT_WINDOW_MS = 30 * 60 * 1000;

const HIST_PAYMENT_PREFIX = "pp_hist_";

export interface PairingEntry {
  personId: string;
  paymentId: string | null | undefined;
  obligationRef: string | null | undefined;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface PairedReceiptRef {
  personId: string;
  paymentId: string;
}

/** `loan-inst:abc` → `{ source: "loan", installmentId: "abc" }`. */
export function parseInstallmentObligation(ref: string | null | undefined): { source: "loan" | "emi"; installmentId: string } | null {
  if (!ref) return null;
  if (ref.startsWith("loan-inst:")) return { source: "loan", installmentId: ref.slice("loan-inst:".length) };
  if (ref.startsWith("emi-inst:")) return { source: "emi", installmentId: ref.slice("emi-inst:".length) };
  return null;
}

function livePairingEntries(entries: readonly PairingEntry[]): (PairingEntry & { paymentId: string })[] {
  return entries.filter((e): e is PairingEntry & { paymentId: string } => e.deletedAt == null && typeof e.paymentId === "string" && e.paymentId.startsWith(HIST_PAYMENT_PREFIX));
}

/** The receipts (one per person × installment) that were written alongside this lender payment. */
export function receiptsPairedWithPayment(entries: readonly PairingEntry[], action: Pick<RecordedPaymentAction, "source" | "portions" | "createdAt">): PairedReceiptRef[] {
  const covered = new Set(action.portions.map((p) => p.installmentId));
  const found = new Map<string, PairedReceiptRef>();
  for (const e of livePairingEntries(entries)) {
    const parsed = parseInstallmentObligation(e.obligationRef);
    if (!parsed || parsed.source !== action.source || !covered.has(parsed.installmentId)) continue;
    if (Math.abs(e.createdAt.getTime() - action.createdAt.getTime()) > PAIRED_RECEIPT_WINDOW_MS) continue;
    found.set(`${e.personId}|${e.paymentId}`, { personId: e.personId, paymentId: e.paymentId });
  }
  return [...found.values()];
}

/** The lender payment a receipt was written alongside: the live action covering its installment, closest in time. */
export function lenderActionForReceipt<A extends Pick<RecordedPaymentAction, "source" | "portions" | "createdAt" | "reversed">>(
  entries: readonly PairingEntry[],
  paymentId: string,
  actions: readonly A[],
): A | null {
  let best: { action: A; gap: number } | null = null;
  for (const e of livePairingEntries(entries)) {
    if (e.paymentId !== paymentId) continue;
    const parsed = parseInstallmentObligation(e.obligationRef);
    if (!parsed) continue;
    for (const action of actions) {
      if (action.reversed || action.source !== parsed.source || !action.portions.some((p) => p.installmentId === parsed.installmentId)) continue;
      const gap = Math.abs(e.createdAt.getTime() - action.createdAt.getTime());
      if (gap <= PAIRED_RECEIPT_WINDOW_MS && (best == null || gap < best.gap)) best = { action, gap };
    }
  }
  return best?.action ?? null;
}
