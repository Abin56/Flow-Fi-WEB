import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { candidateDayKey, type CandidateSortKey } from "./filters";

export interface CandidateGroup {
  /** `"YYYY-MM-DD"` for a day group, `"sorted"` for the single flat group of a non-date sort. */
  key: string;
  /** "Today", "Yesterday" or "20 October 2026"; for the flat group, the sort's own label. */
  label: string;
  /** The actual date ("22 October 2026") shown beside "Today" / "Yesterday"; null otherwise. */
  dateText: string | null;
  /** True only for the flat group — its rows then carry their own date. */
  flat: boolean;
  candidates: SmsTransactionCandidate[];
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });
const DAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" });

/** `"2026-10"` -> `"October 2026"` (the month filter's option label). */
export function formatMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return MONTH_FORMAT.format(new Date(year, month - 1, 1));
}

function parseDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "Today" / "Yesterday" / "20 October 2026" for a local `YYYY-MM-DD`, relative to `now`. Calendar days, never 24h blocks. */
export function formatDayHeading(dayKey: string, now: Date): { label: string; dateText: string | null } {
  const date = parseDayKey(dayKey);
  const full = DAY_FORMAT.format(date);
  if (dayKey === candidateDayKey(now)) return { label: "Today", dateText: full };
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey === candidateDayKey(yesterday)) return { label: "Yesterday", dateText: full };
  return { label: full, dateText: null };
}

/** Only the date sorts keep a day grouping honest — an amount or confidence sort interleaves days. */
export function sortKeepsDayGroups(sortKey: CandidateSortKey): boolean {
  return sortKey === "newest" || sortKey === "oldest";
}

/**
 * Display grouping for the Inbox. `sorted` must already be in display order (`sortCandidates`); this never reorders rows.
 *
 *  - Date sorts ("newest" / "oldest"): one group per LOCAL calendar day of `transactionDate`, in the order the days first
 *    appear (so across month and year boundaries they simply continue: 1 Nov → 31 Oct → 30 Oct, 1 Jan 2027 → 31 Dec 2026).
 *  - Any other sort: ONE flat group labelled with the sort, so the requested order is never broken up by day.
 *
 * Every candidate lands in exactly one group. No amounts are summed: these are unconfirmed candidates, not transactions.
 */
export function groupCandidatesForDisplay(sorted: readonly SmsTransactionCandidate[], sortKey: CandidateSortKey, flatLabel: string, now: Date = new Date()): CandidateGroup[] {
  if (sorted.length === 0) return [];
  if (!sortKeepsDayGroups(sortKey)) return [{ key: "sorted", label: flatLabel, dateText: null, flat: true, candidates: [...sorted] }];

  const groups = new Map<string, CandidateGroup>();
  for (const candidate of sorted) {
    const key = candidateDayKey(candidate.transactionDate);
    const group = groups.get(key);
    if (group) group.candidates.push(candidate);
    else groups.set(key, { key, ...formatDayHeading(key, now), flat: false, candidates: [candidate] });
  }
  return [...groups.values()];
}
