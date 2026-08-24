/**
 * Applies the Duplicate Detection engine to a full statement's
 * transactions — Statement Intelligence Layer, module 2's pipeline entry
 * point (Merchant Normalizer → Duplicate Detector → ...). Pure: takes
 * already-fetched existing records (Firestore access is a separate, thin
 * read-only lookup module — duplicate-lookup-repository.ts) and never
 * mutates a transaction's own extracted/suggested fields — only
 * `duplicateCandidateOf`/`duplicateCheck` are ever set.
 *
 * Priority order per transaction (a higher-priority type, once it fires,
 * is never overridden by a lower one): statement_duplicate (applies to
 * every row at once) > internal_duplicate > transaction_duplicate /
 * near_duplicate.
 */

import type { WorkspaceTransaction } from "../workspace/statement-workspace-model";
import { checkStatementDuplicate, checkTransactionDuplicate, detectInternalDuplicates } from "./duplicate-detector";
import type { ExistingStatementRecord, ExistingTransactionRecord, StatementMetaForDuplicateCheck } from "./duplicate-types";

export interface ApplyDuplicateDetectionContext {
  statementMeta: StatementMetaForDuplicateCheck;
  existingStatements: ExistingStatementRecord[];
  existingTransactions: ExistingTransactionRecord[];
}

export function applyDuplicateDetection(
  transactions: WorkspaceTransaction[],
  context: ApplyDuplicateDetectionContext,
): WorkspaceTransaction[] {
  const statementDuplicate = checkStatementDuplicate(context.statementMeta, context.existingStatements);
  if (statementDuplicate) {
    return transactions.map((t) => ({ ...t, duplicateCandidateOf: statementDuplicate.matchedTransactionId, duplicateCheck: statementDuplicate }));
  }

  const internalResults = detectInternalDuplicates(transactions);

  return transactions.map((transaction, index) => {
    const internalResult = internalResults[index]!;
    const result = internalResult.status === "duplicate_candidate" ? internalResult : checkTransactionDuplicate(transaction, context.existingTransactions);
    return { ...transaction, duplicateCandidateOf: result.matchedTransactionId, duplicateCheck: result };
  });
}
