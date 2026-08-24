import type { StagedRecord } from "@/lib/models/document-import";

export interface DocumentAnalysisStats {
  transactions: number;
  duplicates: number;
  possibleTransfers: number;
  lowConfidence: number;
}

/** Mirrors `ConfidenceCell`'s warning/danger boundary (features/transaction-studio) so "Low
 *  Confidence" here means the same thing it means in Transaction Studio's grid. */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** Aggregates a statement's staged records into the counts the Analysis Complete stat grid
 *  shows. `FinancialDocument` has no precomputed counts — these are always derived client-side
 *  from the real staged records, never invented. */
export function computeDocumentAnalysisStats(records: StagedRecord[]): DocumentAnalysisStats {
  let duplicates = 0;
  let possibleTransfers = 0;
  let lowConfidence = 0;

  for (const record of records) {
    if (record.duplicateOfTransactionId || record.duplicateCandidateOf) duplicates += 1;
    if (record.transferDetected) possibleTransfers += 1;
    if ((record.confidenceScores.overall ?? 1) < LOW_CONFIDENCE_THRESHOLD) lowConfidence += 1;
  }

  return { transactions: records.length, duplicates, possibleTransfers, lowConfidence };
}
