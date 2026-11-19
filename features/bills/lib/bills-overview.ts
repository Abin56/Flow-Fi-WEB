/**
 * Bills dashboard model — presentation rules only. Every amount handed in already comes from the canonical
 * engines through `buildCycleObligations` / `buildCompletedEvents` (`features/my-money/lib/cycle-obligations.ts`,
 * the same builder My Money uses), so this module creates no obligation, moves no balance and re-derives no figure:
 * it only decides which obligation sits in which section and which of them add up to each headline.
 *
 * The four headlines (all counted obligations only — an installment already inside a card statement is listed as
 * "Included in card bill" and never added):
 *  - Due this cycle — everything still owed in the selected Month Cycle: bills due inside it plus anything from an
 *                     earlier cycle that is still unpaid (carried forward). Equals My Money's "To pay" and Month
 *                     Cycle's obligations, by construction.
 *  - Overdue        — the part of that already past its due date (never silently dropped when a cycle rolls over).
 *  - Upcoming       — what falls due in the NEXT cycle (a card's still-open statement included, flagged as growing).
 *  - Paid           — payments actually recorded in the selected cycle, by their own payment date.
 * Pure: no React, no Firebase.
 */

import { compareObligations, summarizeToPay, type CompletedGroup, type ObligationItem, type ObligationKind, type ToPaySummary } from "@/features/my-money/lib/my-money";

const EPS = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;

export const OBLIGATION_KINDS: readonly ObligationKind[] = ["bill", "loan", "emi", "card"];

export type KindFilter = "all" | ObligationKind;
export type StatusFilter = "all" | "overdue" | "dueSoon" | "upcoming" | "partial" | "paid";

export interface BillsFilters {
  kind: KindFilter;
  status: StatusFilter;
}

export const DEFAULT_FILTERS: BillsFilters = { kind: "all", status: "all" };

export interface BillsOverviewSummary {
  /** Σ remaining of counted obligations owed in the cycle (carried overdue included). */
  dueThisCycle: number;
  dueThisCycleCount: number;
  /** Part of `dueThisCycle` already past due. */
  overdue: number;
  overdueCount: number;
  /** Part of `dueThisCycle` due today or within the "due soon" window. */
  dueSoon: number;
  /** `dueThisCycle − overdue` — still to come in the cycle. */
  stillToCome: number;
  /** Counted obligations falling due in the NEXT cycle. */
  upcoming: number;
  upcomingCount: number;
  /** Recorded payments in the cycle. */
  paid: number;
  paidCount: number;
  /** `dueThisCycle` split by what owes it. */
  byKind: Record<ObligationKind, number>;
  /** Installments already inside a card statement — shown, never added. */
  coveredElsewhere: { count: number; amount: number };
  /** The one obligation to act on next. */
  next: ObligationItem | null;
}

export interface BillsOverview {
  summary: BillsOverviewSummary;
  /** Counted, unpaid, already past due — oldest first. */
  overdue: ObligationItem[];
  /** Counted, unpaid, due today or later inside the selected cycle. */
  dueThisCycle: ObligationItem[];
  /** Counted obligations of the NEXT cycle only (carried items already sit in the lists above). */
  upcoming: ObligationItem[];
  /** Listed for completeness, never added: already inside a card statement, or paid by someone else. */
  coveredElsewhere: ObligationItem[];
  paid: CompletedGroup[];
  /** The To-pay summary of the selected cycle — identical to My Money's. */
  toPay: ToPaySummary;
}

const isOpen = (i: ObligationItem) => i.remaining > EPS;

/**
 * Sections + headline numbers from the selected cycle's obligations, the NEXT cycle's, and what was paid.
 * `nextCycleObligations` may repeat items carried forward from before — they are dropped here (they already belong to
 * `cycleObligations`), so nothing is ever counted in two sections.
 */
export function buildBillsOverview(params: {
  cycleObligations: readonly ObligationItem[];
  nextCycleObligations: readonly ObligationItem[];
  completed: { groups: readonly CompletedGroup[]; total: number };
}): BillsOverview {
  const toPay = summarizeToPay(params.cycleObligations);
  // Most urgent first (overdue → due soon → upcoming, oldest first) — the order every section lists in.
  const open = params.cycleObligations.filter(isOpen).sort(compareObligations);
  const counted = open.filter((i) => i.countsTowardTotal);

  const overdue = counted.filter((i) => i.status === "overdue");
  const dueThisCycle = counted.filter((i) => i.status !== "overdue");

  const nextOwn = params.nextCycleObligations.filter((i) => isOpen(i) && !i.carriedForward).sort(compareObligations);
  const upcoming = nextOwn.filter((i) => i.countsTowardTotal);
  const coveredElsewhere = [...open, ...nextOwn].filter((i) => !i.countsTowardTotal);

  const byKind: Record<ObligationKind, number> = { bill: 0, loan: 0, emi: 0, card: 0 };
  for (const i of counted) byKind[i.kind] = round2(byKind[i.kind] + i.remaining);

  const upcomingTotal = round2(upcoming.reduce((s, i) => s + i.remaining, 0));
  const coveredAmount = round2(coveredElsewhere.reduce((s, i) => s + i.remaining, 0));

  return {
    summary: {
      dueThisCycle: toPay.total,
      dueThisCycleCount: toPay.count,
      overdue: toPay.overdue,
      overdueCount: toPay.overdueCount,
      dueSoon: toPay.dueSoon,
      stillToCome: round2(toPay.total - toPay.overdue),
      upcoming: upcomingTotal,
      upcomingCount: upcoming.length,
      paid: round2(params.completed.total),
      paidCount: params.completed.groups.length,
      byKind,
      coveredElsewhere: { count: coveredElsewhere.length, amount: coveredAmount },
      next: toPay.next,
    },
    overdue,
    dueThisCycle,
    upcoming,
    coveredElsewhere,
    paid: [...params.completed.groups],
    toPay,
  };
}

// ───────────────────────────── filters ─────────────────────────────

/** Whether an UNPAID obligation passes the status filter ("paid" never matches an unpaid row). */
export function matchesStatus(item: ObligationItem, status: StatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "overdue":
      return item.status === "overdue";
    case "dueSoon":
      return item.status === "dueToday" || item.status === "dueSoon";
    case "upcoming":
      return item.status === "upcoming";
    case "partial":
      return item.amountPaid > EPS && item.remaining > EPS;
    case "paid":
      return false;
  }
}

export function filterObligations(items: readonly ObligationItem[], filters: BillsFilters): ObligationItem[] {
  return items.filter((i) => (filters.kind === "all" || i.kind === filters.kind) && matchesStatus(i, filters.status));
}

/** Paid groups follow the type filter; a status filter other than "all"/"paid" hides them (they are not that status). */
export function filterPaid(groups: readonly CompletedGroup[], filters: BillsFilters): CompletedGroup[] {
  if (filters.status !== "all" && filters.status !== "paid") return [];
  return groups.filter((g) => filters.kind === "all" || g.kind === filters.kind);
}

/** Open rows per type (counted + covered, this cycle + next) — the numbers on the type chips. */
export function kindCounts(overview: BillsOverview): Record<KindFilter, number> {
  const all = [...overview.overdue, ...overview.dueThisCycle, ...overview.upcoming, ...overview.coveredElsewhere];
  const counts: Record<KindFilter, number> = { all: all.length + overview.paid.length, bill: 0, loan: 0, emi: 0, card: 0 };
  for (const i of all) counts[i.kind] += 1;
  for (const g of overview.paid) counts[g.kind] += 1;
  return counts;
}
