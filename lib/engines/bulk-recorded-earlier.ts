/**
 * Bulk "already paid earlier" — several old Loan / EMI installments recorded in one go. Pure planning +
 * a sequential runner; every write is the existing single-installment recorded-earlier payment
 * (`recorded-earlier.ts`), one per installment, so there is no second accounting path:
 *
 *  - No account moves: each item is a normal recorded-earlier payment (Loan: excluded Transaction; EMI: none).
 *  - One item = one installment = one atomic, idempotent write. The key is derived from the batch id and the
 *    installment id, so a retry (same batch) finds what already committed and never writes it twice.
 *  - Each item lands on exactly its installment (Loan `onlyInstallmentId`, EMI `onlyTargetInstallment`) and
 *    never spills into another. Already paid by the time it is written (another tab) → refused, nothing written.
 *  - Items run one after another and report their own result; a failure stops nothing else, and a retry
 *    re-runs only what has not succeeded.
 *  - Dates: a known date is the user's; an unknown one is the installment's due date flagged `dateKnown: false`.
 *  - People shares are untouched (the write uses `RECORDED_EARLIER_PEOPLE_ACK`).
 */

import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { remainingAmount, type Installment, type InstallmentPayment } from "@/lib/models/payment-schedule";

export type HistoricalStatus = "paid" | "partial" | "unpaid";

export interface HistoricalCandidate {
  installment: Installment;
  status: HistoricalStatus;
  remaining: number;
  /** Some active payment on it was already recorded as paid earlier (imported before). */
  importedEarlier: boolean;
  /** Can be selected: still owes something and was due on or before today. */
  eligible: boolean;
  /** Why it can't be selected, when it can't. */
  blockedReason: string | null;
}

function endOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

/**
 * Every live installment due on or before today, oldest first, with what it still owes. `alsoInclude`: one more
 * installment offered even though it isn't due yet — the one a payment dialog was on (an installment paid ahead,
 * before FlowFi, could always be recorded as a past payment).
 */
export function historicalCandidates(
  installments: readonly Installment[],
  payments: readonly InstallmentPayment[],
  today: Date = new Date(),
  alsoInclude: string | null = null,
): HistoricalCandidate[] {
  const importedIds = new Set(payments.filter((p) => p.deletedAt == null && p.recordedEarlier != null).map((p) => p.installmentId));
  return installments
    .filter((i) => i.deletedAt == null && !i.isSkipped && (i.dueDate.getTime() <= endOfDay(today) || i.id === alsoInclude))
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .map((installment) => {
      const remaining = round2(Math.max(0, remainingAmount(installment)));
      const status: HistoricalStatus = remaining <= PAYMENT_EPSILON ? "paid" : installment.amountPaid > PAYMENT_EPSILON ? "partial" : "unpaid";
      return {
        installment,
        status,
        remaining,
        importedEarlier: importedIds.has(installment.id),
        eligible: status !== "paid",
        blockedReason: status === "paid" ? "Already paid" : null,
      };
    });
}

/**
 * How the dates of several past payments are entered — always the user's explicit choice, never assumed:
 *  - "due":     each was paid on its own due date (a known date);
 *  - "same":    one date for all of them;
 *  - "each":    a date typed per installment (blank = not known);
 *  - "unknown": not known — each is stored on its due date, flagged `dateKnown: false`.
 */
export type BulkDateMode = "due" | "same" | "each" | "unknown";

const toInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The typed date (`BulkDraftItem.date`) an installment is planned with under `mode`. Blank = not known. */
export function bulkDraftDate(mode: BulkDateMode, dueDate: Date, shared: string, own: string): string {
  switch (mode) {
    case "due":
      return toInput(dueDate);
    case "same":
      return shared;
    case "each":
      return own;
    case "unknown":
      return "";
  }
}

export interface BulkDraftItem {
  installmentId: string;
  /** What was paid for it, as typed; blank = what it still owes. */
  amount: string;
  /** "YYYY-MM-DD" as typed; blank = date not known (stored on the due date, flagged). */
  date: string;
}

