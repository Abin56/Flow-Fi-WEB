/**
 * Undoing a recorded payment action in memory — the first half of editing a payment. Edit = reverse the
 * original action's effect on the schedule, then allocate the corrected amount through the normal
 * recording engine against that reversed state, so the result is exactly what recording the corrected
 * payment in the first place would have produced — never "old effect + new effect". Pure; the
 * repositories run it on installments read fresh inside one Firestore transaction.
 */

import { recordEdit } from "@/lib/firestore/soft-deletable";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";

/**
 * `installments` with every active payment in `payments` taken back out of its installment's
 * `amountPaid` (clamped to `[0, amountDue]`, audit-trailed). Ledger-only principal-prepayment records
 * were never applied to an installment, so they're skipped. Installments not touched are returned as-is.
 */
export function reversePaymentPortions(installments: Installment[], payments: InstallmentPayment[]): Installment[] {
  const byId = new Map(installments.map((i) => [i.id, i]));
  for (const payment of payments) {
    if (payment.deletedAt != null || payment.allocationType === "principalPrepayment") continue;
    const current = byId.get(payment.installmentId);
    if (current == null) continue;
    const newAmountPaid = Math.min(Math.max(Math.round((current.amountPaid - payment.amount) * 100) / 100, 0), current.amountDue);
    byId.set(current.id, { ...recordEdit(current, "amountPaid", String(current.amountPaid), String(newAmountPaid)), amountPaid: newAmountPaid });
  }
  return installments.map((i) => byId.get(i.id)!);
}

/** Final installment docs to write: `base` overlaid with `updates` (the later write wins per id), only those that changed. */
export function mergeInstallmentWrites(original: Installment[], ...layers: Installment[][]): Installment[] {
  const byId = new Map<string, Installment>();
  for (const layer of layers) for (const i of layer) byId.set(i.id, i);
  const originalById = new Map(original.map((i) => [i.id, i]));
  return Array.from(byId.values()).filter((i) => originalById.get(i.id) !== i);
}

/**
 * Per-account balance change of replacing `removed` Transactions with `added` ones: each removed movement
 * undone once, each added one applied once — so an edited payment moves the account by the difference,
 * never by old + new. Accounts that net to 0 are still listed (callers skip writing them).
 */
export function netBalanceDeltas(
  removed: Pick<Transaction, "accountId" | "type" | "amount" | "excludeFromCalculations">[],
  added: Pick<Transaction, "accountId" | "type" | "amount" | "excludeFromCalculations">[],
): Map<string, number> {
  const deltas = new Map<string, number>();
  const add = (id: string, v: number) => deltas.set(id, Math.round(((deltas.get(id) ?? 0) + v) * 100) / 100);
  for (const t of removed) add(t.accountId, -balanceEffect(t as Transaction));
  for (const t of added) add(t.accountId, balanceEffect(t as Transaction));
  return deltas;
}
