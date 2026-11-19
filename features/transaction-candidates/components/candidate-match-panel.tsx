"use client";

/**
 * The "already in FlowFi" cue inside an Inbox row: ONE small corner sticker ("Possible duplicate") so the row stays as compact as
 * any other; clicking it reveals the matching saved transaction(s) inline. An EXACT match (same amount, day and merchant)
 * and a POSSIBLE one are told apart in words (colour only echoes it). It describes and never decides: nothing here imports, skips,
 * merges or dismisses anything — resolving happens in Review ("Already recorded" / "Import as new").
 */

import { ChevronDown, Tag } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { RowMatch } from "../lib/match-display";
import { FOCUS_RING } from "./candidate-row-parts";

function MatchLine({ match }: { match: RowMatch }) {
  const { existing } = match;
  const meta = [existing.dateText, existing.accountLabel, existing.categoryLabel, existing.sourceLabel].filter(Boolean);
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
        {meta.map((m, i) => (
          <span key={`${m}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-border-strong">
                ·
              </span>
            )}
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

/**
 * The ONE duplicate cue a row carries: a small amber sticker pinned to the row's top-left corner, like an offer tag on a product
 * card. It sits in the row's top padding (the row adds room for it), so it never covers the merchant name, amount or actions.
 * Clicking it reveals the matching saved transaction(s) inline (or opens Review when none are loaded to show).
 */
export function DuplicateSticker({ exact, open, controls, onClick }: { exact: boolean; open: boolean | null; controls?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open ?? undefined}
      aria-controls={controls}
      data-testid="candidate-match-badge"
      data-match-kind={exact ? "exact" : "possible"}
      title={exact ? "Same amount, day and merchant as a saved transaction — click to compare" : "Close to a saved transaction — click to compare"}
      className={cn(
        // Glossy red tag (gradient, inner highlight, soft red glow and a periodic glint — see `.dup-sticker` in globals.css).
        "dup-sticker absolute top-0 left-0 z-[1] inline-flex h-5 items-center gap-1 overflow-hidden rounded-br-[10px] pr-2.5 pl-2.5 text-[10px] leading-none font-extrabold tracking-[0.07em] text-white uppercase [text-shadow:0_1px_0_rgb(0_0_0/0.22)]",
        "transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px motion-reduce:transition-none",
        FOCUS_RING,
      )}
    >
      <span aria-hidden className="relative grid size-3 shrink-0 place-items-center rounded-full bg-white/25">
        <Tag className="size-2" strokeWidth={3} />
      </span>
      Possible duplicate
      {open != null && <ChevronDown className={cn("size-2.5 shrink-0 transition-transform duration-200", open && "rotate-180")} strokeWidth={3} aria-hidden />}
    </button>
  );
}

/** The saved transaction(s) a row may duplicate — revealed under the merchant when the sticker is clicked; folded otherwise. */
export function CandidateMatchPanel({ matches, open, id, onCompare }: { matches: RowMatch[]; open: boolean; id: string; onCompare: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const best = matches[0];
  if (!best) return null;
  const shown = showAll ? matches : matches.slice(0, 1);
  return (
    <div id={id} data-testid="candidate-row-matches" data-match-kind={best.kind} className={cn("grid w-full transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none", open ? "mt-1 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
      <div className="min-h-0 overflow-hidden" inert={!open}>
        <section data-testid="candidate-match-panel" data-match-kind={best.kind} aria-label="Matching saved transaction" className="flex flex-col gap-1.5 rounded-lg border border-danger/25 bg-danger/[0.04] px-2.5 py-2">
          <ul className="flex flex-col divide-y divide-border/70">
            {shown.map((m) => (
              <MatchLine key={m.transactionId} match={m} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" onClick={onCompare} className={cn("rounded-md px-1.5 py-0.5 text-xs font-semibold text-foreground underline underline-offset-2 hover:bg-secondary", FOCUS_RING)}>
              Compare in review
            </button>
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
      </div>
    </div>
  );
}