export interface BulkItem {
  installment: Installment;
  amount: number;
  date: Date;
  dateKnown: boolean;
  idempotencyKey: string;
}

export type BulkPlan = { ok: true; items: BulkItem[]; total: number } | { ok: false; errors: Record<string, string> };

function inputToDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  // Noon local — the same convention as a single payment's date input, so it never slips a day.
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
}

/** Deterministic per batch + installment: a retry of the same batch is a no-op for what already committed. */
export function bulkItemKey(batchId: string, installmentId: string): string {
  return `bulk_${batchId}_${installmentId}`;
}

export function planBulkRecordedEarlier(params: {
  candidates: readonly HistoricalCandidate[];
  draft: readonly BulkDraftItem[];
  batchId: string;
  today?: Date;
}): BulkPlan {
  const today = params.today ?? new Date();
  const byId = new Map(params.candidates.map((c) => [c.installment.id, c]));
  const errors: Record<string, string> = {};
  const items: BulkItem[] = [];
  const seen = new Set<string>();
  for (const d of params.draft) {
    if (seen.has(d.installmentId)) continue;
    seen.add(d.installmentId);
    const c = byId.get(d.installmentId);
    if (!c || !c.eligible) {
      errors[d.installmentId] = "Already paid — remove it from the selection.";
      continue;
    }
    const amount = d.amount.trim() === "" ? c.remaining : round2(Number(d.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      errors[d.installmentId] = "Enter an amount greater than 0.";
      continue;
    }
    if (amount > c.remaining + PAYMENT_EPSILON) {
      errors[d.installmentId] = `More than it still owes (${c.remaining.toLocaleString("en-IN", { maximumFractionDigits: 2 })}).`;
      continue;
    }
    let date: Date;
    let dateKnown = true;
    if (d.date.trim() === "") {
      // An unknown date is stored on the due date — which can't be in the future for a payment already made.
      if (c.installment.dueDate.getTime() > endOfDay(today)) {
        errors[d.installmentId] = "Not due yet — enter the date it was paid.";
        continue;
      }
      date = c.installment.dueDate;
      dateKnown = false;
    } else {
      const parsed = inputToDate(d.date);
      if (!parsed) {
        errors[d.installmentId] = "Enter a valid date.";
        continue;
      }
      if (parsed.getTime() > endOfDay(today)) {
        errors[d.installmentId] = "A payment already made can't be dated in the future.";
        continue;
      }
      date = parsed;
    }
    items.push({ installment: c.installment, amount: Math.min(amount, c.remaining), date, dateKnown, idempotencyKey: bulkItemKey(params.batchId, c.installment.id) });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  items.sort((a, b) => a.installment.sequenceNumber - b.installment.sequenceNumber);
  return { ok: true, items, total: round2(items.reduce((t, i) => t + i.amount, 0)) };
}

export type BulkItemResult = { status: "recorded" } | { status: "alreadyRecorded" } | { status: "failed"; error: string };

export function isBulkDone(r: BulkItemResult | undefined): boolean {
  return r != null && r.status !== "failed";
}

/**
 * Runs the items one after another (each its own atomic write), skipping any that already succeeded in an
 * earlier run of the same batch. Never throws: every item gets a result.
 */
export async function runBulkRecordedEarlier(
  items: readonly BulkItem[],
  recordOne: (item: BulkItem) => Promise<{ alreadyRecorded: boolean }>,
  opts: { previous?: Readonly<Record<string, BulkItemResult>>; onResult?: (installmentId: string, result: BulkItemResult) => void } = {},
): Promise<Record<string, BulkItemResult>> {
  const results: Record<string, BulkItemResult> = { ...(opts.previous ?? {}) };
  for (const item of items) {
    const id = item.installment.id;
    if (isBulkDone(results[id])) continue;
    let result: BulkItemResult;
    try {
      const r = await recordOne(item);
      result = r.alreadyRecorded ? { status: "alreadyRecorded" } : { status: "recorded" };
    } catch (e) {
      result = { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    results[id] = result;
    opts.onResult?.(id, result);
  }
  return results;
}
