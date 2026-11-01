/**
 * Live account re-matching for SMS candidates.
 *
 * Android resolves a candidate's `accountId`/`cardId` ONCE, when it builds the candidate (`AccountCardMatcher`, run by
 * `generateMissingTransactionCandidates` — "existing rows are never rebuilt"). So when the user later corrects a saved
 * account's / card's last-4, or adds the account they hadn't set up yet, every already-synced candidate keeps the stale answer
 * and sits in "Needs account" forever. The candidate document is Android-owned (web may only delete it), so the web cannot
 * fix it at the source — instead it re-runs the SAME rule against the user's CURRENT accounts and cards, in memory, every
 * time they change. Nothing is written; the corrected ids only exist in the web's view of the candidate.
 *
 * The rule is `account_card_matcher.dart`'s, nothing looser:
 *   - the SMS's last-4 is the only signal that can resolve a match (a bank name alone, or a reference number, never does —
 *     and the candidate carries no sender, by the privacy contract);
 *   - a card is represented by ITS OWN last-4; a plain account only counts when no card profile with a last-4 stands for it;
 *   - exactly ONE target may carry that last-4 — two or more is ambiguous and is never guessed.
 * On top of it, two web-side guards so a re-match can never be a wrong automatic match:
 *   - if the SMS names a bank we recognise and the account's bank is a different known bank, it is not matched;
 *   - an already-resolved match is only replaced when the account it points at now has a DIFFERENT last-4 than the SMS and
 *     a single other account/card has the SMS's last-4 — i.e. exactly what a fresh Android build would pick today.
 */

import { BANKS } from "@/lib/data/bank-registry";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { resolveCandidateDestinationKey } from "./candidate-account-matching";

export interface RematchTarget {
  key: string;
  accountId: string;
  cardId: string | null;
  lastFour: string;
  bankId: string | null;
  label: string;
}

/** Why the candidate's destination was recomputed. */
export type RematchReason =
  /** Android found no account/card when it built the candidate. */
  | "unmatched"
  /** Android's account/card has since been deleted. */
  | "missing"
  /** Android's account/card is still there but its last-4 no longer agrees with the SMS, and another one does. */
  | "stale";

