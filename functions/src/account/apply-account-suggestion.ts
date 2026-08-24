/**
 * Applies the Account Suggester to a full list of WorkspaceTransactions —
 * Statement Intelligence Layer pipeline entry point (Category Suggestion →
 * Account Suggestion → People Suggestion → ...). Pure reshaping: sets
 * `suggestedAccount` to the statement's own `accountId` on every row,
 * touches nothing else.
 */

import type { WorkspaceTransaction } from "../workspace/statement-workspace-model";
import { suggestAccount } from "./account-suggester";

export function applyAccountSuggestion(transactions: WorkspaceTransaction[], accountId: string): WorkspaceTransaction[] {
  const suggestion = suggestAccount(accountId);
  return transactions.map((transaction) => ({ ...transaction, suggestedAccount: suggestion }));
}
