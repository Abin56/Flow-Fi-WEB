/**
 * Card-linked agreements: before a lender charge becomes a separate Loan/EMI liability, check whether the credit
 * card already carries it (as a card transaction or on a statement). A card is the canonical owner of its own
 * balance, so the same charge must never be both a card liability and a Loan/EMI liability.
 *
 * Evidence only ever RAISES a review. Finding nothing is never proof that a new liability is safe: either way the
 * user must confirm explicitly, and "already on the card" blocks the Loan/EMI charge entirely. Pure.
 */

import type { LenderChargeCardReview, LenderChargeType } from "@/lib/models/lender-charge";

export interface CardTransactionEvidence {
  id: string;
  accountId: string;
  type: "income" | "expense";
  amount: number;
  dateTime: Date;
  notes: string;
  merchant?: string | null;
  deletedAt: Date | null;
}

/** A line read from a card statement (Smart Capture / statement import), when one is available. */
export interface StatementLineEvidence {
  id: string;
  amount: number;
  date: Date;
  description: string;
}

export interface CardEvidenceCandidate {
  type: LenderChargeType;
  amount: number;
  billedDate: Date;
  lenderReference: string;
}

export type EvidenceStrength = "strong" | "weak";

export interface CardEvidenceMatch {
  source: "cardTransaction" | "statementLine";
  id: string;
  strength: EvidenceStrength;
  reasons: string[];
}

export type CardReviewVerdict = "possibleMatch" | "noEvidenceFound";

export interface CardRepresentationReview {
  verdict: CardReviewVerdict;
  matches: CardEvidenceMatch[];
  /** True whenever a match exists. */
  reviewRequired: boolean;
  /** Always true: even with no evidence the user must confirm. */
  confirmationRequired: true;
}

const DAY = 86_400_000;
const DATE_WINDOW_DAYS = 5;

const KEYWORDS: Record<LenderChargeType, RegExp> = {
  interest: /interest|finance\s*charge/i,
  penalty: /penalt|late\s*(fee|payment|charge)|bounce|dishonou?r/i,
  processingFee: /processing/i,
  serviceFee: /service|convenience|annual|foreclos/i,
  gst: /\b(gst|igst|cgst|sgst)\b/i,
  other: /charge|fee/i,
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function score(candidate: CardEvidenceCandidate, text: string, amount: number, date: Date): { strength: EvidenceStrength; reasons: string[] } | null {
  const reasons: string[] = [];
  const amountMatch = Math.abs(amount - candidate.amount) < 0.005;
  const dateMatch = Math.abs(date.getTime() - candidate.billedDate.getTime()) <= DATE_WINDOW_DAYS * DAY;
  const ref = squash(candidate.lenderReference);
  const refMatch = ref.length >= 4 && squash(text).includes(ref);
  const keywordMatch = KEYWORDS[candidate.type].test(text);
  if (amountMatch) reasons.push("same amount");
  if (dateMatch) reasons.push(`within ${DATE_WINDOW_DAYS} days of the billed date`);
  if (refMatch) reasons.push("carries the lender reference");
  if (keywordMatch) reasons.push("description reads like this charge type");
  if (!amountMatch && !refMatch) return null;
  const strong = (amountMatch && (dateMatch || refMatch)) || (refMatch && (dateMatch || keywordMatch));
  return { strength: strong ? "strong" : "weak", reasons };
}

export function reviewCardRepresentation(params: {
  candidate: CardEvidenceCandidate;
  /** Transactions on the linked card account(s). */
  cardTransactions: readonly CardTransactionEvidence[];
  statementLines?: readonly StatementLineEvidence[];
}): CardRepresentationReview {
  const { candidate } = params;
  const matches: CardEvidenceMatch[] = [];
  for (const t of params.cardTransactions) {
    if (t.deletedAt != null || t.type !== "expense") continue;
    const s = score(candidate, `${t.notes} ${t.merchant ?? ""}`, t.amount, t.dateTime);
    if (s) matches.push({ source: "cardTransaction", id: t.id, ...s });
  }
  for (const l of params.statementLines ?? []) {
    const s = score(candidate, l.description, l.amount, l.date);
    if (s) matches.push({ source: "statementLine", id: l.id, ...s });
  }
  matches.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "strong" ? -1 : 1));
  return { verdict: matches.length > 0 ? "possibleMatch" : "noEvidenceFound", matches, reviewRequired: matches.length > 0, confirmationRequired: true };
}

export interface CardChargeGate {
  allowed: boolean;
  reason: string | null;
}

/**
 * Whether a charge on a card-linked agreement may become a Loan/EMI liability.
 *  - No confirmation → blocked, always (absence of a match is not permission).
 *  - "alreadyOnCard" → blocked: the card already owns it.
 *  - "notOnCard" with matches → allowed only if the user reviewed EVERY match id.
 */
export function cardChargeGate(review: CardRepresentationReview, confirmation: LenderChargeCardReview | null): CardChargeGate {
  if (confirmation == null) return { allowed: false, reason: "Confirm whether this charge is already on the credit card before recording it." };
  if (confirmation.decision === "alreadyOnCard") return { allowed: false, reason: "This charge is already on the credit card, so it is not recorded again as a Loan/EMI liability." };
  const reviewed = new Set(confirmation.reviewedTransactionIds);
  const unreviewed = review.matches.filter((m) => !reviewed.has(m.id));
  if (unreviewed.length > 0) return { allowed: false, reason: `${unreviewed.length} possible match${unreviewed.length === 1 ? "" : "es"} on the card still need to be reviewed.` };
  return { allowed: true, reason: null };
}