export interface RematchInfo {
  reason: RematchReason;
  key: string;
  label: string;
  /** True when the SMS's bank also matches the account's bank (the last-4 alone already decided the match). */
  bankConfirmed: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The registry bank a free-text bank name (as Android sent it) refers to, or `null` when it can't be told. Deliberately
 * strict: only used to REJECT a re-match whose bank clearly differs, so "can't tell" must never read as a conflict.
 */
export function bankIdFromName(name: string | null | undefined): string | null {
  const n = name ? norm(name) : "";
  if (n.length < 3) return null;
  // Most specific evidence wins: an exact id/name/short-code beats a short code found as a word, which beats a full name found
  // inside longer text — and among name-inside-text hits the longer name wins ("State Bank of India" contains "Bank of India").
  const scored: { id: string; score: number }[] = [];
  for (const b of BANKS) {
    const full = norm(b.name);
    const short = norm(b.shortCode);
    if (n === b.id.replace(/_/g, "") || n === full || n === short) scored.push({ id: b.id, score: 1_000_000 });
    else if (short.length >= 3 && new RegExp(`(^|[^a-z0-9])${short}([^a-z0-9]|$)`, "i").test(name!)) scored.push({ id: b.id, score: 1_000 });
    else if (n.includes(full)) scored.push({ id: b.id, score: full.length });
  }
  if (scored.length === 0) return null;
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  return top.length === 1 ? top[0].id : null;
}

/** Every account / card an SMS can resolve to, built from the CURRENT lists exactly as Android's matcher builds its targets. */
export function buildRematchTargets(accounts: Account[], creditCards: CreditCardProfile[]): RematchTarget[] {
  const targets: RematchTarget[] = [];
  const cardAccountIds = new Set<string>();
  for (const card of creditCards) {
    const lastFour = card.lastFourDigits?.trim();
    if (!lastFour) continue;
    const account = accounts.find((a) => a.id === card.accountId);
    // A card whose account is gone can't be posted to (same rule as `resolveCandidateDestinationKey`).
    if (!account) continue;
    cardAccountIds.add(card.accountId);
    targets.push({ key: `card:${card.id}`, accountId: account.id, cardId: card.id, lastFour, bankId: account.bankId ?? bankIdFromName(card.issuer) ?? null, label: `${account.name} •••• ${lastFour}` });
  }
  const profiledAccountIds = new Set(creditCards.map((c) => c.accountId));
  for (const account of accounts) {
    if (cardAccountIds.has(account.id)) continue;
    // A credit-card account whose profile hasn't loaded (or has no last-4) is never matched by its account number: that
    // number isn't what the card statement SMS prints, and a half-loaded list must not produce a wrong match.
    if (account.type === "card" && account.cardSubtype === "credit" && !profiledAccountIds.has(account.id)) continue;
    const lastFour = account.accountNumberLast4?.trim();
    if (!lastFour) continue;
    targets.push({ key: `account:${account.id}`, accountId: account.id, cardId: null, lastFour, bankId: account.bankId, label: `${account.name} •••• ${lastFour}` });
  }
  return targets;
}

/** The stored last-4 of the account/card a candidate currently points at (for the "stale" check), or `null` if it has none. */
function currentLastFour(candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId">, accounts: Account[], creditCards: CreditCardProfile[]): string | null {
  if (candidate.cardId) return creditCards.find((c) => c.id === candidate.cardId)?.lastFourDigits?.trim() || null;
  if (candidate.accountId) return accounts.find((a) => a.id === candidate.accountId)?.accountNumberLast4?.trim() || null;
  return null;
}

/** The corrected match for one candidate, or `null` when its current destination should stand (or no safe match exists). */
export function rematchCandidate(
  candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId" | "rawLastFour" | "bankName">,
  targets: RematchTarget[],
  accounts: Account[],
  creditCards: CreditCardProfile[],
): RematchInfo | null {
  const lastFour = candidate.rawLastFour?.trim();
  if (!lastFour) return null;
  const sameLastFour = targets.filter((t) => t.lastFour === lastFour);
  if (sameLastFour.length !== 1) return null; // none, or ambiguous — never guessed
  const target = sameLastFour[0];

  const currentKey = resolveCandidateDestinationKey(candidate, accounts, creditCards);
  if (currentKey === target.key) return null;

  const smsBank = bankIdFromName(candidate.bankName);
  if (smsBank && target.bankId && target.bankId !== "generic" && target.bankId !== smsBank) return null;
  const bankConfirmed = smsBank != null && target.bankId === smsBank;

  if (currentKey != null) {
    // Android's match still resolves. Only replace it when the account it points at provably no longer carries this last-4.
    const was = currentLastFour(candidate, accounts, creditCards);
    if (!was || was === lastFour) return null;
    return { reason: "stale", key: target.key, label: target.label, bankConfirmed };
  }
  const reason: RematchReason = candidate.accountId != null || candidate.cardId != null ? "missing" : "unmatched";
  return { reason, key: target.key, label: target.label, bankConfirmed };
}

/**
 * Re-runs the match for every candidate against the current accounts/cards. Returns the candidates with `accountId`/`cardId`
 * corrected where a safe match exists (untouched candidates keep their object identity), plus what changed per candidate id.
 * Pass `ready = false` until the accounts have actually loaded — an empty list must never be read as "no account matches".
 */
export function applyAccountRematch(
  candidates: SmsTransactionCandidate[],
  accounts: Account[],
  creditCards: CreditCardProfile[],
  ready = accounts.length > 0,
): { candidates: SmsTransactionCandidate[]; rematched: Map<string, RematchInfo> } {
  const rematched = new Map<string, RematchInfo>();
  if (!ready || candidates.length === 0) return { candidates, rematched };
  const targets = buildRematchTargets(accounts, creditCards);
  if (targets.length === 0) return { candidates, rematched };
  const out = candidates.map((c) => {
    const info = rematchCandidate(c, targets, accounts, creditCards);
    if (!info) return c;
    rematched.set(c.id, info);
    const target = targets.find((t) => t.key === info.key)!;
    return { ...c, accountId: target.accountId, cardId: target.cardId };
  });
  return { candidates: out, rematched };
}
