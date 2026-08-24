/**
 * Applies the Tag Suggester to a full list of WorkspaceTransactions —
 * Statement Intelligence Layer pipeline entry point (Account Suggestion →
 * Tag Suggestion → Split Detection → ...). Pure reshaping: sets
 * `suggestedTags`/`recurringDetected`/`subscriptionDetected`/
 * `transferDetected` from each transaction's own `normalizedMerchant`,
 * touches nothing else.
 */

import type { WorkspaceTransaction } from "../workspace/statement-workspace-model";
import { suggestTags } from "./tag-suggester";

export function applyTagSuggestion(transactions: WorkspaceTransaction[]): WorkspaceTransaction[] {
  return transactions.map((transaction) => {
    const result = suggestTags(transaction.normalizedMerchant);
    return {
      ...transaction,
      suggestedTags: result.suggestedTags,
      recurringDetected: result.recurringDetected,
      subscriptionDetected: result.subscriptionDetected,
      transferDetected: result.transferDetected,
    };
  });
}
