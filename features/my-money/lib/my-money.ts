/**
 * My Money — presentation rules only. Every amount handed in here already comes from a canonical engine
 * (`cardBillsDueInCycle`, `loanCycleDues`, `linkedPeopleForInstallments` / `linkedPeopleForCard`,
 * `peopleDirectionSides`, `summarizeMySpend`); this module only decides how an obligation reads (status,
 * order) and which of them add up to each headline. Pure: no React, no Firebase, nothing written.
 *
 * The four headlines are deliberately separate and never summed together:
 *  - To pay      — what the lender / card issuer / biller expects in the period (incl. overdue carried in),
 *                  at its live remainder. Cash to arrange, not spending: a card bill pays for purchases
 *                  already counted in My Spending when they happened.
 *  - To collect  — what people owe me right now (gross, People engine). Not period-bound: People
 *                  obligations carry no due date of their own.
 *  - My spending — My Spend engine consumption in the period.
 *  - Completed   — payments actually made in the period (by payment date).
 */

import type { LinkedPeopleReadiness, LinkedPersonState } from "@/lib/engines/linked-people-readiness";

export type ObligationKind = "card" | "loan" | "emi" | "bill";

/** How urgent an unpaid obligation is today — "paid" only when nothing remains. */
export type ObligationStatus = "overdue" | "dueToday" | "dueSoon" | "upcoming" | "paid";

/** Days ahead (inclusive) that read as "Due soon" rather than "Upcoming". */
export const DUE_SOON_DAYS = 3;

export interface SharedPerson {
  personId: string;
  name: string;
  share: number;
  received: number;
  remaining: number;
  state: LinkedPersonState;
}

/** The people side beneath one lender obligation (a shared installment, or split charges on a card bill). */
export interface SharedSplit {
  /** My agreed part of the obligation (`lenderDue − peopleShare`). */
  myShare: number;
  /** Everyone else's agreed part. */
  othersShare: number;
  /** Already reimbursed to me against those parts. */
  collected: number;
  /** Still to come in from people for this obligation. */
  toCollect: number;
  people: SharedPerson[];
}

export interface ObligationItem {
  key: string;
  kind: ObligationKind;
  /** The agreement / card / bill id — for grouping and links. */
  sourceId: string;
  title: string;
  /** Short context: "Installment 4 of 12", "Statement 18 Sep – 17 Oct". */
  detail: string;
  dueDate: Date;
  /** The whole amount for this obligation (installment / bill total). */
  amountDue: number;
  amountPaid: number;
  /** Still owed to the lender / issuer — what To pay counts. */
  remaining: number;
  status: ObligationStatus;
  /** Due in an earlier period and still unpaid. */
  carriedForward: boolean;
  /** False when another obligation already carries this money (card-funded EMI) or someone else pays it. */
  countsTowardTotal: boolean;
  /** Why it isn't counted, or other one-line context the user needs. */
  note: string | null;
  /** A card bill whose statement period is still open — the amount can still grow. */
  billStillOpen: boolean;
  shared: SharedSplit | null;
  href: string;
  actionLabel: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const EPSILON = 0.005;

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole days from today to `date` (negative = past). */
export function daysUntil(date: Date, now: Date): number {
  return Math.round((dayIndex(date) - dayIndex(now)) / 86_400_000);
}

export function obligationStatus(dueDate: Date, remaining: number, now: Date): ObligationStatus {
  if (remaining <= EPSILON) return "paid";
  const days = daysUntil(dueDate, now);
  if (days < 0) return "overdue";
  if (days === 0) return "dueToday";
  if (days <= DUE_SOON_DAYS) return "dueSoon";
  return "upcoming";
}

const STATUS_ORDER: Record<ObligationStatus, number> = { overdue: 0, dueToday: 1, dueSoon: 2, upcoming: 3, paid: 4 };
const KIND_ORDER: Record<ObligationKind, number> = { card: 0, loan: 1, emi: 2, bill: 3 };

/** Most urgent first; counted obligations before informational ones at the same urgency; then by date. */
export function compareObligations(a: ObligationItem, b: ObligationItem): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    Number(b.countsTowardTotal) - Number(a.countsTowardTotal) ||
    a.dueDate.getTime() - b.dueDate.getTime() ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.key.localeCompare(b.key)
  );
}

/** People readiness → the shared split shown under an obligation; null when no one else shares it. */
export function sharedSplitFrom(readiness: LinkedPeopleReadiness | null | undefined): SharedSplit | null {
  if (readiness == null || readiness.people.length === 0 || readiness.peopleShare <= EPSILON) return null;
  return {
    myShare: readiness.yourPortion,
    othersShare: readiness.peopleShare,
    collected: readiness.received,
    toCollect: readiness.stillExpected,
    people: readiness.people.map((p) => ({
      personId: p.personId,
      name: p.personName,
      share: p.share,
      received: p.received,
      remaining: p.remaining,
      state: p.state,
    })),
  };
}

