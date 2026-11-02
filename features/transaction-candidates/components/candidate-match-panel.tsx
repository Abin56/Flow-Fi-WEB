"use client";

/**
 * The "already in FlowFi" strip inside an Inbox row: the saved transaction(s) this message may duplicate, so the reviewer can
 * compare without leaving the list. An EXACT match (same amount, day and merchant) and a POSSIBLE one (close, not identical) are
 * labelled differently in words — colour only echoes it. It describes and never decides: nothing here imports, skips, merges or
 * dismisses anything.
 */

import { CopyX, ScanSearch } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import type { RowMatch } from "../lib/match-display";
import { FOCUS_RING } from "./candidate-row-parts";

function MatchLine({ match }: { match: RowMatch }) {
  const { existing } = match;
  const meta = [existing.accountLabel, existing.categoryLabel, existing.sourceLabel].filter(Boolean);
  return (
    <li className="flex flex-col gap-1 py-1.5 first:pt-0 last:pb-0" data-testid="candidate-match" data-match-kind={match.kind}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground" title={existing.description}>
          {existing.description}
        </span>
        <span className="shrink-0 text-[13px] font-bold text-foreground tabular-nums">
          {existing.amountText}
          <span className="ml-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{existing.directionText}</span>
        </span>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-snug text-muted-foreground">
        <span className="whitespace-nowrap">{existing.dateText}</span>
        {meta.map((m) => (
          <span key={m} className="flex items-center gap-1.5">
            <span aria-hidden className="text-border-strong">
              ·
            </span>
            <span className="min-w-0 truncate">{m}</span>
          </span>
        ))}
      </p>
      <ul className="flex flex-wrap gap-1" aria-label="Why this was matched">
        {match.reasons.map((r) => (
          <li key={r} className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground">
            {r}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function CandidateMatchPanel({ matches, onCompare }: { matches: RowMatch[]; onCompare: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const headingId = useId();
  const best = matches[0];
  if (!best) return null;
  const exact = best.kind === "exact";
  const shown = showAll ? matches : matches.slice(0, 1);
  const Icon = exact ? CopyX : ScanSearch;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="candidate-match-panel"
      data-match-kind={best.kind}
      className={cn("flex flex-col gap-2 rounded-xl border px-3 py-2.5", exact ? "border-danger/50 bg-danger/[0.06]" : "border-warning/60 bg-warning/[0.09]")}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-foreground uppercase">
          <Icon className={cn("size-3.5 shrink-0", exact ? "text-danger" : "text-warning-foreground dark:text-warning")} aria-hidden />
          {exact ? "Exact match — already imported" : "Possible match — similar transaction already imported"}
        </h3>
        <button
          type="button"
          onClick={onCompare}
          className={cn("rounded-md px-1.5 py-0.5 text-xs font-semibold text-foreground underline underline-offset-2 hover:bg-secondary", FOCUS_RING)}
        >
          Compare in review
        </button>
      </div>
      <ul className="flex flex-col divide-y divide-border/70 rounded-lg border border-border bg-card px-2.5 py-2">
        {shown.map((m) => (
          <MatchLine key={m.transactionId} match={m} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">Nothing is skipped or merged for you — import or dismiss this message yourself.</p>
        {matches.length > 1 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className={cn("rounded-md px-1.5 py-0.5 text-xs font-semibold text-foreground underline underline-offset-2 hover:bg-secondary", FOCUS_RING)}
          >
            {showAll ? "Show fewer" : `Show ${matches.length - 1} more similar`}
          </button>
        )}
      </div>
    </section>
  );
}
