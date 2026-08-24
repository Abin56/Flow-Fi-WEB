import { deriveCandidateStatus } from "./candidate-status";
import type { CandidateDuplicateResult } from "./candidate-duplicate";
import type { SmsCandidateDirection, SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

/**
 * Duplicate results, keyed by candidate id — computed once per render pass
 * (via `evaluateCandidateDuplicate`, which needs the user's full
 * transaction list) and threaded through here rather than recomputed per
 * filter predicate.
 */
export type DuplicatesByCandidateId = Map<string, CandidateDuplicateResult>;

export interface CandidateFilters {
  onlyNeedsReview: boolean;
  onlyDuplicates: boolean;
  onlyReadyToImport: boolean;
  onlyUnmatched: boolean;
  /** `"account:<id>"` / `"card:<id>"` — same key convention `candidate-details-view.ts`'s destination
   *  picker uses. `null` means "every account". Matches the candidate's own resolved `accountId`/`cardId`
   *  (Android's own resolution — never re-derived here), so an unmatched candidate never matches any
   *  specific account filter, only "every account". */
  accountFilter: string | null;
  /** `"YYYY-MM"` (matches an HTML `month` input's value) against `transactionDate`'s local calendar
   *  month — "every month" when `null`. */
  month: string | null;
  /** `null` means both directions. */
  direction: SmsCandidateDirection | null;
}

export const DEFAULT_CANDIDATE_FILTERS: CandidateFilters = {
  onlyNeedsReview: false,
  onlyDuplicates: false,
  onlyReadyToImport: false,
  onlyUnmatched: false,
  accountFilter: null,
  month: null,
  direction: null,
};

/** `"YYYY-MM"` for a candidate's `transactionDate` — the key both the month filter and its option list are built from. */
export function candidateMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function isDuplicateCandidate(candidate: SmsTransactionCandidate, duplicates: DuplicatesByCandidateId): boolean {
  return duplicates.get(candidate.id)?.duplicateOfTransactionId != null;
}

function isUnmatchedCandidate(candidate: SmsTransactionCandidate): boolean {
  return (candidate.bankName != null || candidate.rawLastFour != null) && candidate.accountId == null && candidate.cardId == null;
}

function isNeedsReviewCandidate(candidate: SmsTransactionCandidate): boolean {
  return candidate.needsReview;
}

function isReadyToImportCandidate(candidate: SmsTransactionCandidate, duplicates: DuplicatesByCandidateId): boolean {
  return !candidate.needsReview && !isUnmatchedCandidate(candidate) && !isDuplicateCandidate(candidate, duplicates);
}

function matchesAccountFilter(candidate: SmsTransactionCandidate, accountFilter: string | null): boolean {
  if (accountFilter == null) return true;
  const [kind, id] = accountFilter.split(":") as ["account" | "card", string];
  return kind === "card" ? candidate.cardId === id : candidate.accountId === id;
}

function matchesFilters(candidate: SmsTransactionCandidate, filters: CandidateFilters, duplicates: DuplicatesByCandidateId): boolean {
  if (filters.onlyNeedsReview && !isNeedsReviewCandidate(candidate)) return false;
  if (filters.onlyDuplicates && !isDuplicateCandidate(candidate, duplicates)) return false;
  if (filters.onlyReadyToImport && !isReadyToImportCandidate(candidate, duplicates)) return false;
  if (filters.onlyUnmatched && !isUnmatchedCandidate(candidate)) return false;
  if (!matchesAccountFilter(candidate, filters.accountFilter)) return false;
  if (filters.month != null && candidateMonthKey(candidate.transactionDate) !== filters.month) return false;
  if (filters.direction != null && candidate.direction !== filters.direction) return false;
  return true;
}

/**
 * Every single-select "tab" the header can offer — kept as one union so the
 * two surfaces never drift, same pattern as `StudioTabKey`. No "ignored"/
 * "imported" tab: this collection has no persisted status, so a candidate
 * that's been committed or dismissed is deleted, not flagged — there's
 * nothing left here to filter for. See `candidate-status.ts`'s module doc.
 */
export type CandidateTabKey = "all" | "needsReview" | "duplicates" | "readyToImport" | "unmatched";

/** Single-select tab -> filter patch, same exclusive-tab convention as `applyTabFilter`. */
export function applyCandidateTabFilter(filters: CandidateFilters, tab: CandidateTabKey): CandidateFilters {
  return {
    ...filters,
    onlyNeedsReview: tab === "needsReview",
    onlyDuplicates: tab === "duplicates",
    onlyReadyToImport: tab === "readyToImport",
    onlyUnmatched: tab === "unmatched",
  };
}

/** Inverse of `applyCandidateTabFilter`. */
export function deriveActiveCandidateTab(filters: CandidateFilters): CandidateTabKey {
  if (filters.onlyNeedsReview) return "needsReview";
  if (filters.onlyDuplicates) return "duplicates";
  if (filters.onlyReadyToImport) return "readyToImport";
  if (filters.onlyUnmatched) return "unmatched";
  return "all";
}

function matchesSearch(candidate: SmsTransactionCandidate, search: string): boolean {
  if (!search.trim()) return true;
  const needle = search.trim().toLowerCase();
  return (
    (candidate.merchant ?? "").toLowerCase().includes(needle) ||
    (candidate.referenceNumber ?? "").toLowerCase().includes(needle) ||
    (candidate.bankName ?? "").toLowerCase().includes(needle)
  );
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
  duplicates: DuplicatesByCandidateId,
): SmsTransactionCandidate[] {
  return candidates.filter((candidate) => matchesSearch(candidate, search) && matchesFilters(candidate, filters, duplicates));
}

/** Re-exported so callers don't need to import from `candidate-status.ts` separately when they just need the tone/label. */
export { deriveCandidateStatus };
