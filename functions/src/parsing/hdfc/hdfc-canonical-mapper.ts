/**
 * HDFC Canonical Transaction Mapper — Task 4 module 5
 * (docs/parser-pipeline-design.md v3 §10; ADR-006).
 *
 * Single responsibility: convert Module 4's extracted field results into
 * the shared `WorkspaceTransaction` model the Statement Workspace already
 * consumes (functions/src/workspace/statement-workspace-model.ts) — pure
 * reshaping, nothing else. Explicitly does NOT categorize, normalize
 * merchants, or detect duplicates; every placeholder field
 * (`suggestedCategory`, `suggestedPerson`, `suggestedTags`, `expenseType`,
 * `transferDetected`, `recurringDetected`, `subscriptionDetected`,
 * `duplicateCandidateOf`, `warnings`) is left at its "not yet populated"
 * value for those later, separate engines to fill in.
 *
 * `needsReview`/row `confidence` here are NOT a business categorization —
 * they are a structural rollup of this row's OWN extraction confidence
 * (did date/amount/merchant actually get parsed), the same kind of signal
 * Module 4 already produces per field. Account assignment (`suggestedAccount`)
 * is likewise not an inference: it is a direct, caller-supplied tag (the
 * account this statement was uploaded against), consistent with how the
 * existing golden fixtures already treat it as a trivial assignment, not a
 * suggestion algorithm (docs/parser-pipeline-design.md v3 §7).
 */

import { NOT_YET_CHECKED_DUPLICATE_RESULT, type ExtractedField, type WorkspaceTransaction } from "../../workspace/statement-workspace-model";
import type { HdfcExtractedTransactionFields } from "./hdfc-field-extractor";

export interface HdfcCanonicalMapperContext {
  /** The account this statement is being imported against, if already known — a direct tag, not an inference (see module comment). */
  accountId?: string;
}

function rowConfidence(fields: HdfcExtractedTransactionFields): number {
  return Math.min(fields.transactionDate.confidence, fields.amount.confidence, fields.merchant.confidence);
}

/**
 * Module 4 exposes `debit`/`credit` as two separate fields (per the required
 * field list) — exactly one is ever populated for a real row. The canonical
 * model's `direction` collapses that pair back into a single tagged value,
 * but must still carry over whichever of the two fields actually won
 * (page/boundingBox/extractionMethod included, not just value/confidence/
 * source) — spreading the whole winning field, not just three of its
 * properties, is what keeps this a lossless reshape rather than a silent
 * provenance drop (a real bug this function was rewritten to fix — see the
 * Module 5 validation report).
 */
function directionFieldFrom(fields: HdfcExtractedTransactionFields): ExtractedField<"debit" | "credit"> {
  if (fields.debit.value != null) return { ...fields.debit, value: "debit" };
  if (fields.credit.value != null) return { ...fields.credit, value: "credit" };
  return { value: "debit", confidence: 0, source: "unavailable" };
}

export function mapHdfcFieldsToWorkspaceTransactions(
  fields: HdfcExtractedTransactionFields[],
  context: HdfcCanonicalMapperContext = {},
): WorkspaceTransaction[] {
  return fields.map((row, index) => {
    const confidence = rowConfidence(row);
    const direction = directionFieldFrom(row);
    const needsReview = row.transactionDate.value == null || row.amount.value == null || (row.debit.value == null && row.credit.value == null);

    const transaction: WorkspaceTransaction = {
      date: row.transactionDate,
      valueDate: row.valueDate,
      merchantRaw: row.merchant,
      description: row.description,
      // Spread the whole source field (not just value/confidence/source) so page/boundingBox/extractionMethod
      // survive the reshape — Module 4's per-field provenance must not be silently dropped here.
      amount: { ...row.amount, value: row.amount.value ?? 0 },
      direction,
      referenceNumber: row.referenceNumber,
      currency: row.currency,

      sourcePage: row.page,
      sourceLineIndex: index,
      originalRawText: row.originalRawText,
      originalRowNumber: index + 1,

      normalizedMerchant: null,
      suggestedCategory: null,
      suggestedAccount: context.accountId ? { value: context.accountId, confidence: 1, source: "account_assignment" } : null,
      suggestedPerson: null,
      suggestedTags: [],
      expenseType: null,
      transferDetected: false,
      recurringDetected: false,
      subscriptionDetected: false,
      duplicateCandidateOf: null,
      duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
      needsReview,
      warnings: [],
      confidence,
    };

    return transaction;
  });
}
