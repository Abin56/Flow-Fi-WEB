/**
 * Applies the Category Suggester to a full list of WorkspaceTransactions —
 * Statement Intelligence Layer, module 3's pipeline entry point
 * (Merchant Normalizer → Duplicate Detection → Category Suggestion → ...).
 * Pure reshaping: sets `suggestedCategory` from each transaction's own
 * `normalizedMerchant`, touches nothing else.
 */

import type { WorkspaceTransaction } from "../workspace/statement-workspace-model";
import { suggestCategory } from "./category-suggester";

export function applyCategorySuggestion(transactions: WorkspaceTransaction[]): WorkspaceTransaction[] {
  return transactions.map((transaction) => ({
    ...transaction,
    suggestedCategory: suggestCategory(transaction.normalizedMerchant),
  }));
}
