import { isLowConfidenceRow, isReadyToImportRow } from "./filters";
import type { GridRow } from "./grid-types";

export interface StudioHeaderMetrics {
  totalRows: number;
  selectedCount: number;
  needsReview: number;
  duplicates: number;
  transferCandidates: number;
  lowConfidence: number;
  readyToImport: number;
}

/**
 * Row-count metrics for the header's stat cards — deliberately computed off
 * the full, unfiltered document (matching `StudioToolbar`'s existing
 * documented convention: "the whole document, not the current filter"),
 * since these represent overall review progress, not the current view.
 * Distinct from `lib/summary.ts`'s `computeStudioSummary`, which computes ₹
 * money totals for the footer — different data, not a duplicate computation.
 */
export function computeStudioHeaderMetrics(rows: GridRow[], selectedCount: number): StudioHeaderMetrics {
  return {
    totalRows: rows.length,
    selectedCount,
    needsReview: rows.filter((r) => r.needsReview).length,
    duplicates: rows.filter((r) => r.duplicateOfTransactionId || r.duplicateCandidateOf).length,
    transferCandidates: rows.filter((r) => r.flowType === "transfer" || r.transferDetected).length,
    lowConfidence: rows.filter(isLowConfidenceRow).length,
    readyToImport: rows.filter(isReadyToImportRow).length,
  };
}
