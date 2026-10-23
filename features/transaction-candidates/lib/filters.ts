import { deriveCandidateStatus, type CandidateLane } from "./candidate-status";
import type { CandidateDuplicateResult } from "./candidate-duplicate";
import { smsCandidateEventTypeLabel, type SmsCandidateConfidenceLevel, type SmsCandidateDirection, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

/**
 * Duplicate results, keyed by candidate id — computed once per render pass
 * (via `evaluateCandidateDuplicate`, which needs the user's full
 * transaction list) and threaded into the lane derivation rather than recomputed per filter predicate.
 */
export type DuplicatesByCandidateId = Map<string, CandidateDuplicateResult>;

/** Each candidate's single review lane (`deriveCandidateStatus(...).lane`), keyed by candidate id. */
export type LaneByCandidateId = Map<string, CandidateLane>;

/**
 * "all" plus the four mutually exclusive lanes. Every candidate is in exactly one lane, so the four lane counts
 * always add up to the "all" count. No "ignored"/"imported" lane: this collection has no persisted status, so a
 * candidate that's been committed or dismissed is deleted, not flagged — see `candidate-status.ts`.
 */
export type CandidateLaneFilter = "all" | CandidateLane;

export const CANDIDATE_LANE_ORDER: CandidateLaneFilter[] = ["all", "duplicate", "needsAccount", "needsReview", "noIssues"];

/**
 * What the Inbox can be narrowed to: one lane, or "attention" — the union of every lane that still needs the reviewer
 * (duplicate + needsAccount + needsReview). It's a VIEW over the lanes, not a fifth lane: no candidate belongs to it
 * directly, so `countCandidatesByLane` stays a partition that adds up to "all".
 */
export type CandidateViewFilter = CandidateLaneFilter | "attention";

/** Lanes that need the reviewer's attention before an import — i.e. everything except `noIssues`. */
export const ATTENTION_LANES: readonly CandidateLane[] = ["duplicate", "needsAccount", "needsReview"];

export function isAttentionLane(lane: CandidateLane): boolean {
  return ATTENTION_LANES.includes(lane);
}

/** The "Attention needed" count for a `countCandidatesByLane` result. */
export function attentionCount(counts: Record<CandidateLaneFilter, number>): number {
  return counts.duplicate + counts.needsAccount + counts.needsReview;
}

function matchesView(lane: CandidateLane | undefined, view: CandidateViewFilter): boolean {
  if (view === "all") return true;
  if (!lane) return false;
  return view === "attention" ? isAttentionLane(lane) : lane === view;
}

export const CANDIDATE_LANE_LABELS: Record<CandidateLaneFilter, string> = {
  all: "All",
  duplicate: "Possible duplicate",
  needsAccount: "Needs account",
  needsReview: "Needs review",
  noIssues: "No issues flagged",
};

/** The account-filter key for candidates whose account/card Android couldn't resolve (or that no longer resolves). */
export const UNMATCHED_ACCOUNT_KEY = "unmatched";

export interface CandidateFilters {
  lane: CandidateViewFilter;
  /**
   * Selected destinations, ORed together: `"account:<id>"` / `"card:<id>"` (same key convention
   * `candidate-details-view.ts`'s destination picker uses; matches the candidate's own resolved `accountId`/`cardId` —
   * Android's resolution, never re-derived here) and/or `UNMATCHED_ACCOUNT_KEY`. Empty means "every account".
   */
  accountKeys: string[];
  /** Inclusive local-calendar date range, `"YYYY-MM-DD"` (the value of an `<input type="date">`); `null` = open-ended. */
  dateFrom: string | null;
  dateTo: string | null;
  /** Inclusive bounds on the candidate's amount (always positive — direction is its own filter); `null` = open-ended. */
  minAmount: number | null;
  maxAmount: number | null;
  /** Selected confidence levels, ORed together. Empty means "any confidence". */
  confidence: SmsCandidateConfidenceLevel[];
  /** `"YYYY-MM"` (matches an HTML `month` input's value) against `transactionDate`'s local calendar
   *  month — "every month" when `null`. */
  month: string | null;
  /** `null` means both directions. */
  direction: SmsCandidateDirection | null;
}

export const DEFAULT_CANDIDATE_FILTERS: CandidateFilters = {
  lane: "all",
  accountKeys: [],
  dateFrom: null,
  dateTo: null,
  minAmount: null,
  maxAmount: null,
  confidence: [],
  month: null,
  direction: null,
};

/** `"YYYY-MM"` for a candidate's `transactionDate` — the key both the month filter and its option list are built from. */
export function candidateMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Candidate ids whose account/card does NOT resolve to a real, current one (`candidateDestinationState !== "matched"`) — computed by the caller, which owns the accounts. */
export type UnmatchedIds = ReadonlySet<string>;

function matchesAccountKeys(candidate: SmsTransactionCandidate, accountKeys: readonly string[], unmatchedIds?: UnmatchedIds): boolean {
  if (accountKeys.length === 0) return true;
  return accountKeys.some((key) => {
    if (key === UNMATCHED_ACCOUNT_KEY) return unmatchedIds?.has(candidate.id) ?? (candidate.accountId == null && candidate.cardId == null);
    const [kind, id] = key.split(":") as ["account" | "card", string];
    return kind === "card" ? candidate.cardId === id : candidate.accountId === id;
  });
}

/** `"YYYY-MM-DD"` in the candidate's LOCAL calendar — the same calendar the month grouping and the date input use. */
export function candidateDayKey(date: Date): string {
  return `${candidateMonthKey(date)}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Every category is ANDed with every other; inside a multi-value category (accounts, confidence) the values are ORed.
 * The review lane is the one category handled separately (it needs `laneById`).
 */
function matchesNonLaneFilters(candidate: SmsTransactionCandidate, filters: CandidateFilters, unmatchedIds?: UnmatchedIds): boolean {
  if (!matchesAccountKeys(candidate, filters.accountKeys, unmatchedIds)) return false;
  if (filters.month != null && candidateMonthKey(candidate.transactionDate) !== filters.month) return false;
  if (filters.direction != null && candidate.direction !== filters.direction) return false;
  if (filters.dateFrom != null || filters.dateTo != null) {
    const day = candidateDayKey(candidate.transactionDate);
    if (filters.dateFrom != null && day < filters.dateFrom) return false;
    if (filters.dateTo != null && day > filters.dateTo) return false;
  }
  if (filters.minAmount != null && candidate.amount < filters.minAmount) return false;
  if (filters.maxAmount != null && candidate.amount > filters.maxAmount) return false;
  if (filters.confidence.length > 0 && !filters.confidence.includes(candidate.confidenceLevel)) return false;
  return true;
}

/** Extra searchable text per candidate id (e.g. the resolved account label), built by the caller from data this module doesn't see. */
export type SearchTextById = ReadonlyMap<string, string>;

function matchesSearch(candidate: SmsTransactionCandidate, search: string, extraText?: SearchTextById): boolean {
  if (!search.trim()) return true;
  const needle = search.trim().toLowerCase();
  const text = [
    candidate.merchant,
    candidate.referenceNumber,
    candidate.bankName,
    candidate.rawLastFour,
    smsCandidateEventTypeLabel(candidate.eventType),
    extraText?.get(candidate.id),
  ]
    .filter((v): v is string => !!v)
    .join(" ")
    .toLowerCase();
  if (text.includes(needle)) return true;
  // Amounts: "1250", "1,250.50", "₹1250.5" all find a ₹1,250.50 candidate.
  const numeric = needle.replace(/[₹,\s]/g, "");
  if (/^\d+(\.\d*)?$/.test(numeric)) return [String(candidate.amount), candidate.amount.toFixed(2)].some((a) => a.includes(numeric));
  return false;
}

/** Distinct `"YYYY-MM"` months present across `candidates`, most recent first — populates the month filter's option list. */
export function deriveCandidateMonthOptions(candidates: SmsTransactionCandidate[]): string[] {
  return Array.from(new Set(candidates.map((c) => candidateMonthKey(c.transactionDate)))).sort((a, b) => b.localeCompare(a));
}

/** Search + filters are display-only — never mutate anything. */
export function applyCandidateSearchAndFilters(
  candidates: SmsTransactionCandidate[],
  search: string,
  filters: CandidateFilters,
  laneById: LaneByCandidateId,
  extraText?: SearchTextById,
  unmatchedIds?: UnmatchedIds,
): SmsTransactionCandidate[] {
  return candidates.filter(
    (candidate) =>
      matchesSearch(candidate, search, extraText) &&
      matchesNonLaneFilters(candidate, filters, unmatchedIds) &&
      matchesView(laneById.get(candidate.id), filters.lane),
  );
}

/**
 * Lane counts for the candidates that pass the search box and the account / month / direction filters — i.e.
 * exactly the rows each lane would show. `duplicate + needsAccount + needsReview + noIssues === all`, always.
 */
export function countCandidatesByLane(
  candidates: SmsTransactionCandidate[],
  search: string,
  filters: CandidateFilters,
  laneById: LaneByCandidateId,
  extraText?: SearchTextById,
  unmatchedIds?: UnmatchedIds,
): Record<CandidateLaneFilter, number> {
  const counts: Record<CandidateLaneFilter, number> = { all: 0, duplicate: 0, needsAccount: 0, needsReview: 0, noIssues: 0 };
  for (const candidate of candidates) {
    if (!matchesSearch(candidate, search, extraText) || !matchesNonLaneFilters(candidate, filters, unmatchedIds)) continue;
    counts.all += 1;
    const lane = laneById.get(candidate.id);
    if (lane) counts[lane] += 1;
  }
  return counts;
}

/**
 * Drops an account or month filter whose option no longer exists (e.g. every candidate for that account was
 * just imported) — otherwise the list would silently stay empty behind a Select that shows nothing selected.
 */
export function normalizeCandidateFilters(
  filters: CandidateFilters,
  available: { accountKeys: ReadonlySet<string>; months: readonly string[] },
): CandidateFilters {
  const accountKeys = filters.accountKeys.filter((key) => key === UNMATCHED_ACCOUNT_KEY || available.accountKeys.has(key));
  const month = filters.month != null && !available.months.includes(filters.month) ? null : filters.month;
  return accountKeys.length === filters.accountKeys.length && month === filters.month ? filters : { ...filters, accountKeys, month };
}

/**
 * How many filter CATEGORIES are narrowing the list (search and sort excluded) — the number on the Filters button.
 * A multi-select or a range counts once however many values it holds.
 */
export function countActiveCandidateFilters(filters: CandidateFilters): number {
  return [
    filters.lane !== "all",
    filters.month != null,
    filters.direction != null,
    filters.accountKeys.length > 0,
    filters.dateFrom != null || filters.dateTo != null,
    filters.minAmount != null || filters.maxAmount != null,
    filters.confidence.length > 0,
  ].filter(Boolean).length;
}

/** True when the search box or any filter narrows the list — drives the "no matches" empty state and Clear filters. */
export function hasActiveCandidateFilters(search: string, filters: CandidateFilters): boolean {
  return search.trim() !== "" || countActiveCandidateFilters(filters) > 0;
}

/** Re-exported so callers don't need to import from `candidate-status.ts` separately when they just need the tone/label. */
export { deriveCandidateStatus };

export type CandidateSortKey = "newest" | "oldest" | "amountHigh" | "amountLow" | "confidenceLow";

export const CANDIDATE_SORT_LABELS: Record<CandidateSortKey, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  amountHigh: "Amount, high to low",
  amountLow: "Amount, low to high",
  confidenceLow: "Lowest confidence first",
};

export const CANDIDATE_SORT_ORDER: CandidateSortKey[] = ["newest", "oldest", "amountHigh", "amountLow", "confidenceLow"];

/** Display order only — returns a new array, never mutates or writes anything. Ties fall back to newest-first, then id, so the order is stable. */
export function sortCandidates(candidates: readonly SmsTransactionCandidate[], key: CandidateSortKey): SmsTransactionCandidate[] {
  const byNewest = (a: SmsTransactionCandidate, b: SmsTransactionCandidate) =>
    b.transactionDate.getTime() - a.transactionDate.getTime() || a.id.localeCompare(b.id);
  const compare: Record<CandidateSortKey, (a: SmsTransactionCandidate, b: SmsTransactionCandidate) => number> = {
    newest: byNewest,
    oldest: (a, b) => a.transactionDate.getTime() - b.transactionDate.getTime() || a.id.localeCompare(b.id),
    amountHigh: (a, b) => b.amount - a.amount || byNewest(a, b),
    amountLow: (a, b) => a.amount - b.amount || byNewest(a, b),
    confidenceLow: (a, b) => a.confidenceScore - b.confidenceScore || byNewest(a, b),
  };
  return [...candidates].sort(compare[key]);
}
