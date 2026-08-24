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
 * Amount+date fallback (SMS/PDF only, on top of everything above): even when
 * none of the anchored rules above fire — no description text to compare, a
 * completely different merchant, a different account, even a different
 * direction (debit vs credit) — an EXACT amount match (within the same
 * epsilon) on the EXACT same calendar day is, by itself, still treated as
 * worth a warning, for `source: "sms"` and `source: "pdf"` candidates. This
 * is deliberately a strict product requirement, not a byproduct of the
 * anchored logic: a same-amount, same-day coincidence is common enough to be
 * worth a human's confirmation even with zero other corroborating signal,
 * and SMS/PDF candidates frequently arrive with no parsed merchant text at
 * all (see `checkCandidateForDuplicates` in
 * `features/transaction-candidates/lib/import-candidate.ts` and
 * `detectFreshDuplicatesForCommit` in
 * `features/transaction-studio/lib/commit-review-import.ts` for the two
 * places this matters most — the credit-card PDF review flow shares the
 * latter, so it inherits this for free). It never widens the ±1-day
 * near-duplicate window or the amount epsilon — "exact date" here really
 * does mean `dayGap === 0` — and it only adds a match for a transaction the
 * anchored pass above didn't already catch, so the anchored pass's stronger,
 * more-specific confidence and reason always win when both apply.
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
}

export interface ExistingTransactionForDuplicateCheck {
  id: string;
  description: string;
  amount: number;
  dateTime: Date;
  accountId: string;
  type: "income" | "expense";
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

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000)));
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
 * On top of all of the above, an unconditional amount+date-only fallback
 * (this module's doc comment, "Amount+date fallback") always runs last and
 * adds any exact-amount/exact-same-day existing transaction the anchored
 * pass above didn't already catch, at `AMOUNT_DATE_FALLBACK_CONFIDENCE` —
 * regardless of description, account, reference number, or even direction.
 */
export function checkForDuplicates(candidate: DuplicateCandidateInput, existingTransactions: ExistingTransactionForDuplicateCheck[]): DuplicateDetectionResult {
  const requireDescriptionMatch = candidate.requireDescriptionMatch ?? true;
  const candidateText = normalizeText(candidate.description);

  const matches: DuplicateMatch[] = [];

  // Anchored matching (unchanged from before the amount+date fallback below existed) — skipped
  // entirely when there's no description text to compare against and one is required, since
  // `"".includes(...)` would otherwise trivially "match" every existing transaction's description.
  if (!requireDescriptionMatch || candidateText.length > 0) {
    const sameDirectionAndAmount = existingTransactions.filter(
      (existing) =>
        directionMatchesType(candidate.direction, existing.type) &&
        amountsMatch(existing.amount, candidate.amount) &&
        (!requireDescriptionMatch || normalizeText(existing.description).includes(candidateText)),
    );

    const maxDayGap = requireDescriptionMatch ? NEAR_DUPLICATE_MAX_DAY_GAP : 0;
    /** Leading clause for each match's `reason` text — folds in the description when it was part of the match, omits it when matching was description-independent (manual entry). */
    const describedAs = requireDescriptionMatch ? `description ("${candidateText}"), amount` : "amount";

    for (const existing of sameDirectionAndAmount) {
      const dayGap = daysBetween(existing.dateTime, candidate.date);
      if (dayGap > maxDayGap) continue;

      const sameAccount = candidate.accountId == null || candidate.accountId === existing.accountId;
      const accountFactor = sameAccount ? 1 : DIFFERENT_ACCOUNT_CONFIDENCE_FACTOR;
      const accountNote = sameAccount ? "" : " (a different account, so this is a weaker signal)";

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
        const referenceConfirmed = normalizeText(existing.description).includes(normalizeText(candidate.referenceNumber));
        matches.push({
          transactionId: existing.id,
          confidence: (referenceConfirmed ? 0.98 : 0.75) * accountFactor,
          sameAccount,
          dayGap,
          reason: referenceConfirmed
            ? `Same ${describedAs}, and date as an existing transaction (${existing.id}), and its reference number ("${candidate.referenceNumber}") was found in that record's description — strong match${accountNote}.`
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
    }
  }

  // Amount+date fallback — see this module's doc comment. Runs for `source: "sms"`/`"pdf"` only
  // (never `"manual"`, which keeps its own existing direction-required rule), regardless of
  // `requireDescriptionMatch`, direction, account, or reference number, and regardless of whether
  // the anchored pass above found anything. Only adds a match for a transaction not already matched
  // above, so the anchored pass's stronger, more-specific confidence/reason always takes priority.
  if (candidate.source !== "manual") {
    const matchedIds = new Set(matches.map((m) => m.transactionId));
    for (const existing of existingTransactions) {
      if (matchedIds.has(existing.id)) continue;
      if (!amountsMatch(existing.amount, candidate.amount)) continue;
      if (daysBetween(existing.dateTime, candidate.date) !== 0) continue;

      const sameAccount = candidate.accountId == null || candidate.accountId === existing.accountId;
      const accountFactor = sameAccount ? 1 : DIFFERENT_ACCOUNT_CONFIDENCE_FACTOR;
      const accountNote = sameAccount ? "" : " (a different account, so this is a weaker signal)";
      matches.push({
        transactionId: existing.id,
        confidence: AMOUNT_DATE_FALLBACK_CONFIDENCE * accountFactor,
        sameAccount,
        dayGap: 0,
        reason: `Same amount (${candidate.amount}) and exact date (${dayKey(candidate.date)}) as an existing transaction (${existing.id}), even though description, account, and/or direction don't confirm it — flagged anyway since amount and date alone are treated as a strong enough signal to warrant review${accountNote}.`,
      });
    }
  }

  if (matches.length === 0) return NO_DUPLICATES;

  matches.sort((a, b) => b.confidence - a.confidence);
  return { status: "duplicate_candidate", bestMatch: matches[0]!, matches };
}
