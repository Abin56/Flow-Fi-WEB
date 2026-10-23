import type { SmsCandidateConfidenceLevel } from "@/lib/models/sms-transaction-candidate";
import {
  CANDIDATE_SORT_ORDER,
  DEFAULT_CANDIDATE_FILTERS,
  UNMATCHED_ACCOUNT_KEY,
  type CandidateFilters,
  type CandidateSortKey,
  type CandidateViewFilter,
} from "./filters";

/**
 * The Inbox's filter state as URL query parameters, so a filtered view survives a refresh and can be shared. Display-only:
 * nothing here reaches Firestore, and every value is validated on the way in — a hand-edited or stale URL can only ever
 * produce a valid (possibly empty) filter, never an exception.
 *
 *   q=swiggy  view=attention  month=2026-10  dir=debit  acct=account:abc&acct=unmatched  from=2026-10-01  to=2026-10-31
 *   min=100  max=5000  conf=low&conf=medium  sort=amountHigh
 *
 * Only non-default values are written, in a fixed order, so the same state always serializes to the same string.
 */

export interface CandidateViewState {
  search: string;
  sortKey: CandidateSortKey;
  filters: CandidateFilters;
}

export const DEFAULT_CANDIDATE_VIEW_STATE: CandidateViewState = { search: "", sortKey: "newest", filters: DEFAULT_CANDIDATE_FILTERS };

/** The slice of `URLSearchParams` / `ReadonlyURLSearchParams` this module reads. */
export interface ParamReader {
  get(name: string): string | null;
  getAll(name: string): string[];
}

const VIEWS: readonly CandidateViewFilter[] = ["all", "attention", "duplicate", "needsAccount", "needsReview", "noIssues"];
const CONFIDENCE: readonly SmsCandidateConfidenceLevel[] = ["high", "medium", "low"];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_KEY = /^(account|card):[A-Za-z0-9_-]{1,128}$/;

function validDay(value: string | null): string | null {
  if (!value || !DAY.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? value : null;
}

function nonNegativeNumber(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseCandidateViewState(params: ParamReader): CandidateViewState {
  const view = params.get("view") as CandidateViewFilter | null;
  const month = params.get("month");
  const dir = params.get("dir");
  const sort = params.get("sort") as CandidateSortKey | null;

  let dateFrom = validDay(params.get("from"));
  let dateTo = validDay(params.get("to"));
  if (dateFrom && dateTo && dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  let minAmount = nonNegativeNumber(params.get("min"));
  let maxAmount = nonNegativeNumber(params.get("max"));
  if (minAmount != null && maxAmount != null && minAmount > maxAmount) [minAmount, maxAmount] = [maxAmount, minAmount];

  const accountKeys = [...new Set(params.getAll("acct").filter((k) => k === UNMATCHED_ACCOUNT_KEY || ACCOUNT_KEY.test(k)))];
  const confidence = CONFIDENCE.filter((level) => params.getAll("conf").includes(level));

  return {
    search: (params.get("q") ?? "").slice(0, 200),
    sortKey: sort && CANDIDATE_SORT_ORDER.includes(sort) ? sort : "newest",
    filters: {
      lane: view && VIEWS.includes(view) ? view : "all",
      accountKeys,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
      confidence,
      month: month && MONTH.test(month) ? month : null,
      direction: dir === "debit" || dir === "credit" ? dir : null,
    },
  };
}

/** The query string (no leading "?"), empty when everything is at its default. */
export function serializeCandidateViewState({ search, sortKey, filters }: CandidateViewState): string {
  const p = new URLSearchParams();
  if (search.trim()) p.set("q", search.trim());
  if (filters.lane !== "all") p.set("view", filters.lane);
  if (filters.month) p.set("month", filters.month);
  if (filters.direction) p.set("dir", filters.direction);
  for (const key of filters.accountKeys) p.append("acct", key);
  if (filters.dateFrom) p.set("from", filters.dateFrom);
  if (filters.dateTo) p.set("to", filters.dateTo);
  if (filters.minAmount != null) p.set("min", String(filters.minAmount));
  if (filters.maxAmount != null) p.set("max", String(filters.maxAmount));
  for (const level of filters.confidence) p.append("conf", level);
  if (sortKey !== "newest") p.set("sort", sortKey);
  return p.toString();
}
