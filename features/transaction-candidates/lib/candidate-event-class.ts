/**
 * What Android's `SmsCandidateVerifier` decided a message describes (`eventClass`, classification v1), and what the web
 * may do with it. The single home for these rules: the status lane (`candidate-status.ts`), the single import guard
 * (`import-candidate.ts`) and bulk eligibility (`bulk-selection.ts`) all read them, so they can never disagree.
 *
 * Mirrors `sms_event_class.dart` — `movesMoney` and `isRoutine` there are `MONEY_MOVING` and `ROUTINE` here.
 *
 * A candidate uploaded before these fields existed has `eventClass == null` ("legacy") and keeps exactly the behaviour
 * it had before; Android refreshes such documents on its next sync.
 */

import type { SmsCandidateEventClass, SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

type IntegrityFields = Pick<SmsTransactionCandidate, "eventClass" | "moneyMovement" | "directionEvidence">;

/** Money actually moved — the only classes that may ever change a balance. */
const MONEY_MOVING: ReadonlySet<SmsCandidateEventClass> = new Set([
  "actualCredit",
  "actualDebit",
  "creditCardPurchase",
  "creditCardRefund",
  "cardBillPayment",
  "emiDebited",
  "reversal",
]);

/** Money-moving AND needing no extra look on its own account (refunds, reversals and card bill payments always do). */
const ROUTINE: ReadonlySet<SmsCandidateEventClass> = new Set(["actualCredit", "actualDebit", "creditCardPurchase", "emiDebited"]);

const LABELS: Record<SmsCandidateEventClass, string> = {
  actualCredit: "Money received",
  actualDebit: "Money spent",
  scheduledCredit: "Scheduled credit",
  scheduledDebit: "Scheduled / due payment",
  creditCardPurchase: "Credit card purchase",
  creditCardRefund: "Credit card refund",
  cardBillPayment: "Card bill payment",
  emiReminder: "EMI reminder",
  emiDebited: "EMI paid",
  failedTransaction: "Failed payment",
  pendingTransaction: "Pending payment",
  reversal: "Reversal",
  balanceAlert: "Balance alert",
  thirdPartyEvent: "Not your account",
  informational: "Information only",
  unknown: "Unclear message",
};

/** Why a non-money-moving class can never be imported — shown to the reviewer as-is. */
const BLOCK_REASONS: Partial<Record<SmsCandidateEventClass, string>> = {
  scheduledCredit: "This is a scheduled credit — the money hasn't arrived yet, so there is nothing to import.",
  scheduledDebit: "This is a reminder or scheduled payment — no money has moved yet, so there is nothing to import.",
  emiReminder: "This is an EMI reminder, not a payment — there is nothing to import.",
  failedTransaction: "This payment failed — no money moved, so there is nothing to import.",
  pendingTransaction: "This payment is still pending — import it once the bank confirms it went through.",
  balanceAlert: "This is a balance or limit alert, not a transaction.",
  thirdPartyEvent: "This message is about someone else's account or a request — not your transaction.",
  informational: "This message is informational — no money moved.",
  unknown: "The phone couldn't confirm that money moved, or in which direction. Review it on your phone, or dismiss it.",
};

const REVIEW_REASONS: Partial<Record<SmsCandidateEventClass, string>> = {
  creditCardRefund: "Credit card refund — check it against the original purchase before importing.",
  cardBillPayment: "Card bill payment — a transfer between your own accounts. Make sure it isn't counted twice.",
  reversal: "Reversal — check it against the original transaction before importing.",
};

export function eventClassLabel(eventClass: SmsCandidateEventClass): string {
  return LABELS[eventClass] ?? LABELS.unknown;
}

/**
 * Why this candidate may NOT be imported at all, or `null` when it may. Only Android's own verdict can block: a legacy
 * document (no `eventClass`) is never blocked here. `moneyMovement === false` blocks even if the class were somehow
 * money-moving — the stricter reading wins.
 */
export function candidateImportBlockReason(candidate: IntegrityFields): string | null {
  const { eventClass } = candidate;
  if (eventClass == null) return null;
  if (!MONEY_MOVING.has(eventClass)) return BLOCK_REASONS[eventClass] ?? BLOCK_REASONS.unknown!;
  if (candidate.moneyMovement === false) return BLOCK_REASONS.unknown!;
  return null;
}

/**
 * Why an importable candidate still needs individual review (never bulk, never "No issues flagged"), or `null`.
 * Legacy documents → `null` (unchanged behaviour).
 */
export function candidateIntegrityReviewReason(candidate: IntegrityFields): string | null {
  const { eventClass } = candidate;
  if (eventClass == null || candidateImportBlockReason(candidate) != null) return null;
  if (!ROUTINE.has(eventClass)) return REVIEW_REASONS[eventClass] ?? "Check this transaction before importing.";
  if (candidate.directionEvidence !== "contextual") {
    return "The message doesn't say whose account moved — confirm the debit/credit before importing.";
  }
  return null;
}

/** Passes every integrity check the web can see (legacy documents pass, as before). Account ownership is checked separately, live. */
export function candidatePassesIntegrity(candidate: IntegrityFields): boolean {
  return candidateImportBlockReason(candidate) == null && candidateIntegrityReviewReason(candidate) == null;
}
