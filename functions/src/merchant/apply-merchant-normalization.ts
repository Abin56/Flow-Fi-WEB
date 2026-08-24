/**
 * Applies the Merchant Normalizer to a full list of WorkspaceTransactions
 * — Statement Intelligence Layer, module 1's entry point for the pipeline
 * (WorkspaceTransaction[] → Merchant Normalizer → Duplicate Detection →
 * ...). Pure reshaping: sets `normalizedMerchant` from each transaction's
 * own `merchantRaw.value`, touches nothing else.
 */

import type { WorkspaceTransaction } from "../workspace/statement-workspace-model";
import { normalizeMerchant } from "./merchant-normalizer";

export function applyMerchantNormalization(transactions: WorkspaceTransaction[]): WorkspaceTransaction[] {
  return transactions.map((transaction) => ({
    ...transaction,
    normalizedMerchant: normalizeMerchant(transaction.merchantRaw.value),
  }));
}
