"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RowStatusTone } from "@/features/transaction-studio/lib/row-status";
import { deriveCandidateStatus } from "../lib/candidate-status";
import type { CandidateDestinationState } from "../lib/candidate-account-matching";
import type { CandidateDuplicateResult } from "../lib/candidate-duplicate";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

/**
 * Text is ALWAYS the theme's foreground colour; meaning is carried by the dot, a tinted fill and an outline. The earlier
 * per-tone text colours (`text-warning-foreground`, `text-success`) measured 1.6:1 in dark and 3.2–3.4:1 in light, because
 * a tone-coloured text on a tone-tinted fill can't clear AA in both themes. Foreground on a light tint is >10:1 in both.
 */
const TONE_CHIP: Record<RowStatusTone, string> = {
  success: "border-success/50 bg-success/12",
  warning: "border-warning/60 bg-warning/20",
  danger: "border-danger/50 bg-danger/12",
  royal: "border-royal/50 bg-royal/12",
  purple: "border-purple/50 bg-purple/12",
  muted: "border-border bg-muted",
};

const DOT_CLASS: Record<RowStatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  royal: "bg-royal",
  purple: "bg-purple",
  muted: "bg-muted-foreground/50",
};

export function CandidateStatusBadge({
  candidate,
  duplicate,
  destinationState,
  compact = false,
  className,
}: {
  candidate: Pick<SmsTransactionCandidate, "needsReview" | "needsReviewReasons" | "confidenceLevel" | "accountId" | "cardId">;
  duplicate: CandidateDuplicateResult | null;
  /** Whether Android's account/card match still resolves — omit only where the accounts aren't loaded. */
  destinationState?: CandidateDestinationState;
  /** Badge only — omits the reason line underneath, for spots that already list the reasons elsewhere. */
  compact?: boolean;
  className?: string;
}) {
  const status = deriveCandidateStatus(candidate, duplicate, destinationState);
  const reasonText = status.reasons.join(" ");

  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <Badge
        className={cn(
          "h-auto max-w-full gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-tight font-semibold whitespace-nowrap text-foreground",
          status.dashed && "border-dashed",
          TONE_CHIP[status.tone],
        )}
        variant="outline"
        title={reasonText ? `${status.explanation} ${reasonText}` : status.explanation}
      >
        <span className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[status.tone])} aria-hidden />
        <span>{status.label}</span>
      </Badge>
      {reasonText && !compact && <span className="line-clamp-1 text-[11px] text-muted-foreground">{reasonText}</span>}
    </div>
  );
}
