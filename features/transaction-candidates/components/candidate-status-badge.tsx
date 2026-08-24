"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RowStatusTone } from "@/features/transaction-studio/lib/row-status";
import { deriveCandidateStatus } from "../lib/candidate-status";
import type { CandidateDuplicateResult } from "../lib/candidate-duplicate";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";

/** Same tone→class mapping as Transaction Studio's `StatusCell` (`TONE_CLASS`/`DOT_CLASS`) — small,
 *  presentational, cheap to duplicate rather than importing a component from another feature folder. */
const TONE_CLASS: Record<RowStatusTone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  royal: "bg-royal/10 text-royal",
  purple: "bg-purple/10 text-purple",
  muted: "bg-muted text-muted-foreground",
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
}: {
  candidate: Pick<SmsTransactionCandidate, "needsReview" | "needsReviewReasons" | "confidenceLevel" | "accountId" | "cardId" | "rawLastFour" | "bankName">;
  duplicate: CandidateDuplicateResult | null;
}) {
  const status = deriveCandidateStatus(candidate, duplicate);
  const reasonText = status.reasons.join(" ");

  return (
    <div className="flex flex-col gap-0.5">
      <Badge
        className={cn(
          "min-w-0 max-w-full gap-1.5 border-0 px-2.5 py-1 text-[11px] font-medium",
          status.dashed && "outline outline-dashed outline-1 outline-current/40",
          TONE_CLASS[status.tone],
        )}
        variant="outline"
        title={reasonText || status.label}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[status.tone])} aria-hidden />
        <span className="truncate">{status.label}</span>
      </Badge>
      {reasonText && <span className="truncate text-[10px] text-muted-foreground">{reasonText}</span>}
    </div>
  );
}
