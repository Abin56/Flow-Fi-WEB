import type { RowStatusTone } from "@/features/transaction-studio/lib/row-status";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CandidateDestinationState } from "./candidate-account-matching";
import type { CandidateDuplicateResult } from "./candidate-duplicate";

/**
 * The single review lane a candidate belongs to — exactly one per candidate, in the same priority the status
 * badge uses, so lane counts always add up to the total and a row never sits in one lane while its badge says
 * another. (The old overlapping tabs — a candidate could be Needs Review AND Unmatched AND a Duplicate — are gone.)
 */
export type CandidateLane = "duplicate" | "needsAccount" | "needsReview" | "noIssues";

export interface CandidateStatus {
  /** Which review lane this candidate is in — the badge label and the lane filter derive from the same value. */
  lane: CandidateLane;
  label: string;
  tone: RowStatusTone;
  dashed?: boolean;
  /**
   * Human-readable "why" for any non-"No issues flagged" status. For the needs-review branch these are
   * Android's own `SmsConfidenceResult.reasons` (`needsReviewReasons`), shown verbatim — never re-derived or
   * second-guessed on the web side, matching `docs/sms-candidate-contract.md`'s "consumed as-given" rule.
   */
  reasons: string[];
  /**
   * One plain-language sentence about what this status means and what the reviewer still has to do. Web-authored
   * context (not Android's reasons): used as the tooltip / fallback when Android gave no specific reason.
   */
  explanation: string;
}

/**
 * The shared duplicate service's reason names the matching record by its internal id ("… as an existing transaction (txn_…)").
 * Ids mean nothing to a reviewer, so anything shown to them goes through this first. Dates and amounts in parentheses survive:
 * an id has letters, a date or amount does not.
 */
export function stripInternalIds(text: string): string {
  return text.replace(/\s*\((?=[^)]*[A-Za-z])[A-Za-z0-9_-]{8,}\)/g, "").replace(/\s{2,}/g, " ").trim();
}

type StatusInput = Pick<SmsTransactionCandidate, "needsReview" | "needsReviewReasons" | "confidenceLevel" | "accountId" | "cardId">;

/** Falls back to the ids alone when the caller can't check them against the user's accounts (tests, badge-only callers). */
function defaultDestinationState(candidate: Pick<SmsTransactionCandidate, "accountId" | "cardId">): CandidateDestinationState {
  return candidate.accountId != null || candidate.cardId != null ? "matched" : "unmatched";
}

/**
 * The single authoritative status function for `SmsTransactionCandidate` — used by `CandidateStatusBadge`, the
 * lane filter/counts and the table row tint, so they can never disagree.
 *
 * This collection has no persisted status field at all — existence of a document means "still pending" (see the
 * model's module doc), so every candidate this function sees is pending by construction.
 *
 * Priority order (first match wins):
 *   1. Possible duplicate of an existing committed Transaction — importing it would double-count.
 *   2. Account not matched — Android couldn't resolve an account/card, or the one it resolved no longer exists
 *      (`destinationState`). The reviewer must choose a destination.
 *   3. Needs review (Android's own `needsReview` flag) — "Needs Review" for low confidence, "Review Recommended"
 *      otherwise.
 *   4. No issues flagged. NOT "ready to import": a category is always still required.
 */
export function deriveCandidateStatus(
  candidate: StatusInput,
  duplicate: CandidateDuplicateResult | null,
  destinationState: CandidateDestinationState = defaultDestinationState(candidate),
): CandidateStatus {
  if (duplicate && duplicate.duplicateOfTransactionId != null) {
    return {
      lane: "duplicate",
      label: "Possible Duplicate",
      tone: "warning",
      dashed: true,
      reasons: [stripInternalIds(duplicate.reason)],
      explanation: "This looks like a transaction you already have. Compare it before importing.",
    };
  }

  if (destinationState !== "matched") {
    return {
      lane: "needsAccount",
      label: "Account not matched",
      tone: "danger",
      reasons: candidate.needsReviewReasons,
      explanation:
        destinationState === "missing"
          ? "Android matched an account or card that no longer exists. Choose the destination yourself."
          : "Android couldn't match this message to one of your accounts or cards. Choose the destination yourself.",
    };
  }

  if (candidate.needsReview) {
    const low = candidate.confidenceLevel === "low";
    return {
      lane: "needsReview",
      label: low ? "Needs Review" : "Review Recommended",
      tone: "warning",
      reasons: candidate.needsReviewReasons,
      explanation: low
        ? "Low confidence — check every field before importing."
        : "Android flagged this for a look but gave no specific problem — worth a quick check before importing.",
    };
  }

  return {
    lane: "noIssues",
    label: "No issues flagged",
    tone: "success",
    reasons: [],
    explanation: "Android found nothing to flag. You still choose the category before importing.",
  };
}

export function deriveCandidateLane(
  candidate: StatusInput,
  duplicate: CandidateDuplicateResult | null,
  destinationState?: CandidateDestinationState,
): CandidateLane {
  return deriveCandidateStatus(candidate, duplicate, destinationState).lane;
}
