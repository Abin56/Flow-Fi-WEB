"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CommitReviewImportResult } from "../lib/commit-review-import";
import { groupBlockingReasonsByCode, ISSUE_GROUP_LABEL, ISSUE_GROUP_ORDER } from "../lib/issue-groups";

/** Surfaces the outcome of the last Approve & Import run (architecture §7) — blocked/failed rows
 *  grouped by issue type, so nothing fails silently. Renders nothing when the run was fully clean
 *  — see `ImportSuccessPanel` for that case. */
export function ValidationPanel({ result, onOpenRow }: { result: CommitReviewImportResult; onOpenRow: (recordId: string) => void }) {
  const [open, setOpen] = useState(true);
  const blocked = result.results.filter((r) => r.outcome === "blocked");
  const failed = result.results.filter((r) => r.outcome === "failed");
  const problems = blocked.length + failed.length;
  if (problems === 0) return null;

  const byCode = groupBlockingReasonsByCode(blocked.flatMap((r) => r.blockingReasons ?? []));

  return (
    <div className="rounded-xl border border-danger/30 bg-danger/5">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((v) => !v)}>
        <AlertTriangle className="size-4 shrink-0 text-danger" />
        <span className="text-sm font-semibold text-danger">
          {problems} row{problems === 1 ? "" : "s"} couldn&apos;t be imported — {result.committedCount} committed successfully
        </span>
        {open ? <ChevronUp className="ml-auto size-4 text-danger" /> : <ChevronDown className="ml-auto size-4 text-danger" />}
      </button>
      {open && (
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto border-t border-danger/20 px-3 py-3">
          {ISSUE_GROUP_ORDER.filter((code) => (byCode.get(code)?.length ?? 0) > 0).map((code) => {
            const ids = byCode.get(code) ?? [];
            return (
              <div key={code} className={cn("flex items-center justify-between rounded-lg px-2.5 py-2 text-xs bg-danger/10")}>
                <span className="font-medium text-foreground">
                  {ISSUE_GROUP_LABEL[code]} <span className="text-muted-foreground">· {ids.length} transaction{ids.length === 1 ? "" : "s"}</span>
                </span>
                <Button variant="ghost" size="xs" onClick={() => onOpenRow(ids[0])}>
                  Review
                </Button>
              </div>
            );
          })}
          {failed.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg bg-danger/10 px-2.5 py-2 text-xs">
              <span className="font-medium text-foreground">
                Import Errors <span className="text-muted-foreground">· {failed.length} transaction{failed.length === 1 ? "" : "s"}</span>
              </span>
              {failed.map((f) => (
                <button key={f.recordId} type="button" onClick={() => onOpenRow(f.recordId)} className="text-left text-muted-foreground hover:text-foreground">
                  {f.error ?? "Unknown error"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end px-3 py-2">
        <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
