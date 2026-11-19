"use client";

import { Check, ChevronDown, CopyCheck, CopyPlus, Equal, Eye, EyeOff, Loader2, Minus, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { summarizeComparison, type ComparisonMatch, type ComparisonRow, type DuplicateComparison } from "../lib/duplicate-comparison";

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

function rowOf(rows: ComparisonRow[], field: ComparisonRow["field"]): ComparisonRow | undefined {
  return rows.find((r) => r.field === field);
}

/** "₹380.00 · Google Pay · 04 Nov 2026 · BOI •••• 9585" — only the facts that exist. */
function sideLine(rows: ComparisonRow[], side: "candidate" | "existing"): string {
  const parts = (["amount", "merchant", "date", "account"] as const)
    .map((f) => rowOf(rows, f)?.[side])
    .filter((v): v is string => !!v && v !== "—" && v !== "Not chosen yet");
  return parts.join(" · ") || "—";
}

function Side({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-snug" data-testid={testId}>
      <span className="w-[4.75rem] shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="min-w-0 truncate font-medium text-foreground" title={text}>
        {text}
      </span>
    </p>
  );
}

/**
 * Compact "possible duplicate" decision card for the review sheet. It names the saved transaction and the new SMS on one line each,
 * gives a one-line reading ("3 matching details · Merchant differs"), and offers the two real outcomes:
 *  - Already recorded — same transaction; the caller resolves the SMS WITHOUT importing (no money moves).
 *  - Import as new — a genuinely separate payment; the caller continues the normal import once, on the reviewer's say-so.
 * The full field table and the technical bits are folded away. A possible match stays a *possible* match — nothing here decides alone.
 */
export function DuplicateResolutionCard({
  comparison,
  rechecked = true,
  busy = false,
  importing = false,
  onAlreadyRecorded,
  onImportAsNew,
  onIgnore,
}: {
  comparison: DuplicateComparison;
  /** `true` when the strict check also re-runs (and asks) at import; `false` for a similar-but-not-flagged match, which is a hint only. */
  rechecked?: boolean;
  busy?: boolean;
  importing?: boolean;
  onAlreadyRecorded: () => void;
  onImportAsNew: () => void;
  /** View-only: folds this card to one line so the form can be reviewed normally. Never dismisses, resolves or imports. */
  onIgnore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const tableId = useId();
  const gist = summarizeComparison(comparison);
  const title = rechecked ? "Possible duplicate found" : "Similar transaction found";

  return (
    <section
      aria-label={title}
      title={comparison.summary}
      className="flex flex-col gap-2 rounded-xl border border-warning/55 bg-warning/[0.07] px-3 py-2.5 animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none"
      data-testid="duplicate-comparison"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4 className="flex items-center gap-1.5 text-[13px] font-bold text-foreground">
          <TriangleAlert className="size-3.5 text-warning-foreground dark:text-warning" aria-hidden />
          {title}
          <span className="rounded-full border border-border-strong bg-card px-2 py-0.5 text-[10.5px] font-semibold text-foreground/85">{comparison.kind === "exact" ? "Exact match" : STRENGTH_TEXT[comparison.strength]}</span>
        </h4>
        <button
          type="button"
          onClick={onIgnore}
          disabled={busy}
          data-testid="duplicate-ignore"
          title="Hide this warning and review normally. The SMS stays in your inbox; nothing is dismissed, resolved or imported."
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          <EyeOff className="size-3.5" aria-hidden /> Ignore warning
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <Side label="Existing" text={sideLine(comparison.rows, "existing")} testId="duplicate-existing" />
        <Side label="New SMS" text={sideLine(comparison.rows, "candidate")} testId="duplicate-new" />
      </div>
      <p className="text-[12px] font-medium text-foreground/80" data-testid="duplicate-gist">
        {gist.text}
      </p>

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={onAlreadyRecorded}
          disabled={busy}
          data-testid="duplicate-already-recorded"
          title="Same transaction — resolve this SMS without importing. Nothing is created and no money moves."
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong bg-card px-3 text-[12.5px] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          <CopyCheck className="size-3.5" aria-hidden /> Already recorded
        </button>
        <button
          type="button"
          onClick={onImportAsNew}
          disabled={busy}
          data-testid="duplicate-import-new"
          title="A different transaction — import it as a separate one."
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          {importing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CopyPlus className="size-3.5" aria-hidden />} Import as new
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={tableId}
          className="ml-auto inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-foreground/85 underline-offset-2 hover:bg-secondary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Compare details <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </button>
      </div>

      <div className={cn("grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden" id={tableId} inert={!open}>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">This SMS compared with the transaction you already have</caption>
              <thead>
                <tr className="border-b border-border bg-secondary/60 text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                  <th scope="col" className="px-2.5 py-1 font-semibold">
                    <span className="sr-only">Field</span>
                  </th>
                  <th scope="col" className="px-2.5 py-1 font-semibold">
                    New SMS
                  </th>
                  <th scope="col" className="px-2.5 py-1 font-semibold">
                    Existing
                  </th>
                  <th scope="col" className="px-2.5 py-1 font-semibold">
                    <span className="sr-only">Result</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((r) => (
                  <tr key={r.field} className="border-b border-border/70 last:border-b-0">
                    <th scope="row" className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">
                      {r.label}
                    </th>
                    <td className="px-2.5 py-1.5 font-semibold break-words text-foreground">{r.candidate}</td>
                    <td className="px-2.5 py-1.5 font-semibold break-words text-foreground">{r.existing}</td>
                    <td className="px-2.5 py-1.5 text-right">
                      <MatchMark match={r.match} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </section>
  );
}

/** What "Ignore warning" leaves behind: one quiet line that brings the card back. The warning is hidden, never resolved. */
export function DuplicateFoldedLine({ onShow }: { onShow: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-warning/50 px-3 py-1.5 text-[12px] text-muted-foreground" data-testid="duplicate-folded">
      <TriangleAlert className="size-3.5 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />
      <span className="min-w-0 flex-1 truncate">Possible duplicate — warning hidden</span>
      <button
        type="button"
        onClick={onShow}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Eye className="size-3.5" aria-hidden /> Show
      </button>
    </div>
  );
}
