/**
 * Display helpers for an SMS candidate's account/card. Unlike the earlier,
 * incorrect model this replaces, matching itself is NOT done here — Android's
 * `AccountCardMatcher` already resolves `accountId`/`cardId` on-device
 * against the same `accounts`/`creditCards` Firestore collections before the
 * candidate is ever synced (see `sms_transaction_candidate_cloud.dart`'s
 * module doc: "Matches an existing Account.id ... never a guess"). The web
 * app's job is only to look the already-resolved id up for display, and to
 * fall back gracefully when:
 *   - `accountId`/`cardId` is null (Android couldn't resolve one), or
 *   - the id no longer points at anything (the account/card was deleted on
 *     this or another device since the candidate was synced).
 * Neither case invents an account — both fall back to the raw
 * `rawLastFour`/`bankName` hint Android sent, exactly what a human reviewer
 * needs to resolve it manually.
 */

import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

/**
 * "HDFC Credit Card •••• 4821" / "SBI Savings •••• 9981" style display label
 * for a candidate's resolved account/card — masked last-4 only. Returns
 * `null` when `accountId`/`cardId` is unset, or when set but no longer
 * resolves to a real account/card (deleted since sync).
 */
export function formatMatchedAccountLabel(
  candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId">,
  accounts: Account[],
  creditCards: CreditCardProfile[],
): string | null {
  if (candidate.cardId) {
    const card = creditCards.find((c) => c.id === candidate.cardId);
    if (!card) return null;
    const account = accounts.find((a) => a.id === card.accountId);
    const name = account?.name ?? "Credit Card";
    return card.lastFourDigits ? `${name} •••• ${card.lastFourDigits}` : name;
  }
  if (candidate.accountId) {
    const account = accounts.find((a) => a.id === candidate.accountId);
    if (!account) return null;
    return account.accountNumberLast4 ? `${account.name} •••• ${account.accountNumberLast4}` : account.name;
  }
  return null;
}

/**
 * Display fallback for a candidate whose account/card isn't resolved to a
 * real, currently-existing record (`formatMatchedAccountLabel` returned
 * `null`). Never invents an account — shows only what Android actually sent
 * (`rawLastFour`/`bankName`), same privacy-safe, masked-only convention as
 * the resolved label above.
 */
export function formatUnresolvedAccountHint(candidate: Pick<SmsTransactionCandidate, "bankName" | "rawLastFour">): string {
  if (candidate.rawLastFour) return `Unmatched • •••• ${candidate.rawLastFour}`;
  if (candidate.bankName) return `Unmatched • ${candidate.bankName}`;
  return "Unmatched";
}
