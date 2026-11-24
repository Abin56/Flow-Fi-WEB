/**
 * Description suggestion for a captured SMS candidate. Pure and local (no network, no Firestore): it reads the
 * candidate's already-parsed fields and its original message, and reuses the shared description analyzer
 * (`@/lib/services/description-analyzer`) — the same merchant list, noise rules and history rules.
 *
 * It only ever returns TEXT for the Description field. It never reads or changes the amount, direction, account,
 * category, duplicate matching or the candidate itself — the duplicate check keeps using the candidate's own parsed
 * merchant/bank, reference and message, whatever description the reviewer ends up choosing.
 */

import { suggestForRow, type DescriptionDirection, type DescriptionHistory, type DescriptionSuggestion } from "@/lib/services/description-analyzer";
import type { Category } from "@/lib/models/category";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { suggestCategoryIntel, type CategoryHistory } from "@/lib/services/category-intelligence";

export type CandidateForSuggestion = Pick<SmsTransactionCandidate, "merchant" | "bankName" | "originalMessage" | "direction"> & Partial<Pick<SmsTransactionCandidate, "eventType">>;

interface Narration {
  text: string;
  upi: boolean;
}

/** Words that end a payee phrase inside a bank SMS ("…to SWIGGY BUNDL TECHNOLOGIES Ref 827392 on 22Sep26"). */
const PAYEE_END = String.raw`(?=\s+(?:ref|upi|on|via|using|from|by|avl|bal|available|txn|trf|call|if|not|dated|date|info|a\/c|ac|acct)\b|\s+\d{1,2}[-\/]\d|[.,;]\s|\s*$)`;
const TO_PAYEE = new RegExp(String.raw`\b(?:paid to|payment to|sent to|transferred to|debited (?:via upi )?to|to|towards|at)\s+(?:vpa\s+)?([^\n]{2,80}?)${PAYEE_END}`, "gi");
const FROM_PAYEE = new RegExp(String.raw`\b(?:received from|credited (?:by|from)|from|by)\s+(?:vpa\s+)?([^\n]{2,80}?)${PAYEE_END}`, "gi");

/** The narration-like pieces of a message, most specific first: a `UPI/DR/…` chain, then the phrase after to/at (debit) or from/by (credit). */
export function messageNarrations(message: string, direction: DescriptionDirection | null): Narration[] {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const mentionsUpi = /\bUPI\b|\bVPA\b|@[a-z]{2,}/i.test(text);
  const out: Narration[] = [];
  const chain = text.match(/\bUPI\/[^\s]+/i);
  if (chain) out.push({ text: chain[0], upi: true });
  const take = (re: RegExp) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ text: m[1]!.trim(), upi: mentionsUpi });
  };
  if (direction === "credit") take(FROM_PAYEE);
  else take(TO_PAYEE);
  return out;
}

/** The payment method, only when the candidate clearly says so — an ordinary bank transfer gets no label. */
function paymentMethod(c: CandidateForSuggestion): "UPI" | "Card" | null {
  const message = c.originalMessage ?? "";
  const type = String(c.eventType ?? "");
  if (/UPI|VPA/i.test(message) || /upi/i.test(type)) return "UPI";
  if (/card/i.test(type) || /card/i.test(message)) return "Card";
  return null;
}

/** "Merchant / Purpose · Method". The user's own history wording and the generic payment-type fallback are left untouched. */
function format(c: CandidateForSuggestion, s: DescriptionSuggestion): DescriptionSuggestion {
  if (s.basis === "history" || s.basis === "payment_type") return s;
  const method = paymentMethod(c);
  const text = s.text.replace(/^Payment (?:to|from) /i, "");
  return { ...s, text: method && !/·\s*(UPI|Card)$/i.test(text) ? `${text} · ${method}` : text };
}

const RANK = { high: 3, medium: 2, low: 1 } as const;

