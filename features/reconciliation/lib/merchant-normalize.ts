/**
 * Minimal client-side merchant normalizer (D3). Deterministic and explainable: uppercase, strip punctuation,
 * drop reference-like codes and payment-rail/location noise, map a short list of well-known aliases, then compare
 * word sets. Merchant similarity is SUPPORTING evidence for a match only — it never makes a match on its own and
 * never crosses accounts.
 *
 * Deliberately small. The server-side Merchant Registry (functions/src/merchant) lives in a separate package the
 * web app can't import, and users/{uid}/merchantMappings has no web reader — neither is used or changed here.
 */

import type { MerchantStrength } from "./types";

/** Payment rails, legal suffixes, country/currency and statement filler — never what identifies a merchant. */
const NOISE = new Set([
  "POS", "UPI", "IMPS", "NEFT", "RTGS", "ECOM", "ECS", "NACH", "ACH", "MB", "IB", "TXN", "TRF", "REF", "NO",
  "PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "INC", "CO", "CORP", "THE", "AND", "OF",
  "IN", "IND", "INDIA", "INR", "WWW", "COM", "NET", "ORG", "HTTP", "HTTPS",
  "PAYMENT", "PURCHASE", "SPENT", "DEBIT", "CREDIT", "CARD", "TRANSACTION", "VIA",
  "BANGALORE", "BENGALURU", "BLR", "MUMBAI", "BOMBAY", "DELHI", "NEW", "NOIDA", "GURGAON", "GURUGRAM", "CHENNAI",
  "HYDERABAD", "PUNE", "KOLKATA", "KOCHI", "COCHIN", "ERNAKULAM", "TRIVANDRUM", "THIRUVANANTHAPURAM", "AHMEDABAD",
]);

/** Well-known printed aliases → one canonical word. Kept short on purpose (D3). */
const ALIASES: Record<string, string> = {
  AMZN: "AMAZON",
  AMAZONPAY: "AMAZON",
  AMAZONIN: "AMAZON",
  BUNDL: "SWIGGY",
  SWIGGYINSTAMART: "SWIGGY",
  ZOMATOLTD: "ZOMATO",
  ANI: "OLA",
  OLACABS: "OLA",
  FKRT: "FLIPKART",
  FLIPKARTINTERNET: "FLIPKART",
  PHONEPE: "PHONEPE",
  PAYTMMALL: "PAYTM",
  GOOGLEPLAY: "GOOGLE",
  APPLECOMBILL: "APPLE",
  ITUNES: "APPLE",
  NETFLIXCOM: "NETFLIX",
};

function isReferenceLike(token: string): boolean {
  if (/^\d+$/.test(token)) return token.length >= 3; // order/terminal/reference numbers
  // Mixed letters+digits codes of 6+ characters (e.g. "X7K2P9Q1", "UPI12345") — reference ids, not names.
  return token.length >= 6 && /\d/.test(token) && /[A-Z]/.test(token);
}

/** The merchant words that identify a description, in order, deduplicated. Empty when nothing meaningful remains. */
export function merchantTokens(text: string): string[] {
  const raw = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 2 || NOISE.has(token) || isReferenceLike(token)) continue;
    const word = ALIASES[token] ?? token;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/** One comparable key for a description — used to group genuine repeats (same date + merchant + amount). */
export function merchantKey(text: string): string {
  return merchantTokens(text).join(" ");
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // A statement often runs a merchant into the next word ("RELIANCERETAIL"); a 4+ letter prefix counts.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Word-set containment, 0–1: the share of the SHORTER description's merchant words found in the other. Null when
 * either side has no merchant words at all (an SMS with no parsed merchant, a blank narration) — unknown, not zero.
 */
export function merchantSimilarity(a: string, b: string): number | null {
  const ta = merchantTokens(a);
  const tb = merchantTokens(b);
  if (ta.length === 0 || tb.length === 0) return null;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const hits = small.filter((s) => large.some((l) => tokensMatch(s, l))).length;
  return hits / small.length;
}

export function merchantStrength(score: number | null): MerchantStrength {
  if (score == null) return "unknown";
  if (score >= 0.999) return "same";
  if (score >= 0.5) return "similar";
  return "different";
}

/** Whether `reference` (letters/digits only, 4+ characters) appears in any of `texts`. */
export function containsReference(reference: string | null, ...texts: string[]): boolean {
  const ref = (reference ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (ref.length < 4) return false;
  return texts.some((t) => t.toUpperCase().replace(/[^A-Z0-9]/g, "").includes(ref));
}
