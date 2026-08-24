"use client";

/**
 * Non-invasive entry point from Transaction Studio into the separate SMS
 * Transaction Candidates review queue (`/transaction-candidates`,
 * `features/transaction-candidates/`). Per ADR-009 that queue is a
 * deliberately parallel feature, not a tab in this grid — this link is the
 * only integration point, and it's purely additive: no `StudioHeader` prop
 * change, no shared state, no effect on the statement-import commit path.
 */

import { MessageSquareText } from "lucide-react";
import Link from "next/link";
import { useSmsTransactionCandidates } from "@/hooks/use-sms-transaction-candidates";

export function SmsCandidatesLink() {
  // Every document in this collection is pending by construction — see
  // lib/models/sms-transaction-candidate.ts's module doc. No status filter needed.
  const { data: candidates = [] } = useSmsTransactionCandidates();
  const pendingCount = candidates.length;

  if (pendingCount === 0) return null;

  return (
    <Link
      href="/transaction-candidates"
      className="surface-primary flex shrink-0 items-center gap-2 rounded-2xl px-3 py-2 text-xs font-medium text-foreground transition-colors hover:text-primary"
    >
      <MessageSquareText className="size-4 text-primary" />
      {pendingCount} SMS candidate{pendingCount === 1 ? "" : "s"} pending review
    </Link>
  );
}
