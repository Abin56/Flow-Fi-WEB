/**
 * Shared, client-side Duplicate Detection service — the single place that
 * decides "does this incoming transaction look like one we already have."
 * Used by all three places a `Transaction` can be created on the web app:
 * SMS candidate import (`features/transaction-candidates/lib/candidate-duplicate.ts`),
 * PDF Transaction Studio's final commit (`features/transaction-studio/lib/commit-review-import.ts`),
 * and manual entry (`features/transactions/components/transaction-details-modal.tsx`).
 *
 * Pure and Firestore-free — takes already-loaded existing transactions as
 * plain data, so it's trivially unit-testable and has no opinion on where
 * its input came from. Never deletes, merges, or auto-rejects anything; it
 * only classifies. Callers decide what to do with the result (typically:
 * show a warning dialog the user can dismiss or proceed past).
 *
 * Matching rule (deliberately the same one already proven out in
 * `functions/src/duplicate/duplicate-detector.ts`'s `checkTransactionDuplicate`
 * for PDF statement rows, and `features/transaction-candidates/lib/candidate-duplicate.ts`'s
 * `evaluateCandidateDuplicate` for SMS candidates — this module replaces the
 * latter's re-implementation with one shared home, see ADR-009 §6 for why
 * they were separate before): normalized description/merchant text must be
 * found within the existing transaction's free-text `description` (the real
 * `Transaction` model has no structured merchant field — ADR-007), amount
 * must match within a small epsilon, and the date must be exact or within a
 * 1-day window. Reference number, when available, adjusts confidence up or
 * down but is never a hard requirement (most sources don't have one).
 *
 * Account awareness (new): unlike the two prior implementations, this
 * service also takes the candidate's resolved `accountId`. Two transactions
 * with the same amount and date but posted to *different* accounts are a
 * plausible, everyday coincidence (rent from account A, a similar-sized
 * transfer into account B), not a duplicate — so a same-account match is
 * scored higher than a cross-account one, rather than the two being treated
 * identically.
 *
 * Amount+date fallback (SMS/PDF only): an exact same-day amount is enough to
 * warn about ordinary imports, including rows without parsed merchant text.
 * Loan/EMI and People movements regularly share the same day and amount.
 * A match involving one of these also needs the same direction and a
 * matching description or bank reference.
 *
 * Deliberately excludes `source: "manual"`: manual entry already has its own
 * unconditional amount+direction+exact-date rule via
 * `requireDescriptionMatch: false` (see that field's doc below), which
 * *does* still require direction to agree — a manually re-keyed ₹500 expense
 * should not warn against an unrelated ₹500 refund received the same day.
 * Loosening that further wasn't asked for and would change manual entry's
 * existing, already-shipped behavior.
 *
 * Extensibility: adding a new import source means writing a small adapter
 * that maps that source's shape into `DuplicateCandidateInput` and
 * `ExistingTransactionForDuplicateCheck` — see `candidate-duplicate.ts`
 * (SMS) and `detectFreshDuplicatesForCommit` (PDF) for the two existing
 * adapters — the matching core itself never needs to change.
 */

import { isLoanOrPeopleTransaction, type LoanOrPeopleTransactionFields } from "@/lib/models/transaction";

const NEAR_DUPLICATE_MAX_DAY_GAP = 1;
const AMOUNT_EPSILON = 0.01;

/** Confidence multiplier applied when the only otherwise-matching existing transaction is on a different account. Keeps cross-account coincidences visibly weaker than same-account matches without hiding them outright. */
const DIFFERENT_ACCOUNT_CONFIDENCE_FACTOR = 0.5;

/** Base confidence for the amount+date-only fallback below every anchored tier (weakest anchored tier is `0.6 * DIFFERENT_ACCOUNT_CONFIDENCE_FACTOR` = 0.3) — reflects that this fallback has zero corroborating signal beyond amount and date, not even direction. Still always `duplicate_candidate`, never silently dropped. */
const AMOUNT_DATE_FALLBACK_CONFIDENCE = 0.25;

export type DuplicateDetectionSource = "sms" | "pdf" | "manual";

