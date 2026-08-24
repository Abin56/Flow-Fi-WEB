/**
 * Account Suggester — Statement Intelligence Layer, §7 of
 * docs/parser-pipeline-design.md ("Account/People Suggestion Engines —
 * resolved"). Real, not a stub: for a credit-card statement there is no
 * ambiguity about which account a transaction belongs to — every row
 * inherits the `accountId` the document was uploaded against (already known
 * on the `financialDocuments` doc since M1-T5/T6, passed in here rather than
 * looked up, since this module has no Firestore access).
 *
 * Exists as a real seam, not folded into the Transaction Extractor, because
 * future non-credit-card document types will need genuine account-matching
 * logic here; a split-leg posting to a different account is a Milestone 8
 * Review Workspace user action, not something this engine suggests.
 */

import type { Suggestion } from "../workspace/statement-workspace-model";

export function suggestAccount(accountId: string): Suggestion<string> {
  return { value: accountId, confidence: 1.0, source: "account_assignment" };
}
