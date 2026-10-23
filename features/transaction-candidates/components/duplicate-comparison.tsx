"use client";

import { Check, Equal, Minus, Landmark } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComparisonMatch, DuplicateComparison } from "../lib/duplicate-comparison";

const MATCH_TEXT: Record<ComparisonMatch, string> = { same: "Same", similar: "Similar", different: "Different", unknown: "—" };

function MatchMark({ match }: { match: ComparisonMatch }) {
  const Icon = match === "same" ? Check : match === "similar" ? Equal : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold text-foreground",
        match === "same" && "border-success/50 bg-success/12",
        match === "similar" && "border-warning/60 bg-warning/20",
        match === "different" && "border-border-strong bg-muted",
        match === "unknown" && "border-border bg-transparent text-muted-foreground",
      )}
    >
      <Icon className="size-3" strokeWidth={2.5} aria-hidden />
      {MATCH_TEXT[match]}
    </span>
  );
}

const STRENGTH_TEXT = { strong: "Strong match", likely: "Likely match", weak: "Weak match" } as const;

/**
 * Human-readable side-by-side of an SMS candidate and the existing transaction it may duplicate: amount, date, merchant,
 * account/card and direction — each marked Same / Similar / Different in TEXT (colour is only a hint). It describes only;
 * it never dismisses, merges or imports, and never shows an internal transaction id.
 */
export function DuplicateComparisonCard({ comparison }: { comparison: DuplicateComparison }) {
  return (
    <section aria-labelledby="dup-compare-title" className="flex flex-col gap-2.5 rounded-[12px] border border-warning/60 bg-warning/8 p-3" data-testid="duplicate-comparison">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="dup-compare-title" className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-foreground uppercase">
          <Landmark className="size-3.5 text-warning" aria-hidden />
          Possible duplicate
        </h4>
        <span className="rounded-full border border-border-strong bg-card px-2 py-0.5 text-[11px] font-semibold text-foreground">{STRENGTH_TEXT[comparison.strength]}</span>
      </div>
      <p className="text-xs text-foreground/90">{comparison.summary}</p>
      <div className="overflow-x-auto rounded-[10px] border border-border bg-card">
        <table className="w-full min-w-[420px] border-collapse text-xs">
          <caption className="sr-only">This SMS compared with the transaction you already have</caption>
          <thead>
            <tr className="border-b border-border bg-secondary/60 text-left text-[11px] tracking-wide text-muted-foreground uppercase">
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                <span className="sr-only">Field</span>
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                This SMS
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Already in FlowFi
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                <span className="sr-only">Result</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((r) => (
              <tr key={r.field} className="border-b border-border/70 last:border-b-0">
                <th scope="row" className="px-2.5 py-2 text-left font-medium text-muted-foreground">
                  {r.label}
                </th>
                <td className="px-2.5 py-2 font-semibold break-words text-foreground">{r.candidate}</td>
                <td className="px-2.5 py-2 font-semibold break-words text-foreground">{r.existing}</td>
                <td className="px-2.5 py-2 text-right">
                  <MatchMark match={r.match} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">Importing will re-check this and ask for your confirmation before anything is created.</p>
    </section>
  );
}
