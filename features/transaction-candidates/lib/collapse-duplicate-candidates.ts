/**
 * One SMS must be ONE row. Android can upload the same message as two candidate documents with different ids
 * (e.g. a re-delivered SMS or two sync paths). The documents are Android-owned and never written from the web, so
 * the twin is hidden here, in memory only.
 *
 * Only a certain twin is collapsed: identical amount, direction, instant, account and — the deciding evidence — the same
 * bank reference number (or, when neither carries a reference, the identical original message text). Anything weaker
 * (two same-amount payments with no shared reference) may be two real payments, so both stay visible.
 */
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

function twinKey(c: SmsTransactionCandidate): string | null {
  const ref = c.referenceNumber?.trim();
  const message = c.originalMessage?.trim();
  const evidence = ref ? `ref:${ref.toLowerCase()}` : message ? `msg:${message}` : null;
  if (!evidence) return null;
  return [c.amount, c.direction, c.transactionDate.getTime(), c.accountId ?? "", c.cardId ?? "", c.rawLastFour ?? "", (c.bankName ?? "").toLowerCase(), evidence].join("|");
}

/** Keeps the earliest-created candidate of each twin group (ties: lowest id); order of the input is preserved. */
export function collapseDuplicateCandidates(candidates: SmsTransactionCandidate[]): SmsTransactionCandidate[] {
  const keeper = new Map<string, SmsTransactionCandidate>();
  for (const c of candidates) {
    const key = twinKey(c);
    if (key == null) continue;
    const kept = keeper.get(key);
    if (!kept || c.createdAt.getTime() < kept.createdAt.getTime() || (c.createdAt.getTime() === kept.createdAt.getTime() && c.id < kept.id)) keeper.set(key, c);
  }
  return candidates.filter((c) => {
    const key = twinKey(c);
    return key == null || keeper.get(key) === c;
  });
}
