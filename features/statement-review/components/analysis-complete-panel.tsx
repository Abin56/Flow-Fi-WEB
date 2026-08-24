"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FinancialDocumentStatus } from "@/lib/models/financial-document";
import type { DocumentAnalysisStats } from "@/features/statement-review/lib/summary";

interface AnalysisCompletePanelProps {
  documentId: string;
  status: FinancialDocumentStatus | undefined;
  stats: DocumentAnalysisStats;
  isDone: boolean;
  onDismiss: () => void;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-border/50 bg-card p-4 text-center">
      <div className="flex items-center gap-2 self-start">
        <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
          3
        </span>
        <h3 className="text-sm font-semibold text-foreground">Analysis Complete</h3>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-muted/50 px-2 py-2">
      <p className="text-base font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

/** The real terminal outcomes only — `docs/state-machine.md`'s status union, nothing invented. */
export function AnalysisCompletePanel({ documentId, status, stats, isDone, onDismiss }: AnalysisCompletePanelProps) {
  if (!isDone) {
    return (
      <Shell>
        <p className="w-full py-6 text-xs text-muted-foreground">Waiting for processing to finish…</p>
      </Shell>
    );
  }

  if (status === "awaiting_password") {
    return (
      <Shell>
        <div className="flex size-14 items-center justify-center rounded-full bg-warning/15 text-warning-foreground">
          <Lock className="size-6" />
        </div>
        <p className="text-sm font-semibold text-foreground">Password required</p>
        <p className="text-xs text-muted-foreground">Enter this statement&apos;s password from the card below to continue.</p>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Got it
        </Button>
      </Shell>
    );
  }

  if (status === "failed") {
    return (
      <Shell>
        <div className="flex size-14 items-center justify-center rounded-full bg-expense/12 text-expense">
          <AlertTriangle className="size-6" />
        </div>
        <p className="text-sm font-semibold text-foreground">Analysis failed</p>
        <p className="text-xs text-muted-foreground">This file couldn&apos;t be processed. Check the card below for details.</p>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      </Shell>
    );
  }

  // status is "parsed" or "needs_review" — the only remaining terminal outcomes reached from here.
  return (
    <Shell>
      <div className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckCircle2 className="size-7" />
      </div>
      <p className="text-sm font-semibold text-foreground">Analysis Complete!</p>
      <p className="text-xs text-muted-foreground">We found {stats.transactions} transactions in your statement.</p>

      <div className="grid w-full grid-cols-2 gap-2">
        <Stat label="Transactions" value={stats.transactions} />
        <Stat label="Duplicates" value={stats.duplicates} />
        <Stat label="Possible Transfers" value={stats.possibleTransfers} />
        <Stat label="Low Confidence" value={stats.lowConfidence} />
      </div>

      <div className="flex w-full flex-col gap-2">
        <Button asChild size="sm" className="w-full">
          <Link href={`/statement-review/${documentId}`}>Review Transactions</Link>
        </Button>
        <Button size="sm" variant="outline" className="w-full" onClick={onDismiss}>
          View Summary
        </Button>
      </div>
    </Shell>
  );
}
