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
    // The card's own account is what a transaction actually posts to — a card whose account is gone can't be imported to.
    if (!account) return null;
    return card.lastFourDigits ? `${account.name} •••• ${card.lastFourDigits}` : account.name;
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
export function formatUnresolvedAccountHint(
  candidate: Pick<SmsTransactionCandidate, "bankName" | "rawLastFour">,
  state: CandidateDestinationState = "unmatched",
): string {
  const hint = candidate.rawLastFour ? `•••• ${candidate.rawLastFour}` : candidate.bankName;
  const lead = state === "missing" ? "Account no longer exists" : "Not matched";
  return hint ? `${lead} • ${hint}` : lead;
}

/**
 * `matched`: Android's `accountId`/`cardId` still points at a real account (and, for a card, a real card whose
 * account exists). `missing`: Android sent an id but it no longer resolves (deleted since the sync) — must never
 * be pre-selected as a destination. `unmatched`: Android couldn't resolve one at all.
 */
export type CandidateDestinationState = "matched" | "missing" | "unmatched";

/**
 * The `"card:<id>"` / `"account:<id>"` destination key for a candidate's Android-resolved match, or `null` when
 * it is unmatched or no longer resolves. Never guesses — only echoes Android's own match.
 */
export function resolveCandidateDestinationKey(
  candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId">,
  accounts: Account[],
  creditCards: CreditCardProfile[],
): string | null {
  if (candidate.cardId) {
    const card = creditCards.find((c) => c.id === candidate.cardId);
    return card && accounts.some((a) => a.id === card.accountId) ? `card:${card.id}` : null;
  }
  if (candidate.accountId) return accounts.some((a) => a.id === candidate.accountId) ? `account:${candidate.accountId}` : null;
  return null;
}

export function candidateDestinationState(
  candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId">,
  accounts: Account[],
  creditCards: CreditCardProfile[],
): CandidateDestinationState {
  if (resolveCandidateDestinationKey(candidate, accounts, creditCards) != null) return "matched";
  return candidate.accountId != null || candidate.cardId != null ? "missing" : "unmatched";
}

/**
 * Candidates that may safely be bulk-imported together share a group: the same Android-resolved destination, or —
 * when nothing resolves — the same raw hint (same bank / last-4), so two different unmatched accounts can never
 * be silently merged into one destination.
 */
export function candidateDestinationGroupKey(
  candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId" | "rawLastFour" | "bankName">,
  accounts: Account[],
  creditCards: CreditCardProfile[],
): string {
  const key = resolveCandidateDestinationKey(candidate, accounts, creditCards);
  if (key) return key;
  return `unresolved:${candidate.cardId ?? candidate.accountId ?? ""}|${candidate.rawLastFour ?? ""}|${candidate.bankName ?? ""}`;
}

export interface LastFourSuggestion {
  key: string;
  kind: "account" | "card";
  label: string;
}

/**
 * Accounts / cards whose stored last-4 equals the SMS's last-4 — shown as SUGGESTIONS the reviewer may pick, never
 * selected for them. Matches on the last-4 only: a bank name alone never identifies an account, so a candidate with no
 * last-4 gets no suggestions. A card's own account is represented by the card (the same way Android's matcher treats
 * it), not listed a second time as a plain account.
 */
export function candidateLastFourSuggestions(
  candidate: Pick<SmsTransactionCandidate, "rawLastFour">,
  accounts: Account[],
  creditCards: CreditCardProfile[],
): LastFourSuggestion[] {
  const lastFour = candidate.rawLastFour?.trim();
  if (!lastFour) return [];
  const cardAccountIds = new Set(creditCards.map((c) => c.accountId));
  const out: LastFourSuggestion[] = [];
  for (const card of creditCards) {
    if (card.lastFourDigits?.trim() !== lastFour) continue;
    const account = accounts.find((a) => a.id === card.accountId);
    if (!account) continue;
    out.push({ key: `card:${card.id}`, kind: "card", label: `${account.name} •••• ${lastFour}` });
  }
  for (const account of accounts) {
    if (cardAccountIds.has(account.id)) continue;
    if (account.accountNumberLast4?.trim() !== lastFour) continue;
    out.push({ key: `account:${account.id}`, kind: "account", label: `${account.name} •••• ${lastFour}` });
  }
  return out;
}

