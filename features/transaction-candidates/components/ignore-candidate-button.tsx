"use client";

import { CircleX } from "lucide-react";
import type { MouseEvent } from "react";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";
import { formatCurrencyExact } from "@/lib/format";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ignoreCandidate } from "../lib/import-candidate";
import { DISMISS_UNDO_WINDOW_MS, scheduleDelayedDismiss, UNDO_TOAST_OPTIONS, undoToastAction } from "../lib/delayed-dismiss";

/**
 * After a dismissal the list reflows: the next row / card slides into the same spot, with ITS Dismiss button right under
 * the pointer. A double-click, or an impatient second click, would then dismiss a transaction the user never chose. So a
 * pointer click at (nearly) the same spot within this window after a dismissal is ignored. Keyboard activation
 * (`detail === 0`) is never blocked — focus doesn't move onto a reflowed button.
 */
const REFLOW_GUARD_MS = 700;
const REFLOW_GUARD_PX = 24;
let lastDismiss = { at: 0, x: 0, y: 0 };

/** "₹500 · 01 Aug" — names the exact candidate in the toast, so two dismissals from the same bank are told apart. */
export function dismissedCandidateLabel(candidate: SmsTransactionCandidate): string {
  const name = candidate.merchant ?? candidate.bankName ?? "Transaction";
  const day = candidate.transactionDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  return `${name} · ${formatCurrencyExact(candidate.amount)} · ${day}`;
}

export function IgnoreCandidateButton({
  candidate,
  candidateRepository,
  onHide,
  onUnhide,
  className,
}: {
  candidate: SmsTransactionCandidate;
  candidateRepository: SmsTransactionCandidateRepository;
  /** Hides this candidate from every list view right away, before the real delete runs. */
  onHide: (candidateId: string) => void;
  /** Restores visibility — called when the toast's Undo is clicked, or if the delayed delete itself fails. */
  onUnhide: (candidateId: string) => void;
  /** Sizing / border overrides (a 44px target on narrow rows, a compact one on wide rows and grid cards). */
  className?: string;
}) {
  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    // Never let a Dismiss click reach the row / card (whose empty-space click opens Review).
    e.stopPropagation();
    if (e.detail > 1) return; // the second click of a double-click
    if (e.detail === 1) {
      const now = Date.now();
      const samePlace = Math.abs(e.clientX - lastDismiss.x) <= REFLOW_GUARD_PX && Math.abs(e.clientY - lastDismiss.y) <= REFLOW_GUARD_PX;
      if (samePlace && now - lastDismiss.at < REFLOW_GUARD_MS) return;
      lastDismiss = { at: now, x: e.clientX, y: e.clientY };
    }

    const { cancel } = scheduleDelayedDismiss({
      candidateId: candidate.id,
      hide: onHide,
      unhide: onUnhide,
      commitDelete: async () => {
        const { tombstoneMismatched } = await ignoreCandidate(candidate, candidateRepository);
        if (tombstoneMismatched) {
          // Phase F2 (2026-10-24): a concurrent Import (another tab/device) already won this race —
          // the candidate is gone from the queue either way, but a real Transaction exists for it.
          // Never claim it was dismissed.
          toast.info(
            "Already imported elsewhere",
            `${candidate.merchant ?? candidate.bankName ?? "This transaction"} was imported in another tab or device while you were dismissing it — it wasn't dismissed.`,
          );
        }
      },
      onDeleteFailed: (error) => {
        toast.error("Couldn't dismiss this candidate", "Try again.");
        console.error("IgnoreCandidateButton: ignoreCandidate failed", error);
      },
    });

    toast.success("Candidate dismissed", `${dismissedCandidateLabel(candidate)} won't show in the review queue.`, undoToastAction(cancel), UNDO_TOAST_OPTIONS);
  }

  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            data-testid="candidate-dismiss"
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-[8px] px-3 text-sm font-medium text-foreground/85 transition-colors hover:bg-danger/10 hover:text-danger motion-reduce:transition-none",
              className,
            )}
          >
            <CircleX className="size-3.5 shrink-0" aria-hidden />
            Dismiss
            <span className="sr-only">
              {" "}
              {candidate.merchant ?? candidate.bankName ?? "candidate"} {formatCurrencyExact(candidate.amount)}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-[15rem] text-center leading-snug">
          Remove from your inbox without importing. You can undo for {Math.round(DISMISS_UNDO_WINDOW_MS / 1000)} seconds.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