export interface ToPaySummary {
  /** Σ remaining of counted obligations. */
  total: number;
  /** Part of `total` already past due. */
  overdue: number;
  /** Part of `total` due today or within `DUE_SOON_DAYS`. */
  dueSoon: number;
  /** Part of `total` that people still owe me for (shared installments / split card charges). */
  othersStillOwe: number;
  count: number;
  overdueCount: number;
  /** The one obligation to act on next (most urgent counted, unpaid). */
  next: ObligationItem | null;
}

export function summarizeToPay(items: readonly ObligationItem[]): ToPaySummary {
  const open = items.filter((i) => i.countsTowardTotal && i.remaining > EPSILON).sort(compareObligations);
  let total = 0;
  let overdue = 0;
  let dueSoon = 0;
  let othersStillOwe = 0;
  let overdueCount = 0;
  for (const i of open) {
    total += i.remaining;
    if (i.status === "overdue") {
      overdue += i.remaining;
      overdueCount++;
    }
    if (i.status === "dueToday" || i.status === "dueSoon") dueSoon += i.remaining;
    if (i.shared) othersStillOwe += Math.min(i.shared.toCollect, i.remaining);
  }
  return {
    total: round2(total),
    overdue: round2(overdue),
    dueSoon: round2(dueSoon),
    othersStillOwe: round2(othersStillOwe),
    count: open.length,
    overdueCount,
    next: open[0] ?? null,
  };
}

// ─────────────────────────── completed payments ───────────────────────────

export interface PaymentEvent {
  kind: ObligationKind;
  sourceId: string;
  title: string;
  /** The payment's own recorded date; null when no payment date was recorded (never substituted). */
  date: Date | null;
  /**
   * Only for an undated payment: the obligation's due date, used solely to decide which period lists it.
   * It is never shown as the payment date.
   */
  periodAnchor?: Date;
  amount: number;
  href: string;
}

/** One row per obligation paid in the period: what was paid, how many payments, the latest date. */
export interface CompletedGroup {
  key: string;
  kind: ObligationKind;
  sourceId: string;
  title: string;
  amount: number;
  /** Dated payments only. */
  payments: number;
  /** Latest recorded payment date; null when none of this group's payments has a date. */
  lastDate: Date | null;
  /** Part of `amount` paid without a recorded payment date. */
  undatedAmount: number;
  /** For an undated part: the due date that placed it in this period (context only). */
  undatedDueDate: Date | null;
  href: string;
}

export function groupCompleted(events: readonly PaymentEvent[], range: { start: Date; end: Date }): { groups: CompletedGroup[]; total: number } {
  const start = dayIndex(range.start);
  const end = dayIndex(range.end);
  const byKey = new Map<string, CompletedGroup>();
  for (const e of events) {
    if (e.amount <= EPSILON) continue;
    const placedOn = e.date ?? e.periodAnchor;
    if (placedOn == null) continue;
    const day = dayIndex(placedOn);
    if (day < start || day > end) continue;
    const key = `${e.kind}:${e.sourceId}`;
    const g =
      byKey.get(key) ??
      byKey
        .set(key, { key, kind: e.kind, sourceId: e.sourceId, title: e.title, amount: 0, payments: 0, lastDate: null, undatedAmount: 0, undatedDueDate: null, href: e.href })
        .get(key)!;
    g.amount = round2(g.amount + e.amount);
    if (e.date != null) {
      g.payments += 1;
      if (g.lastDate == null || e.date.getTime() > g.lastDate.getTime()) g.lastDate = e.date;
    } else {
      g.undatedAmount = round2(g.undatedAmount + e.amount);
      g.undatedDueDate = e.periodAnchor ?? null;
    }
  }
  const sortDate = (g: CompletedGroup) => (g.lastDate ?? g.undatedDueDate)?.getTime() ?? 0;
  const groups = [...byKey.values()].sort((a, b) => sortDate(b) - sortDate(a) || b.amount - a.amount);
  return { groups, total: round2(groups.reduce((s, g) => s + g.amount, 0)) };
}

// ─────────────────────────── spending comparison ───────────────────────────

export type SpendComparison =
  | { kind: "none" }
  /** The selected period is still running — compare amounts only, never a % against a full period. */
  | { kind: "inProgress"; previous: number }
  | { kind: "change"; previous: number; percent: number };

/**
 * A % change is shown only when both periods are complete and the previous one had spending; a running
 * period is set beside the previous total instead (half a month vs a whole month is not a trend).
 */
export function spendComparison(current: number, previous: number, periodComplete: boolean): SpendComparison {
  if (previous <= EPSILON) return { kind: "none" };
  if (!periodComplete) return { kind: "inProgress", previous: round2(previous) };
  return { kind: "change", previous: round2(previous), percent: Math.round(((current - previous) / previous) * 100) };
}
