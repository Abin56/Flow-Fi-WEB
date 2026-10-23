import { formatCurrencyExact } from "@/lib/format";
import { formatMonthKey } from "./candidate-month-groups";
import { CANDIDATE_LANE_LABELS, UNMATCHED_ACCOUNT_KEY, type CandidateFilters } from "./filters";

/** One removable "active filter" chip. `clear` returns the filters with just that criterion removed. */
export interface FilterChip {
  id: string;
  label: string;
  /** Screen-reader text for the remove button. */
  removeLabel: string;
  clear: (filters: CandidateFilters) => CandidateFilters;
}

const CONFIDENCE_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;

const shortDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

/**
 * Chips for every active filter category — search and sort aren't chips (the search box shows its own text and the sort
 * has its own control). Multi-select categories get one chip per value so each can be removed on its own.
 */
export function buildFilterChips(filters: CandidateFilters, accountLabelOf: (key: string) => string): FilterChip[] {
  const chips: FilterChip[] = [];

  if (filters.lane !== "all") {
    const label = filters.lane === "attention" ? "Attention needed" : CANDIDATE_LANE_LABELS[filters.lane];
    chips.push({ id: "lane", label, removeLabel: `Remove filter: ${label}`, clear: (f) => ({ ...f, lane: "all" }) });
  }
  if (filters.month) {
    const label = formatMonthKey(filters.month);
    chips.push({ id: "month", label, removeLabel: `Remove filter: ${label}`, clear: (f) => ({ ...f, month: null }) });
  }
  if (filters.direction) {
    const label = filters.direction === "debit" ? "Debit" : "Credit";
    chips.push({ id: "direction", label, removeLabel: `Remove filter: ${label}`, clear: (f) => ({ ...f, direction: null }) });
  }
  for (const key of filters.accountKeys) {
    const label = key === UNMATCHED_ACCOUNT_KEY ? "Unmatched" : accountLabelOf(key);
    chips.push({ id: `acct:${key}`, label, removeLabel: `Remove filter: ${label}`, clear: (f) => ({ ...f, accountKeys: f.accountKeys.filter((k) => k !== key) }) });
  }
  if (filters.dateFrom || filters.dateTo) {
    const label = filters.dateFrom && filters.dateTo ? `${shortDay(filters.dateFrom)} – ${shortDay(filters.dateTo)}` : filters.dateFrom ? `From ${shortDay(filters.dateFrom)}` : `Until ${shortDay(filters.dateTo!)}`;
    chips.push({ id: "dates", label, removeLabel: `Remove filter: dates ${label}`, clear: (f) => ({ ...f, dateFrom: null, dateTo: null }) });
  }
  if (filters.minAmount != null || filters.maxAmount != null) {
    const { minAmount: lo, maxAmount: hi } = filters;
    const label = lo != null && hi != null ? `${formatCurrencyExact(lo)} – ${formatCurrencyExact(hi)}` : lo != null ? `Min ${formatCurrencyExact(lo)}` : `Max ${formatCurrencyExact(hi!)}`;
    chips.push({ id: "amount", label, removeLabel: `Remove filter: amount ${label}`, clear: (f) => ({ ...f, minAmount: null, maxAmount: null }) });
  }
  for (const level of filters.confidence) {
    const label = CONFIDENCE_LABEL[level];
    chips.push({ id: `conf:${level}`, label, removeLabel: `Remove filter: ${label}`, clear: (f) => ({ ...f, confidence: f.confidence.filter((c) => c !== level) }) });
  }
  return chips;
}
