/**
 * "Has something like this already been imported?" for the Transaction Inbox — a fuzzy, DISPLAY-ONLY layer that sits beside the
 * strict write-path gate (`candidate-duplicate.ts` → `checkForDuplicates`, which `importCandidate` re-runs before every write).
 *
 * The strict gate needs the candidate's text to appear inside an existing description and the amount to agree to the paisa, so
 * it misses the ordinary ways one purchase shows up twice: ₹200.08 on the statement vs ₹200 in the SMS, a card payment
 * posted a day later, "SWIGGY BANGALORE" vs "Swiggy". This module scores those too, and says plainly HOW sure it is:
 *
 *   exact    same amount (to the paisa), same calendar day, same merchant (or the reference number is found) — the
 *            reviewer almost certainly already imported this.
 *   possible anything weaker that still agrees on amount, date and merchant closely enough to be worth a look.
 *
 * It only describes. Nothing here imports, skips, merges or dismisses a candidate, and a "possible" match never blocks an
 * import — the reviewer decides. Pure and Firestore-free: it takes already-loaded transactions as plain data.
 */

import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";

export type PossibleMatchKind = "exact" | "possible";

export interface PossibleMatch {
  transactionId: string;
  kind: PossibleMatchKind;
  /** 0–1. Only for ordering; the reviewer sees `kind` and `reasons`, never a made-up percentage. */
  score: number;
  /** |candidate − existing|, in rupees (rounded to the paisa). */
  amountDiff: number;
  /** Whole calendar days apart (local time). */
  dayGap: number;
  /** 0–1 text similarity, or `null` when either side has no usable text. */
  descriptionSimilarity: number | null;
  /** `null` when the candidate's destination isn't known yet. */
  sameAccount: boolean | null;
  referenceConfirmed: boolean;
  /** Plain-language points for the reviewer, strongest first. Never contains an internal id. */
  reasons: string[];
}

export type MatchCandidateInput = Pick<SmsTransactionCandidate, "merchant" | "bankName" | "amount" | "transactionDate" | "referenceNumber" | "direction">;
export type MatchExistingInput = Pick<Transaction, "id" | "description" | "amount" | "dateTime" | "accountId" | "type">;

/** Bank posting lag + SMS-vs-statement timestamps: a real purchase rarely shows more than three days apart. */
export const MAX_DAY_GAP = 3;
/** Rounding-level amount differences always count (₹200.08 vs ₹200); anything larger is judged against max(₹1, 1%). */
const ROUNDING_TOLERANCE = 1;
const RELATIVE_TOLERANCE = 0.01;
const MIN_SCORE = 0.62;
const MIN_DESCRIPTION_SIMILARITY = 0.5;
const EXACT_DESCRIPTION_SIMILARITY = 0.8;
export const MAX_MATCHES_PER_CANDIDATE = 3;

const NOISE_TOKENS = new Set([
  "UPI", "POS", "IMPS", "NEFT", "RTGS", "ECOM", "TXN", "REF", "VPA", "PVT", "LTD", "LIMITED", "PRIVATE", "INDIA", "PAYMENT", "PAYMENTS", "PURCHASE", "DEBIT", "CREDIT", "CARD", "TO", "FROM", "THE", "AND", "OF", "AT", "BY",
]);

function tokensOf(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !NOISE_TOKENS.has(t) && !/^\d{6,}$/.test(t));
}

