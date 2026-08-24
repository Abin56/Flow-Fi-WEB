"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CommitReviewImportResult } from "../lib/commit-review-import";

/** Shown when the last Approve & Import run had zero blocked/failed rows — `ValidationPanel`
 *  renders nothing in that case, which previously left a fully successful import with no
 *  confirmation at all. */
export function ImportSuccessPanel({ result, onDismiss }: { result: CommitReviewImportResult; onDismiss: () => void }) {
  const problems = result.blockedCount + result.failedCount;
  if (problems > 0) return null;

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-success/30 bg-success/5 px-4 py-5 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckCircle2 className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">Import Successful!</p>
      <p className="text-xs text-muted-foreground">
        {result.committedCount} of {result.results.length} transaction{result.results.length === 1 ? "" : "s"} imported successfully.
      </p>
      <div className="flex gap-2 pt-1">
        <Button asChild size="sm">
          <Link href="/transactions">View Transactions</Link>
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