/**
 * The best suggestion for a candidate, or null. Sources, in order of trust: the merchant Android parsed, then the
 * payee phrase / UPI chain inside the original message, then a recognised merchant (or the user's own wording) anywhere
 * in the message. A more confident suggestion beats an earlier, weaker one.
 */
export function suggestCandidateDescription(candidate: CandidateForSuggestion, history?: DescriptionHistory | null): DescriptionSuggestion | null {
  try {
    const direction: DescriptionDirection | null = candidate.direction === "credit" || candidate.direction === "debit" ? candidate.direction : null;
    const message = candidate.originalMessage ?? "";
    const mentionsUpi = /\bUPI\b|\bVPA\b|@[a-z]{2,}/i.test(message);
    let best: DescriptionSuggestion | null = null;
    const consider = (s: DescriptionSuggestion | null) => {
      if (s && (!best || RANK[s.confidence] > RANK[best.confidence])) best = s;
    };
    if (candidate.merchant) consider(suggestForRow({ description: candidate.merchant, direction }, history, { upi: mentionsUpi, keepSame: true }));
    for (const n of messageNarrations(message, direction)) consider(suggestForRow({ description: n.text, direction }, history, { upi: n.upi, keepSame: true }));
    if (message && best == null) {
      const whole = suggestForRow({ description: message, direction }, history, { keepSame: true });
      if (whole && (whole.basis === "known_merchant" || whole.basis === "history")) consider(whole);
    }
    // No payee anywhere (e.g. "credited to AXIS BANK LIMITED via UPI"): the only honest wording is the payment type.
    if (best == null && direction && mentionsUpi) return { text: direction === "credit" ? "UPI payment received" : "UPI payment", confidence: "low", basis: "payment_type" };
    return best ? format(candidate, best) : null;
  } catch {
    return null;
  }
}

/** Suggestions for a list of candidates — one pass, keyed by candidate id; a failure on one never affects the others. */
export function suggestionsForCandidates(candidates: readonly (CandidateForSuggestion & { id: string })[], history?: DescriptionHistory | null): Map<string, DescriptionSuggestion> {
  const out = new Map<string, DescriptionSuggestion>();
  for (const c of candidates) {
    const s = suggestCandidateDescription(c, history);
    if (s) out.set(c.id, s);
  }
  return out;
}

/**
 * The description to put in the field when a candidate is opened (and used by bulk import): the suggestion, unless it is only
 * the generic "UPI payment" fallback — then the existing detected name stays. Callers apply it only to an untouched description.
 */
export function autoFillDescription(candidate: CandidateForSuggestion, history?: DescriptionHistory | null): string | null {
  const s = suggestCandidateDescription(candidate, history);
  return s && s.basis !== "payment_type" ? s.text : null;
}

/**
 * The category id to pre-select for a candidate, only when the shared category intelligence is confident (the user's own
 * history for that payee, the recognised merchant's business, or one unambiguous keyword). Tries the auto-filled
 * description, the parsed merchant and the message's payee phrase, in that order. Never creates a category and never
 * touches anything but the category choice; callers apply it once to an untouched form.
 */
export function autoFillCategory(
  candidate: CandidateForSuggestion,
  allowed: readonly Category[],
  categoryHistory: CategoryHistory | null | undefined,
  descriptionHistory?: DescriptionHistory | null,
): string | null {
  try {
    const direction = candidate.direction;
    if (direction !== "debit" && direction !== "credit") return null;
    const kind = direction === "credit" ? "income" : "expense";
    const texts = [autoFillDescription(candidate, descriptionHistory), candidate.merchant, ...messageNarrations(candidate.originalMessage ?? "", direction).map((n) => n.text)];
    for (const text of texts) {
      if (!text) continue;
      const intel = suggestCategoryIntel({ text, kind, categories: allowed, history: categoryHistory });
      if (intel.confident && intel.category) return intel.category.id;
    }
    return null;
  } catch {
    return null;
  }
}