function bigrams(compact: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i += 1) {
    const g = compact.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** Two tokens are "the same word" when equal, or when one is a ≥4-letter prefix of the other ("SWIGGY" / "SWIGGYINSTAMART"). */
function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Text similarity 0–1 between two merchant/description strings, tolerant of case, punctuation, bank noise words ("UPI", "PVT LTD"),
 * reference-number runs and a one-sided extra suffix. `null` when either side has no usable text.
 */
export function descriptionSimilarity(a: string | null | undefined, b: string | null | undefined): number | null {
  const ta = tokensOf(a ?? "");
  const tb = tokensOf(b ?? "");
  if (ta.length === 0 || tb.length === 0) return null;
  const ca = ta.join("");
  const cb = tb.join("");
  if (ca === cb) return 1;
  if (Math.min(ca.length, cb.length) >= 3 && (ca.includes(cb) || cb.includes(ca))) return 0.92;
  let shared = 0;
  const used = new Set<number>();
  for (const x of ta) {
    const j = tb.findIndex((y, idx) => !used.has(idx) && tokensAlike(x, y));
    if (j >= 0) {
      used.add(j);
      shared += 1;
    }
  }
  const tokenDice = (2 * shared) / (ta.length + tb.length);
  return Math.max(tokenDice, bigramDice(ca, cb));
}

function cents(n: number): number {
  return Math.round(n * 100);
}

/** 1 = same to the paisa, 0.85 = under ₹1 apart, 0.7 = within max(₹1, 1%), 0 = too far apart to be the same purchase. */
function amountScore(candidate: number, existing: number): number {
  const diffCents = Math.abs(cents(candidate) - cents(existing));
  if (diffCents <= 1) return 1;
  const diff = diffCents / 100;
  if (diff < ROUNDING_TOLERANCE) return 0.85;
  const tolerance = Math.max(ROUNDING_TOLERANCE, Math.max(candidate, existing) * RELATIVE_TOLERANCE);
  return diff <= tolerance + 1e-9 ? 0.7 : 0;
}

const DATE_SCORES = [1, 0.85, 0.6, 0.4] as const;

/** Whole calendar days between two moments in local time — a 2:30 PM SMS and a midnight statement row of the same day are 0 apart. */
export function calendarDayGap(a: Date, b: Date): number {
  const dayNumber = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  return Math.abs(dayNumber(a) - dayNumber(b));
}

function directionMatchesType(direction: MatchCandidateInput["direction"], type: MatchExistingInput["type"]): boolean {
  return (direction === "credit") === (type === "income");
}

function formatRupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * Scores every already-saved transaction against one candidate and returns the closest few, exact matches first. `accountId` is the
 * destination the reviewer would post to (when known): a different account only weakens a match, it never hides it.
 */
export function findPossibleMatches(candidate: MatchCandidateInput, accountId: string | null, existing: readonly MatchExistingInput[]): PossibleMatch[] {
  const candidateText = candidate.merchant ?? candidate.bankName ?? "";
  const reference = candidate.referenceNumber?.trim().toUpperCase() ?? "";
  const matches: PossibleMatch[] = [];

  for (const t of existing) {
    if (!directionMatchesType(candidate.direction, t.type)) continue;
    const amountPart = amountScore(candidate.amount, t.amount);
    if (amountPart === 0) continue;
    const dayGap = calendarDayGap(candidate.transactionDate, t.dateTime);
    if (dayGap > MAX_DAY_GAP) continue;
    const datePart = DATE_SCORES[dayGap];

    const referenceConfirmed = reference.length >= 4 && t.description.toUpperCase().includes(reference);
    const similarity = referenceConfirmed ? Math.max(1, descriptionSimilarity(candidateText, t.description) ?? 0) : descriptionSimilarity(candidateText, t.description);
    // With no text on one side only a near-identical amount on (almost) the same day is worth showing, and never as "exact".
    if (similarity == null && !(amountPart >= 0.85 && dayGap <= 1)) continue;
    if (similarity != null && similarity < MIN_DESCRIPTION_SIMILARITY) continue;

    const sameAccount = accountId == null ? null : accountId === t.accountId;
    let score = 0.4 * amountPart + 0.3 * datePart + 0.3 * (similarity ?? 0.5);
    if (sameAccount === false) score *= 0.9;
    if (score < MIN_SCORE) continue;

    const exact = amountPart === 1 && dayGap === 0 && similarity != null && similarity >= EXACT_DESCRIPTION_SIMILARITY;
    const diff = Math.abs(cents(candidate.amount) - cents(t.amount)) / 100;

    const reasons: string[] = [];
    if (similarity != null) reasons.push(similarity >= EXACT_DESCRIPTION_SIMILARITY ? "Same merchant" : "Similar merchant name");
    reasons.push(dayGap === 0 ? "Same day" : `${dayGap} ${dayGap === 1 ? "day" : "days"} apart`);
    reasons.push(amountPart === 1 ? "Same amount" : `Amount differs by ${formatRupees(diff)}`);
    if (referenceConfirmed) reasons.unshift("Reference number found in its description");
    if (sameAccount === false) reasons.push("Different account");

    matches.push({ transactionId: t.id, kind: exact ? "exact" : "possible", score, amountDiff: diff, dayGap, descriptionSimilarity: similarity, sameAccount, referenceConfirmed, reasons });
  }

  matches.sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === "exact" ? -1 : 1));
  return matches.slice(0, MAX_MATCHES_PER_CANDIDATE);
}

/**
 * Folds the strict write-gate's single best match (`evaluateCandidateDuplicate`) into the fuzzy list. The gate also flags a
 * same-amount/same-day pair even when the description disagrees, which the fuzzy scoring rightly skips — it is added here as
 * a "possible" match so the row can show WHY it is flagged. Never adds a second entry for a transaction already listed.
 */
export function mergeGateMatch(
  matches: PossibleMatch[],
  gate: { duplicateOfTransactionId: string | null; confidence: number } | null,
  candidate: MatchCandidateInput,
  accountId: string | null,
  existingById: ReadonlyMap<string, MatchExistingInput>,
): PossibleMatch[] {
  if (!gate || gate.duplicateOfTransactionId == null) return matches;
  const id = gate.duplicateOfTransactionId;
  const known = matches.find((m) => m.transactionId === id);
  if (known) {
    // The gate rates same-description/amount/day at ≥ 0.9 — never leave that listed as merely "possible".
    if (known.kind === "possible" && gate.confidence >= 0.85) return sortMatches(matches.map((m) => (m === known ? { ...m, kind: "exact" as const } : m)));
    return matches;
  }
  const t = existingById.get(id);
  if (!t) return matches;
  const similarity = descriptionSimilarity(candidate.merchant ?? candidate.bankName ?? "", t.description);
  const diff = Math.abs(cents(candidate.amount) - cents(t.amount)) / 100;
  const dayGap = calendarDayGap(candidate.transactionDate, t.dateTime);
  const sameAccount = accountId == null ? null : accountId === t.accountId;
  const reasons = [dayGap === 0 ? "Same day" : `${dayGap} ${dayGap === 1 ? "day" : "days"} apart`, diff === 0 ? "Same amount" : `Amount differs by ${formatRupees(diff)}`];
  if (similarity == null || similarity < MIN_DESCRIPTION_SIMILARITY) reasons.splice(1, 0, "Description doesn't match");
  if (sameAccount === false) reasons.push("Different account");
  const entry: PossibleMatch = {
    transactionId: id,
    kind: gate.confidence >= 0.85 ? "exact" : "possible",
    score: gate.confidence,
    amountDiff: diff,
    dayGap,
    descriptionSimilarity: similarity,
    sameAccount,
    referenceConfirmed: false,
    reasons,
  };
  return sortMatches([...matches, entry]).slice(0, MAX_MATCHES_PER_CANDIDATE);
}

function sortMatches(matches: PossibleMatch[]): PossibleMatch[] {
  return [...matches].sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === "exact" ? -1 : 1));
}
