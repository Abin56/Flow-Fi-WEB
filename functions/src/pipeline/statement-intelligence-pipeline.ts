/**
 * Statement Intelligence Pipeline — the Review Model Builder. Composes
 * every Statement Intelligence module in the exact order fixed by
 * docs/parser-pipeline-design.md §4's chain:
 *
 *   Merchant Normalizer → Duplicate Detection → Category Suggestion →
 *   Account Suggestion → Tag Suggestion (+ recurring/subscription/transfer
 *   detection) → Split Detection → Validation Engine → Confidence Engine →
 *   Workspace Builder
 *
 * Pure and Firestore-independent by construction (same discipline as
 * `StatementWorkspaceModel` itself) — every module it calls is a pure
 * function; Firestore reads (existing transactions/statements for
 * Duplicate Detection) are the caller's job, passed in as already-fetched
 * `DuplicateDetectionContext` data, same pattern `applyDuplicateDetection`
 * itself already established. This is the single seam a Worker/Cloud
 * Function calls once it has: extracted `WorkspaceTransaction[]` (from the
 * bank-specific field extractor), the statement's own metadata sections,
 * and the already-fetched duplicate-comparison records.
 */

import { suggestAccount } from "../account/account-suggester";
import { suggestCategory } from "../category/category-suggester";
import { applyDuplicateDetection, type ApplyDuplicateDetectionContext } from "../duplicate/apply-duplicate-detection";
import { normalizeMerchant } from "../merchant/merchant-normalizer";
import { detectSplitRules } from "../split/split-detector";
import { suggestTags } from "../tagging/tag-suggester";
import { applyConfidenceEngine } from "../confidence/confidence-engine";
import { runValidationEngine } from "../validation/validation-engine";
import { buildStatementWorkspace, type WorkspaceBuilderContext } from "../workspace/workspace-builder";
import type { BillingSummary, CardInfo, ExtractionDiagnostics, StatementInfo, StatementWorkspaceModel, WorkspaceTransaction } from "../workspace/statement-workspace-model";

export interface StatementIntelligencePipelineInput {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
  transactions: WorkspaceTransaction[];
  diagnostics: ExtractionDiagnostics;
  /** The credit card this statement was uploaded against — Account Suggestion's only input (docs/parser-pipeline-design.md §7). */
  accountId: string;
  duplicateContext: ApplyDuplicateDetectionContext;
  context?: WorkspaceBuilderContext;
}

/** Runs every per-transaction Statement Intelligence module, in fixed order, over one row. */
function applyPerTransactionIntelligence(transaction: WorkspaceTransaction, accountId: string): WorkspaceTransaction {
  const normalizedMerchant = normalizeMerchant(transaction.merchantRaw.value);
  const suggestedCategory = suggestCategory(normalizedMerchant);
  const suggestedAccount = suggestAccount(accountId);
  const tagResult = suggestTags(normalizedMerchant);

  return {
    ...transaction,
    normalizedMerchant,
    suggestedCategory,
    suggestedAccount,
    suggestedTags: tagResult.suggestedTags,
    recurringDetected: tagResult.recurringDetected,
    subscriptionDetected: tagResult.subscriptionDetected,
    transferDetected: tagResult.transferDetected,
  };
}

export function runStatementIntelligencePipeline(input: StatementIntelligencePipelineInput): StatementWorkspaceModel {
  const withMerchantIntelligence = input.transactions.map((t) => applyPerTransactionIntelligence(t, input.accountId));
  const withDuplicates = applyDuplicateDetection(withMerchantIntelligence, input.duplicateContext);
  const suggestedSplitRules = detectSplitRules(withDuplicates);

  const { errors: validationErrors, warnings: validationWarnings } = runValidationEngine({
    statementInfo: input.statementInfo,
    billingSummary: input.billingSummary,
    transactions: withDuplicates,
  });

  const withConfidence = applyConfidenceEngine(withDuplicates);

  const workspace = buildStatementWorkspace({
    statementInfo: input.statementInfo,
    cardInfo: input.cardInfo,
    billingSummary: input.billingSummary,
    transactions: withConfidence,
    diagnostics: input.diagnostics,
    duplicateCandidates: withDuplicates
      .map((t, index) =>
        t.duplicateCheck.status === "duplicate_candidate" && t.duplicateCheck.matchedTransactionId
          ? {
              transactionIndex: index,
              possibleMatchTransactionId: t.duplicateCheck.matchedTransactionId,
              matchConfidence: t.duplicateCheck.confidence,
              matchReason: (t.duplicateCheck.type === "internal_duplicate" || t.duplicateCheck.type === "near_duplicate" ? "fuzzy_match" : "exact_fingerprint") as "fuzzy_match" | "exact_fingerprint",
            }
          : null,
      )
      .filter((c): c is NonNullable<typeof c> => c !== null),
    validationErrors,
    validationWarnings,
    context: input.context,
  });

  return { ...workspace, suggestedSplitRules };
}
