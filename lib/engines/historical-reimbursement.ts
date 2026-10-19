/**
 * Historical participant reimbursements — when old Loan / EMI installments are marked as paid to the lender,
 * whether the people sharing them had already paid me back. Pure planning + a sequential runner over the ONE
 * People settlement path (`PersonPaymentRepository.recordPayment`); nothing here is a second ledger:
 *
 *  - The lender payment and each person's reimbursement stay separate records. Paying the lender never
 *    settles anyone; only an explicit choice here writes a People settlement.
 *  - What a person still owes is read from the People statement (`installmentBreakdown` → `current`), so a
 *    reimbursement already recorded in People shows as received and is never offered — or written — again.
 *  - My own share is never a receivable: only participants' share rows are listed.
 *  - Per reimbursement (person × installment), never one answer for a whole batch: "Already included in my
 *    account" → the settlement is `recordedEarlier` (its cash leg is excluded: no account moves); "Add money to
 *    my account" → an ordinary receipt that credits the chosen account. Received with no answer = not saved.
 *  - The received date is the person's, as typed — never the lender payment's date. Left blank it is unknown:
 *    stored on the installment's due date only as a placeholder (the model needs a date) and flagged
 *    `dateKnown: false` (`LedgerEntry.receivedDateKnown`), shown as "Date not known".
 *  - One item = one person × one installment = one atomic payment with a deterministic idempotency key, so a
 *    double submit or a retry of the same batch never writes it twice; a retry re-runs only failed items.
 */

import { installmentBreakdown, type ShareLine } from "@/lib/engines/installment-participants";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import type { Installment } from "@/lib/models/payment-schedule";

export type ReceivedChoice = "full" | "some" | "none";
/** Where the received money already is: in my FlowFi balance, or still to be added to an account. */
export type BalanceTreatment = "included" | "addToAccount";

/** One person's share of one historical installment, as People sees it now. */
export interface ReimbursementLine {
  personId: string;
  personName: string;
  installmentId: string;
  sequenceNumber: number;
  /** The installment's due date — only the placeholder for an unknown received date. */
  dueDate: Date;
  /** People obligation key (`emi-inst:` / `loan-inst:`). */
  obligationKey: string;
  share: number;
  /** Already received in People (any earlier settlement or applied advance). */
  received: number;
  remaining: number;
}

export interface ReimbursementDraft {
  choice: ReceivedChoice;
  /** Typed amount for "some". */
  amount: string;
  /** Where this money is now; required once something was received. */
  treatment?: BalanceTreatment | null;
  /** "YYYY-MM-DD" the person paid; blank = not known. */
  date?: string;
}

export interface ReimbursementItem {
  /** Idempotency key for the People payment. */
  key: string;
  personId: string;
  personName: string;
  installmentId: string;
  obligationKey: string;
  amount: number;
  /** The typed received date, or (unknown) the installment's due date as a placeholder. */
  date: Date;
  dateKnown: boolean;
  recordedEarlier: boolean;
}

export interface ReimbursementPersonSummary {
  personId: string;
  personName: string;
  share: number;
  alreadyReceived: number;
  receivedNow: number;
  remainingAfter: number;
}

export interface ReimbursementSummary {
  total: number;
  people: ReimbursementPersonSummary[];
  /** How much the chosen account goes up by (0 when the money is already included). */
  balanceChange: number;
}

export type ReimbursementPlan =
  | { ok: true; items: ReimbursementItem[]; summary: ReimbursementSummary }
  | { ok: false; errors: Record<string, string> };

const lineFrom = (personId: string, personName: string, l: ShareLine): ReimbursementLine => ({
  personId,
  personName,
  installmentId: l.installmentId,
  sequenceNumber: l.sequenceNumber,
  dueDate: l.dueDate,
  obligationKey: l.key,
  share: l.share,
  received: l.received,
  remaining: l.remaining,
});

/** Every participant's share of the given installments, read from the People statements (whole history). */
export function reimbursementLines(params: {
  statements: readonly Pick<PersonCycleStatement, "personId" | "personName" | "rows">[];
  installments: readonly Installment[];
  installmentIds: readonly string[];
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
}): ReimbursementLine[] {
  const lines: ReimbursementLine[] = [];
  for (const installmentId of params.installmentIds) {
    const b = installmentBreakdown({ ...params, installmentId });
    for (const p of b?.participants ?? []) if (p.current) lines.push(lineFrom(p.personId, p.personName, p.current));
  }
  return lines.sort((a, b) => a.personName.localeCompare(b.personName) || a.sequenceNumber - b.sequenceNumber);
}

