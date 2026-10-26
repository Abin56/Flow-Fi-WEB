/**
 * Reconciliation session identity and "already imported" detection.
 *
 * A row counts as ALREADY IMPORTED only when the transaction carrying its deterministic import key exists —
 * `txn_<importTransferKey(rowId, sessionId)>`, the id `commitReviewImport` gives every row it writes. Any other
 * resemblance is just a candidate the user must decide on.
 *
 * Two session ids can apply to the same capture on an account: the one a later Reconciliation import will use
 * (`reconciliationSessionId`, derived from the stored source fingerprint, so it survives a refresh without the raw
 * text), and Smart Capture's own direct-import id (`captureSessionId`, which needs the raw text — computed once at
 * paste time for each account and kept only as an opaque hash).
 */

import type { Account } from "@/lib/models/account";
import { captureSessionId } from "@/features/smart-capture/lib/capture-review";
import { importTransferKey } from "@/features/transaction-studio/lib/commit-review-import";

export function reconciliationSessionId(fingerprint: string, accountId: string): string {
  const input = `${accountId}\n${fingerprint}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619);
    h2 = Math.imul(h2 ^ ch, 2246822519);
  }
  return `reconcile_${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

/** Smart Capture's direct-import session id for this exact paste on every account — opaque hashes, no text. */
export function priorCaptureSessionIds(sourceText: string, accounts: Pick<Account, "id">[]): Record<string, string> {
  return Object.fromEntries(accounts.map((a) => [a.id, captureSessionId(sourceText, a.id)]));
}

/** Every transaction id that would mean "this row was already imported" on `accountId`. */
export function importedTransactionIdsFor(rowId: string, params: { fingerprint: string; accountId: string; priorSessionIds: Record<string, string> }): string[] {
  const sessions = [reconciliationSessionId(params.fingerprint, params.accountId), params.priorSessionIds[params.accountId]].filter((s): s is string => !!s);
  return sessions.map((s) => `txn_${importTransferKey(rowId, s)}`);
}
