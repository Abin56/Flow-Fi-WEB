import type { GridRow } from "./grid-types";

export interface StudioFilters {
  onlyUnreviewed: boolean;
  onlyNeedsReview: boolean;
  onlyDuplicates: boolean;
  onlyIgnored: boolean;
  /** Mirrors `ConfidenceCell`'s warning/danger boundary — same `confidenceScores.overall ?? 1` threshold. */
  onlyLowConfidence: boolean;
  onlyTransfers: boolean;
  onlyReadyToImport: boolean;
}

export const DEFAULT_STUDIO_FILTERS: StudioFilters = {
  onlyUnreviewed: false,
  onlyNeedsReview: false,
  onlyDuplicates: false,
  onlyIgnored: false,
  onlyLowConfidence: false,
  onlyTransfers: false,
  onlyReadyToImport: false,
};

const LOW_CONFIDENCE_THRESHOLD = 0.7;

export function isLowConfidenceRow(row: GridRow): boolean {
  return (row.confidenceScores.overall ?? 1) < LOW_CONFIDENCE_THRESHOLD;
}

/** A row that would actually commit cleanly if Approve & Import ran right now. */
export function isReadyToImportRow(row: GridRow): boolean {
  return row.include && row.flowType != null && !row.needsReview && !row.duplicateOfTransactionId;
}

function matchesFilters(row: GridRow, filters: StudioFilters): boolean {
  if (filters.onlyUnreviewed && row.flowType != null) return false;
  if (filters.onlyNeedsReview && !row.needsReview) return false;
  if (filters.onlyDuplicates && !row.duplicateOfTransactionId && !row.duplicateCandidateOf) return false;
  if (filters.onlyIgnored && row.include) return false;
  if (filters.onlyLowConfidence && !isLowConfidenceRow(row)) return false;
  if (filters.onlyTransfers && row.flowType !== "transfer" && !row.transferDetected) return false;
  if (filters.onlyReadyToImport && !isReadyToImportRow(row)) return false;
  return true;
}

/** Every single-select "tab" the toolbar's filter pills and the header's metric cards both offer — kept as one union so the two surfaces can never drift on what a tab means. "selected"/"all" aren't `StudioFilters` flags (selection is tracked separately, "all" just clears every flag). */
export type StudioTabKey = "all" | "toReview" | "needsReview" | "duplicates" | "lowConfidence" | "transfers" | "readyToImport" | "selected";

/**
 * Single-select tab → filter patch. Picking a tab sets exactly the one flag
 * it names and clears the others — `StudioFilters`' flags AND-combine, so
 * this is what turns them into an exclusive tab UI rather than a change to
 * the underlying filter semantics. Shared by the toolbar's filter pills and
 * the header's metric cards so clicking either surface behaves identically.
 */
export function applyTabFilter(filters: StudioFilters, tab: StudioTabKey): StudioFilters {
  return {
    ...filters,
    onlyUnreviewed: tab === "toReview",
    onlyNeedsReview: tab === "needsReview",
    onlyDuplicates: tab === "duplicates",
    onlyLowConfidence: tab === "lowConfidence",
    onlyTransfers: tab === "transfers",
    onlyReadyToImport: tab === "readyToImport",
  };
}

/** Inverse of `applyTabFilter` — which tab reads as "active" for a given filter state, so the toolbar and header stay visually in sync without either one owning the other's state. */
export function deriveActiveTab(filters: StudioFilters, showSelectedOnly: boolean): StudioTabKey {
  if (showSelectedOnly) return "selected";
  if (filters.onlyUnreviewed) return "toReview";
  if (filters.onlyNeedsReview) return "needsReview";
  if (filters.onlyDuplicates) return "duplicates";
  if (filters.onlyLowConfidence) return "lowConfidence";
  if (filters.onlyTransfers) return "transfers";
  if (filters.onlyReadyToImport) return "readyToImport";
  return "all";
}

function matchesSearch(row: GridRow, search: string): boolean {
  if (!search.trim()) return true;
  const needle = search.trim().toLowerCase();
  return (
    (row.counterpartyNormalized ?? row.counterpartyRaw).toLowerCase().includes(needle) ||
    row.notes.toLowerCase().includes(needle) ||
    (row.referenceNumber ?? "").toLowerCase().includes(needle) ||
    (row.category ?? "").toLowerCase().includes(needle) ||
    row.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

/** Search + filters are display-only — never mutate anything, and never change which rows count toward the footer summary (that's every row in the document, per architecture §2's footer). */
export function applyStudioSearchAndFilters(rows: GridRow[], search: string, filters: StudioFilters): GridRow[] {
  return rows.filter((row) => matchesSearch(row, search) && matchesFilters(row, filters));
}