export interface DuplicateCandidateInput {
  /** Free-text description or merchant name for the incoming transaction — compared against existing transactions' `description`. Ignored when `requireDescriptionMatch` is `false`. */
  description: string;
  amount: number;
  date: Date;
  /** "expense"/"debit" vs "income"/"credit" — same-direction is required for a match (a ₹500 expense should never be flagged against a ₹500 refund). */
  direction: "debit" | "credit";
  /** Resolved account this transaction would post to, when known. `null` skips account-awareness (treated as "unknown," never boosts or penalizes). */
  accountId: string | null;
  /** Bank/UPI/statement reference number, when available. */
  referenceNumber: string | null;
  source: DuplicateDetectionSource;
  /** The reviewer explicitly classified the incoming row as a loan or installment movement. */
  isDebtMovement?: boolean;
  /**
   * SMS/PDF imports don't carry a reliable per-transaction identity beyond merchant text,
   * so they default (`true`) to requiring the candidate's description to be found within the
   * existing transaction's description, in addition to amount/date/direction — without it,
   * two unrelated same-day, same-amount transactions would false-positive constantly.
   *
   * Manual entry has no such ambiguity: the user is re-keying one specific transaction, and
   * requiring description text to match defeats the point of the warning (a genuine accidental
   * duplicate is often typed slightly differently the second time — "Coffee" vs "Blue Tokai
   * Coffee"). Pass `false` here to match on direction/amount/date alone; this also switches the
   * date comparison from the ±1-day near-duplicate window to an exact same-day match only, since
   * "flag it" without a description anchor should mean "same transaction, same day," not "some
   * transaction within a day of it."
   */
  requireDescriptionMatch?: boolean;
  /**
   * Existing transactions on these accounts are never treated as duplicates of this candidate — e.g.
   * a credit-card bill payment's source leg vs the very card purchases it is paying off (same amount,
   * same day, but the other side of a different financial event).
   */
  ignoreAccountIds?: string[];
}

export interface ExistingTransactionForDuplicateCheck extends LoanOrPeopleTransactionFields {
  id: string;
  description: string;
  amount: number;
  dateTime: Date;
  accountId: string;
  type: "income" | "expense";
  notes?: string;
  /** Set when the existing side represents a pending import row. */
  isDebtMovement?: boolean;
}

export type DuplicateDetectionStatus = "unique" | "duplicate_candidate";

export interface DuplicateMatch {
  transactionId: string;
  confidence: number;
  sameAccount: boolean;
  dayGap: number;
  reason: string;
}

export interface DuplicateDetectionResult {
  status: DuplicateDetectionStatus;
  /** Highest-confidence match, or null when `status` is "unique". Convenience accessor — same object as `matches[0]`. */
  bestMatch: DuplicateMatch | null;
  /** All matching existing transactions, highest confidence first. Never mutated, never used to auto-resolve anything. */
  matches: DuplicateMatch[];
}

const NO_DUPLICATES: DuplicateDetectionResult = { status: "unique", bestMatch: null, matches: [] };

function normalizeText(str: string): string {
  return str.trim().toUpperCase();
}

function amountsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_EPSILON;
}

