"use client";

import { EyeOff } from "lucide-react";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";
import { formatCurrencyExact } from "@/lib/format";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { ignoreCandidate } from "../lib/import-candidate";
import { scheduleDelayedDismiss } from "../lib/delayed-dismiss";

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
  /** Sizing / border overrides (a 44px target on cards, a compact one in the table). */
  className?: string;
}) {
  function handleClick() {
    const { cancel } = scheduleDelayedDismiss({
      candidateId: candidate.id,
      hide: onHide,
      unhide: onUnhide,
      commitDelete: () => ignoreCandidate(candidate, candidateRepository),
      onDeleteFailed: (error) => {
        toast.error("Couldn't dismiss this candidate", "Try again.");
        console.error("IgnoreCandidateButton: ignoreCandidate failed", error);
      },
    });

    toast.success("Candidate dismissed", `${candidate.merchant ?? candidate.bankName ?? "Transaction"} won't show in the review queue.`, {
      label: "Undo",
      onClick: cancel,
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-[8px] px-3 text-sm font-medium text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground",
        className,
      )}
    >
      <EyeOff className="size-3.5" aria-hidden />
      Dismiss
      <span className="sr-only">
        {" "}
        {candidate.merchant ?? candidate.bankName ?? "candidate"} {formatCurrencyExact(candidate.amount)}
      </span>
    </button>
  );
}
