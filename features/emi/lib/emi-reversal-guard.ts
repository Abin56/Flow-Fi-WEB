/**
 * Write-time eligibility for "Mark as unpaid" on an EMI payment action — the EMI counterpart of the Loan
 * repository's `assertReversible` / `assertScheduleUnchanged`. Only the most recent active payment action on
 * the schedule may be undone (undoing an older one would rewrite how every later payment was allocated), and
 * the exact payment docs being undone must still be live and unchanged. The preflight runs on fresh reads
 * before the Firestore transaction (queries can't run inside one); `assertEmiReversalStillValid` re-checks it
 * on documents read INSIDE the transaction, so a payment committed from another tab in between makes the
 * transaction retry and land on the refusal. Pure.
 */

import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";

export const EMI_LATER_PAYMENT_MESSAGE = "A later payment was recorded on this EMI — undo that one first, then this one.";
export const EMI_SCHEDULE_CHANGED_MESSAGE = "This EMI changed while undoing (another payment was recorded) — refresh and try again.";
export const EMI_TARGET_CHANGED_MESSAGE = "This payment was changed in another tab — refresh and try again.";

/** What a reversal relies on per installment: how much is paid on it and whether it is still part of the schedule. */
export function emiInstallmentFingerprint(i: Installment): string {
  return `${i.amountPaid}|${i.amountDue}|${i.isSkipped ? "skipped" : "open"}|${i.deletedAt == null ? "live" : "deleted"}`;
}

/** What identifies one target payment doc as the one the caller saw. */
export function emiPaymentFingerprint(p: InstallmentPayment): string {
  return `${p.installmentId}|${p.amount}|${p.createdAt.getTime()}|${p.deletedAt == null ? "live" : "deleted"}`;
}

/**
 * Why the target action can't be undone because a later one exists, or null. `targets` are the action's own
 * active payment docs; `active` is every active payment doc on the schedule. "Later" = created strictly after
 * the action (the same rule as the Loan repository and `undoChain`).
 */
export function laterEmiPaymentBlock(targets: readonly InstallmentPayment[], active: readonly InstallmentPayment[]): string | null {
  if (targets.length === 0) return null;
  const targetIds = new Set(targets.map((t) => t.id));
  const createdAt = Math.min(...targets.map((t) => t.createdAt.getTime()));
  const later = active.some((p) => p.deletedAt == null && !targetIds.has(p.id) && p.createdAt.getTime() > createdAt);
  return later ? EMI_LATER_PAYMENT_MESSAGE : null;
}

export interface EmiReversalPreflight {
  /** Fingerprint of every installment on the schedule (live and trashed) as the preflight saw it. */
  installments: ReadonlyMap<string, string>;
  /** Fingerprint of each target payment doc that was active at preflight. */
  targets: ReadonlyMap<string, string>;
}

/** Builds the preflight snapshot, plus the refusal message when a later payment already blocks the reversal. */
export function planEmiReversalPreflight(params: {
  installments: readonly Installment[];
  activePayments: readonly InstallmentPayment[];
  targetPaymentIds: readonly string[];
}): { preflight: EmiReversalPreflight; block: string | null } {
  const ids = new Set(params.targetPaymentIds);
  const targets = params.activePayments.filter((p) => ids.has(p.id) && p.deletedAt == null);
  return {
    preflight: {
      installments: new Map(params.installments.map((i) => [i.id, emiInstallmentFingerprint(i)])),
      targets: new Map(targets.map((p) => [p.id, emiPaymentFingerprint(p)])),
    },
    block: laterEmiPaymentBlock(targets, params.activePayments),
  };
}

/**
 * Inside the transaction. `freshTargets` = the target payment docs as read in the transaction (null = missing),
 * in `targetPaymentIds` order; `freshInstallments` = every preflight installment re-read in the transaction.
 * Returns "alreadyReversed" when every target is already gone (a repeat / second tab — nothing to write),
 * "proceed" when safe, or the refusal message.
 */
export function assertEmiReversalStillValid(params: {
  preflight: EmiReversalPreflight;
  freshTargets: readonly (InstallmentPayment | null)[];
  freshInstallments: ReadonlyMap<string, Installment | null>;
}): { ok: true; outcome: "alreadyReversed" | "proceed" } | { ok: false; message: string } {
  const live = params.freshTargets.filter((p): p is InstallmentPayment => p != null && p.deletedAt == null);
  if (live.length === 0) return { ok: true, outcome: "alreadyReversed" };
  // Partly undone, or a doc that wasn't live (or looked different) when the preflight ran: not the action the caller saw.
  if (live.length !== params.freshTargets.length) return { ok: false, message: EMI_TARGET_CHANGED_MESSAGE };
  for (const p of live) {
    if (params.preflight.targets.get(p.id) !== emiPaymentFingerprint(p)) return { ok: false, message: EMI_TARGET_CHANGED_MESSAGE };
  }
  for (const [id, fingerprint] of params.preflight.installments) {
    const fresh = params.freshInstallments.get(id);
    if (fresh == null || emiInstallmentFingerprint(fresh) !== fingerprint) return { ok: false, message: EMI_SCHEDULE_CHANGED_MESSAGE };
  }
  return { ok: true, outcome: "proceed" };
}