/** Local calendar day (`YYYY-MM-DD`) — the day a person sees, not the UTC day. */
function dayKey(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/**
 * Whole CALENDAR days between two moments (local time), not elapsed hours rounded: a 2:30 PM SMS and a midnight
 * statement row for the same day are 0 days apart, and 11 PM vs 1 AM the next day are 1 day apart. Rounding the
 * millisecond difference got both wrong, which made the "exact same day" fallback miss same-day pairs whose
 * timestamps differ by 12+ hours.
 */
function daysBetween(a: Date, b: Date): number {
  const dayNumber = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (24 * 60 * 60 * 1000);
  return Math.abs(dayNumber(a) - dayNumber(b));
}

function directionMatchesType(direction: DuplicateCandidateInput["direction"], type: "income" | "expense"): boolean {
  return (direction === "credit") === (type === "income");
}

/**
 * Checks one incoming transaction against the user's already-loaded
 * existing transactions. Confidence tiers (before any account adjustment):
 *  - 0.98: same description/amount/date, reference number confirmed via substring match against the existing description
 *  - 0.9:  same description/amount/date, no reference number to check
 *  - 0.75: same description/amount/date, reference number present but not confirmed
 *  - 0.6:  same description/amount, date differs by up to 1 day (near duplicate) — only reachable when `requireDescriptionMatch` is true; see below
 * A different-account match is scored at `DIFFERENT_ACCOUNT_CONFIDENCE_FACTOR`
 * of these values — still surfaced (never silently dropped), just clearly weaker
 * (e.g. 0.98 same-account confirmed-reference becomes 0.49 cross-account).
 *
 * When `candidate.requireDescriptionMatch` is `false` (manual entry — see the
 * field doc on `DuplicateCandidateInput`), description text plays no part in
 * finding candidates, and the date must match exactly (dayGap === 0); the 0.6
 * near-duplicate tier never fires since there's no description anchor to make
 * a same-amount-different-day coincidence meaningful.
 *
 * SMS and PDF imports also warn about exact-amount, same-day ordinary rows
 * with no supporting evidence.
 */
export function checkForDuplicates(candidate: DuplicateCandidateInput, allExistingTransactions: ExistingTransactionForDuplicateCheck[]): DuplicateDetectionResult {
  const ignored = candidate.ignoreAccountIds;
  const existingTransactions = ignored?.length ? allExistingTransactions.filter((t) => !ignored.includes(t.accountId)) : allExistingTransactions;
  const requireDescriptionMatch = candidate.requireDescriptionMatch ?? true;
  const candidateText = normalizeText(candidate.description);
  const reference = normalizeText(candidate.referenceNumber ?? "");
  const maxDayGap = requireDescriptionMatch ? NEAR_DUPLICATE_MAX_DAY_GAP : 0;
  const importing = candidate.source !== "manual";

  const matches: DuplicateMatch[] = [];

  for (const existing of existingTransactions) {
    if (!amountsMatch(existing.amount, candidate.amount)) continue;
    const dayGap = daysBetween(existing.dateTime, candidate.date);
    if (dayGap > maxDayGap) continue;

    const debtRelated = importing && (candidate.isDebtMovement === true || existing.isDebtMovement === true || isLoanOrPeopleTransaction(existing));
    const existingText = normalizeText(existing.description);
    const descriptionMatches = candidateText.length > 0 && existingText.includes(candidateText);
    const referenceConfirmed = (reference.length > 0 && existingText.includes(reference)) ||
      (debtRelated && reference.length >= 4 && normalizeText(existing.notes ?? "").includes(reference));
    const anchored = directionMatchesType(candidate.direction, existing.type) &&
      (debtRelated ? descriptionMatches || (reference.length >= 4 && referenceConfirmed) : !requireDescriptionMatch || descriptionMatches);
    if (!anchored && (!importing || debtRelated || dayGap !== 0)) continue;

    const sameAccount = candidate.accountId == null || candidate.accountId === existing.accountId;
    const accountFactor = sameAccount ? 1 : DIFFERENT_ACCOUNT_CONFIDENCE_FACTOR;
    const accountNote = sameAccount ? "" : " (a different account, so this is a weaker signal)";

    if (anchored) {
      const describedAs = requireDescriptionMatch && descriptionMatches ? `description ("${candidateText}"), amount` : "amount";

      if (dayGap === 0) {
        if (candidate.referenceNumber == null) {
          matches.push({
            transactionId: existing.id,
            confidence: 0.9 * accountFactor,
            sameAccount,
            dayGap,
            reason: `Same ${describedAs} (${candidate.amount}), and date (${dayKey(candidate.date)}) as an existing transaction (${existing.id})${accountNote}. No reference number to further confirm.`,
          });
          continue;
        }
        matches.push({
          transactionId: existing.id,
          confidence: (referenceConfirmed ? 0.98 : 0.75) * accountFactor,
          sameAccount,
          dayGap,
          reason: referenceConfirmed
            ? `Same ${describedAs}, and date as an existing transaction (${existing.id}), and its reference number ("${candidate.referenceNumber}") was found in that record — strong match${accountNote}.`
            : `Same ${describedAs}, and date as an existing transaction (${existing.id}), but its reference number could not be confirmed against that record's description${accountNote}.`,
        });
        continue;
      }

      matches.push({
        transactionId: existing.id,
        confidence: 0.6 * accountFactor,
        sameAccount,
        dayGap,
        reason: `Same ${describedAs} (${candidate.amount}) as an existing transaction (${existing.id}), but the date differs by ${dayGap} day(s) — a near match, not confirmed as identical${accountNote}.`,
      });
      continue;
    }

    matches.push({
      transactionId: existing.id,
      confidence: AMOUNT_DATE_FALLBACK_CONFIDENCE * accountFactor,
      sameAccount,
      dayGap: 0,
      reason: `Same amount (${candidate.amount}) and exact date (${dayKey(candidate.date)}) as an existing transaction (${existing.id}), even though description, account, and/or direction don't confirm it — flagged anyway since amount and date alone are treated as a strong enough signal to warrant review${accountNote}.`,
    });
  }

  if (matches.length === 0) return NO_DUPLICATES;

  matches.sort((a, b) => b.confidence - a.confidence);
  return { status: "duplicate_candidate", bestMatch: matches[0]!, matches };
}