/** One answer per person × installment (the obligation key alone is shared by everyone on that installment). */
export function reimbursementLineKey(l: Pick<ReimbursementLine, "personId" | "obligationKey">): string {
  return `${l.personId}|${l.obligationKey}`;
}

/** Deterministic per batch × person × installment. */
export function reimbursementKey(batchId: string, personId: string, installmentId: string): string {
  return `hist_${batchId}_${personId}_${installmentId}`;
}

function inputToDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  // Noon local — the date-input convention used across Loan & EMI, so it never slips a day.
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
}

function endOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

export function planReimbursements(params: {
  lines: readonly ReimbursementLine[];
  /** By `reimbursementLineKey`; a line without a draft is "none" (never assumed received). */
  draft: Readonly<Record<string, ReimbursementDraft>>;
  batchId: string;
  today?: Date;
}): ReimbursementPlan {
  const today = params.today ?? new Date();
  const errors: Record<string, string> = {};
  const items: ReimbursementItem[] = [];
  const byPerson = new Map<string, ReimbursementPersonSummary>();
  for (const l of params.lines) {
    const s = byPerson.get(l.personId) ?? { personId: l.personId, personName: l.personName, share: 0, alreadyReceived: 0, receivedNow: 0, remainingAfter: 0 };
    byPerson.set(l.personId, s);
    s.share = round2(s.share + l.share);
    s.alreadyReceived = round2(s.alreadyReceived + l.received);
    const lineKey = reimbursementLineKey(l);
    const d = params.draft[lineKey];
    let amount = 0;
    if (l.remaining > PAYMENT_EPSILON && d && d.choice !== "none") {
      amount = d.choice === "full" ? l.remaining : round2(Number(d.amount));
      if (d.choice === "some") {
        if (!Number.isFinite(amount) || amount <= 0) errors[lineKey] = "Enter the amount received.";
        else if (amount > l.remaining + PAYMENT_EPSILON) errors[lineKey] = `More than ${l.personName} still owes for this one.`;
      }
    }
    if (errors[lineKey]) continue;
    amount = Math.min(amount, l.remaining);
    s.receivedNow = round2(s.receivedNow + amount);
    s.remainingAfter = round2(s.remainingAfter + l.remaining - amount);
    if (amount <= PAYMENT_EPSILON) continue;
    const typed = (d?.date ?? "").trim();
    const parsed = typed === "" ? null : inputToDate(typed);
    if (typed !== "" && parsed == null) errors[lineKey] = "Enter a valid date, or leave it blank if you don't know it.";
    else if (parsed && parsed.getTime() > endOfDay(today)) errors[lineKey] = "Money already received can't be dated in the future.";
    else if (d?.treatment == null) errors[lineKey] = "Say whether this money is already in your account.";
    if (errors[lineKey]) continue;
    // Unknown: the due date is only a placeholder — never later than today.
    const date = parsed ?? (l.dueDate.getTime() > endOfDay(today) ? today : l.dueDate);
    items.push({
      key: reimbursementKey(params.batchId, l.personId, l.installmentId),
      personId: l.personId,
      personName: l.personName,
      installmentId: l.installmentId,
      obligationKey: l.obligationKey,
      amount,
      date,
      dateKnown: parsed != null,
      recordedEarlier: d!.treatment === "included",
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const total = round2(items.reduce((t, i) => t + i.amount, 0));
  return {
    ok: true,
    items,
    summary: { total, people: [...byPerson.values()], balanceChange: round2(items.filter((i) => !i.recordedEarlier).reduce((t, i) => t + i.amount, 0)) },
  };
}

export type ReimbursementResult = { status: "recorded" } | { status: "failed"; error: string };

/**
 * Runs the items one after another (each its own atomic, idempotent People payment), skipping any that
 * already succeeded in an earlier run of the same batch. Never throws: every item gets a result.
 */
export async function runReimbursements(
  items: readonly ReimbursementItem[],
  recordOne: (item: ReimbursementItem) => Promise<void>,
  previous: Readonly<Record<string, ReimbursementResult>> = {},
): Promise<Record<string, ReimbursementResult>> {
  const results: Record<string, ReimbursementResult> = { ...previous };
  for (const item of items) {
    if (results[item.key]?.status === "recorded") continue;
    try {
      await recordOne(item);
      results[item.key] = { status: "recorded" };
    } catch (e) {
      results[item.key] = { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }
  return results;
}
