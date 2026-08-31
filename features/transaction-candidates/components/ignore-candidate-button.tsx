"use client";

import { EyeOff } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { toast } from "@/store/toast-store";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { ignoreCandidate } from "../lib/import-candidate";
import { scheduleDelayedDismiss } from "../lib/delayed-dismiss";

export function IgnoreCandidateButton({
  candidate,
  candidateRepository,
  onHide,
  onUnhide,
}: {
  candidate: SmsTransactionCandidate;
  candidateRepository: SmsTransactionCandidateRepository;
  /** Hides this candidate from every list view right away, before the real delete runs. */
  onHide: (candidateId: string) => void;
  /** Restores visibility — called when the toast's Undo is clicked, or if the delayed delete itself fails. */
  onUnhide: (candidateId: string) => void;
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
    <ClayButton variant="ghost" size="sm" onClick={handleClick} className="gap-1.5">
      <EyeOff className="size-3.5" />
      Dismiss
    </ClayButton>
  );
}