export type LastFourCheck = "equal" | "different" | "sms-has-none" | "destination-has-none" | "no-destination";

export interface AccountMatchEvidence {
  /** The destination the evidence is about (the reviewer's current choice). */
  destinationLabel: string | null;
  smsLastFour: string | null;
  destinationLastFour: string | null;
  lastFourCheck: LastFourCheck;
  /** Android's own match target, when it still resolves — and whether the reviewer's choice is that same destination. */
  androidLabel: string | null;
  matchesAndroid: boolean;
}

/**
 * The facts behind "Matched from SMS": compares the SMS's last-4 with the selected destination's stored last-4. Pure
 * evidence — never changes a selection.
 */
export function explainAccountMatch(
  candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId" | "rawLastFour">,
  selectedKey: string | null,
  accounts: Account[],
  creditCards: CreditCardProfile[],
): AccountMatchEvidence {
  const androidKey = resolveCandidateDestinationKey(candidate, accounts, creditCards);
  const androidLabel = androidKey ? formatMatchedAccountLabel(candidate, accounts, creditCards) : null;
  const sms = candidate.rawLastFour?.trim() || null;

  let destinationLabel: string | null = null;
  let destinationLastFour: string | null = null;
  if (selectedKey) {
    const [kind, id] = selectedKey.split(":");
    if (kind === "card") {
      const card = creditCards.find((c) => c.id === id);
      const account = card ? accounts.find((a) => a.id === card.accountId) : undefined;
      destinationLastFour = card?.lastFourDigits?.trim() || null;
      destinationLabel = account ? (destinationLastFour ? `${account.name} •••• ${destinationLastFour}` : account.name) : null;
    } else {
      const account = accounts.find((a) => a.id === id);
      destinationLastFour = account?.accountNumberLast4?.trim() || null;
      destinationLabel = account ? (destinationLastFour ? `${account.name} •••• ${destinationLastFour}` : account.name) : null;
    }
  }

  let lastFourCheck: LastFourCheck;
  if (!selectedKey || !destinationLabel) lastFourCheck = "no-destination";
  else if (!sms) lastFourCheck = "sms-has-none";
  else if (!destinationLastFour) lastFourCheck = "destination-has-none";
  else lastFourCheck = sms === destinationLastFour ? "equal" : "different";

  return { destinationLabel, smsLastFour: sms, destinationLastFour, lastFourCheck, androidLabel, matchesAndroid: androidKey != null && selectedKey === androidKey };
}

/**
 * What to draw for a VERIFIED match: the matched account's bank (for its logo), its name (for a card that IS the card name,
 * e.g. "HDFC Freedom") and the masked last four. Returns `null` unless Android's `accountId`/`cardId` still resolves to a real
 * account — an unmatched or stale candidate never gets a bank, card or account identity from a bank name or a last-4 alone.
 */
export interface MatchedIdentity {
  kind: "card" | "account";
  bankId: string | null;
  name: string;
  last4: string | null;
  accountType: Account["type"] | null;
}

export function resolveMatchedIdentity(
  candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId">,
  accounts: Account[],
  creditCards: CreditCardProfile[],
): MatchedIdentity | null {
  if (candidate.cardId) {
    const card = creditCards.find((c) => c.id === candidate.cardId);
    const account = card ? accounts.find((a) => a.id === card.accountId) : undefined;
    if (!card || !account) return null;
    return { kind: "card", bankId: account.bankId ?? null, name: account.name, last4: card.lastFourDigits ?? null, accountType: account.type };
  }
  if (candidate.accountId) {
    const account = accounts.find((a) => a.id === candidate.accountId);
    if (!account) return null;
    return { kind: "account", bankId: account.bankId ?? null, name: account.name, last4: account.accountNumberLast4 ?? null, accountType: account.type };
  }
  return null;
}
