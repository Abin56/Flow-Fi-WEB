"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import type { PreflightBlocker } from "../lib/commit-review-import";
import type { TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import type { GridRow } from "../lib/grid-types";
import { groupBlockingReasonsByCode } from "../lib/issue-groups";
import { preflightLowConfidenceIds, PreflightIssueGroups } from "./preflight-gate";
import { duplicateCandidateRows, DuplicateCandidateList } from "./duplicate-resolution-panel";
import { TransferMatchList, useTransferMatches } from "./transfer-matching-panel";

/**
 * A single compact "N rows need attention" strip replacing what used to be three separately
 * collapsible, differently-colored warning cards (preflight blockers, possible duplicates,
 * cross-account transfer matches) stacked above the grid. Collapsed by default — a reviewer sees
 * one line, not three; expanding reveals the same three sections (each still using its own
 * existing action logic — resolve/dismiss a duplicate, match & link a transfer, jump to a row from
 * an issue group) just grouped under one disclosure instead of three.
 *
 * "Rows need attention" counts distinct staged rows in *this* document (preflight blockers +
 * duplicate candidates + low-confidence rows, deduped by id) — transfer matches aren't counted
 * there since they're a cross-account opportunity, not a problem with one of this statement's
 * rows, but they still count toward "issues" and still show up once expanded.
 */
export function ValidationBar({
  blockers,
  rows,
  mutations,
  onOpenRow,
}: {
  blockers: PreflightBlocker[];
  rows: GridRow[];
  mutations: TransactionStudioMutations;
  onOpenRow: (recordId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const transferMatches = useTransferMatches();

  const lowConfidenceIds = preflightLowConfidenceIds(rows);
  const duplicates = duplicateCandidateRows(rows);

  const attentionRowIds = new Set<string>();
  blockers.forEach((b) => attentionRowIds.add(b.recordId));
  duplicates.forEach((r) => attentionRowIds.add(r.id));
  lowConfidenceIds.forEach((id) => attentionRowIds.add(id));

  const blockerIssueTypeCount = new Set(groupBlockingReasonsByCode(blockers.flatMap((b) => b.blockingReasons)).keys()).size;
  const issueTypeCount =
    blockerIssueTypeCount +
    (lowConfidenceIds.length > 0 ? 1 : 0) +
    (duplicates.length > 0 ? 1 : 0) +
    (transferMatches.visibleMatches.length > 0 ? 1 : 0);

  if (attentionRowIds.size === 0 && transferMatches.visibleMatches.length === 0) return null;

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((v) => !v)}>
        <AlertTriangle className="size-4 shrink-0 text-warning" />
        <span className="text-sm font-medium text-warning">
          {attentionRowIds.size > 0 && (
            <>
              {attentionRowIds.size} row{attentionRowIds.size === 1 ? "" : "s"} need attention
              {issueTypeCount > 0 && " · "}
            </>
          )}
          {issueTypeCount > 0 && `${issueTypeCount} issue${issueTypeCount === 1 ? "" : "s"}`}
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs font-medium text-warning">
          {open ? "Collapse" : "Review issues"}
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>
      {open && (
        <div className="flex max-h-72 flex-col gap-3 overflow-y-auto border-t border-warning/20 px-3 py-3">
          <PreflightIssueGroups blockers={blockers} rows={rows} onOpenRow={onOpenRow} />
          <DuplicateCandidateList rows={rows} mutations={mutations} onOpenRow={onOpenRow} />
          <TransferMatchList matches={transferMatches} />
        </div>
      )}
    </div>
  );
}
