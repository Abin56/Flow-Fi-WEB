"use client";

import { useState } from "react";
import { EyeOff } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { toast } from "@/store/toast-store";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { ignoreCandidate } from "../lib/import-candidate";

export function IgnoreCandidateButton({
  candidate,
  candidateRepository,
}: {
  candidate: SmsTransactionCandidate;
  candidateRepository: SmsTransactionCandidateRepository;
}) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await ignoreCandidate(candidate, candidateRepository);
    } catch (error) {
      toast.error("Couldn't dismiss this candidate", "Try again.");
      console.error("IgnoreCandidateButton: ignoreCandidate failed", error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ClayButton variant="ghost" size="sm" onClick={handleClick} disabled={loading} className="gap-1.5">
      <EyeOff className="size-3.5" />
      Dismiss
    </ClayButton>
  );
}
