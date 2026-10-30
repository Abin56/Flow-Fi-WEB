"use client";

/**
 * Pieces shared by the Inbox ledger rows and the bulk bar, so every place shows the same facts the same way: a signed exact
 * amount (the sign and the screen-reader label carry direction — colour is never the only cue), and independent
 * select / Review controls.
 */

import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CandidateDestinationState, MatchedIdentity } from "../lib/candidate-account-matching";
import type { CandidateDuplicateResult } from "../lib/candidate-duplicate";
import type { CandidateStatus } from "../lib/candidate-status";

/** Everything one row needs, computed once by the workspace so the list can't disagree with the counts. */
export interface CandidateRowModel {
  candidate: SmsTransactionCandidate;
  /** 1-based position in the visible list. */
  number: number;
  status: CandidateStatus;
  duplicate: CandidateDuplicateResult | null;
  destinationState: CandidateDestinationState;
  /** The matched account/card label, or null when Android's match doesn't resolve. */
  accountLabel: string | null;
  /** Bank + card/account name + masked last four for a VERIFIED match; null when unmatched/stale (never guessed). */
  identity: MatchedIdentity | null;
  /** Shown instead of a label when nothing resolves ("Not matched • •••• 7743"). */
  accountHint: string;
  /**
   * Saved accounts/cards whose last-4 equals the SMS's, for a row that is still unmatched — a SUGGESTION only (nothing is selected
   * or linked; Android matches on the phone only when it first builds the candidate and never re-matches). Null when there is none.
   */
  accountSuggestion?: string | null;
  selected: boolean;
  /** Why this row can't join a bulk selection (never silently — it is shown beside the row), or null when it can. */
  selectBlockedReason: string | null;
}

export const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** A visible checkbox outline in both themes (the stock one measured 2.0:1 light and 1.05:1 dark; non-text needs 3:1). */
export const CHECKBOX_CLASS = "border-foreground/60 bg-card data-[state=checked]:border-primary data-[state=indeterminate]:border-primary";

export function candidateTitle(c: Pick<SmsTransactionCandidate, "merchant" | "bankName">): string {
  return c.merchant ?? c.bankName ?? "Unknown";
}

/** `+₹1,250` for a credit, `−₹1,250` (a true minus sign) for a debit — the amount is always the exact stored value. */
export function signedAmountText(c: Pick<SmsTransactionCandidate, "amount" | "direction">): string {
  return `${c.direction === "credit" ? "+" : "−"}${formatCurrencyExact(c.amount)}`;
}

export function amountSummary(c: Pick<SmsTransactionCandidate, "amount" | "direction">): string {
  return signedAmountText(c);
}

/** One real, independent checkbox with a 44px hit area; a blocked row says why, in text, right beside it. */
export function RowCheckbox({ row, onToggle, className }: { row: CandidateRowModel; onToggle: (id: string, checked: boolean) => void; className?: string }) {
  const { candidate } = row;
  const blocked = row.selectBlockedReason != null && !row.selected;
  return (
    <label className={cn("flex size-11 shrink-0 cursor-pointer items-center justify-center", blocked && "cursor-not-allowed", className)}>
      <Checkbox
        className={CHECKBOX_CLASS}
        checked={row.selected}
        disabled={blocked}
        onCheckedChange={(checked) => onToggle(candidate.id, checked === true)}
        aria-label={`Select ${candidateTitle(candidate)}, ${amountSummary(candidate)}, ${candidate.transactionDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}`}
        title={blocked ? (row.selectBlockedReason ?? undefined) : undefined}
      />
    </label>
  );
}

export function ReviewButton({ candidate, onReview, className }: { candidate: SmsTransactionCandidate; onReview: (id: string) => void; className?: string }) {
  return (
    <button
      type="button"
      data-review-id={candidate.id}
      onClick={() => onReview(candidate.id)}
      className={cn(
        "inline-flex items-center justify-center rounded-[10px] border border-border-strong bg-card px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary motion-reduce:transition-none",
        FOCUS_RING,
        className,
      )}
    >
      Review
      <span className="sr-only">
        {" "}
        {candidateTitle(candidate)} {amountSummary(candidate)}
      </span>
    </button>
  );
}
