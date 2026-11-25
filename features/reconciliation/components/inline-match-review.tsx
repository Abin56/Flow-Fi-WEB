"use client";

/**
 * The inline review panel — opens directly under a statement row (desktop) when its match chip is clicked. It replaces
 * the old second "Existing FlowFi" sheet: nothing is permanently duplicated beside the statement; FlowFi's own
 * transactions appear here only for the one row being checked.
 *
 *   candidates (a compact pick list when there is more than one)
 *   → ONE side-by-side comparison for the picked candidate (differences highlighted)
 *   → the explicit decision (2026-11-25):
 *       Already recorded  keep FlowFi's transaction, don't import this row
 *       Import as new     it's a different transaction: the candidates shown are set aside ("not this one") for this row
 *       Keep both         they are separate although alike: the candidate stays, and this row is imported too
 *       Review later      leave it open
 *     The decision is kept in the draft (closing the panel or the editor doesn't lose it). A material edit to the row's
 *     date, amount or Debit/Credit withdraws it, and the final import re-checks FlowFi before writing.
 *
 * Everything is a view over the matcher's own evidence (`existingEntries`, `fieldDiffs`, `resolutionOptions`) — no new
 * matching rule lives here. Every button only records a draft decision; the final approval is still the only writer,
 * and nothing in FlowFi is edited, merged or deleted from this panel.
 */

import Link from "next/link";
import { CheckCircle2, CircleHelp, Copy, Link2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import type { RowGateContext } from "../lib/decisions";
import { evidenceTags, fieldDiffs, resolutionOptions, REPLACE_UNSUPPORTED, type ExistingEntry } from "../lib/merge-studio";
import type { ReconRow, RowDecision, RowMatch } from "../lib/types";
import { Mark, formatRowDate } from "./recon-ui";

export interface InlineMatchReviewProps {
  row: ReconRow;
  rowNumber: number;
  match: RowMatch;
  decision: RowDecision;
  gate: RowGateContext;
  /** The matcher's view of this one row: the imported-earlier record, candidates, waiting SMS (see `existingEntries`). */
  entries: ExistingEntry[];
  /** The record shown in the comparison. */
  targetId: string | null;
  onPick: (recordId: string) => void;
  accountName: (accountId: string) => string;
  statementAccount: string;
  captureSource: "text" | "ocr";
  /** Draft decisions — never writes. */
  onKeepExisting: (recordId: string) => void;
  /** Both are real: keep the candidate, import this row too (the explicit "these are separate" acknowledgement). */
  onKeepBoth: () => void;
  /** A different transaction: set the shown candidates aside for this row, then it imports like any new row. */
  onImportNew: () => void;
  onReviewLater: () => void;
  onNotThisOne: (recordId: string) => void;
  onClearDecision: () => void;
  onClose: () => void;
  /** Opens the full comparison sheet: screenshot strip, notes, other-account look-alikes, every candidate. */
  onFullDetails: () => void;
}

const ROLE_LABEL: Record<ExistingEntry["role"], string> = { imported: "Imported earlier", suggested: "Best match", candidate: "Possible", sms: "SMS in Inbox", linkable: "Nearby", context: "Context" };

export function InlineMatchReview(p: InlineMatchReviewProps) {
  const { row, match, decision, entries } = p;
  const target = entries.find((e) => e.record.id === p.targetId) ?? entries[0] ?? null;
  const options = resolutionOptions({ row, match, decision, gate: p.gate, target });
  const option = (id: string) => options.find((o) => o.id === id)!;
  const keepExisting = option("keep_existing");
  const keepBoth = option("keep_both");
  const reviewLater = option("review_later");
  const possible = entries.length > 0;
  const keepBothOn = decision.kind === "import_new" && decision.notSameAck;
  const diffs = target
    ? fieldDiffs({ row, record: target.record, candidate: target.candidate, statementAccount: p.statementAccount, existingAccount: p.accountName(target.record.accountId ?? ""), captureSource: p.captureSource })
    : [];
  const imported = match.state === "already_imported";
  const decided = decision.kind != null && decision.kind !== "investigate";

  return (
    <div role="region" aria-label={`Match review for row ${p.rowNumber}`} data-testid="inline-review" data-row-id={row.id} className="border-b border-border-strong/60 bg-muted/30 px-3 py-2.5 shadow-[inset_3px_0_0_0_var(--primary)]">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Row {p.rowNumber} · {row.description || "No description"} · {row.amount != null ? formatCurrencyPrecise(row.amount) : "No amount"}
          <span className="ml-1.5 font-normal text-muted-foreground">
            {imported ? "was imported earlier" : possible ? `${entries.length} possible match${entries.length === 1 ? "" : "es"} in FlowFi` : "no similar FlowFi transaction"}
          </span>
        </p>
        <button type="button" onClick={p.onFullDetails} data-testid="inline-full-details" title="Screenshot evidence, notes and look-alikes on other accounts" className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:bg-muted hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Full details
        </button>
        <button type="button" onClick={p.onClose} aria-label="Close match review" data-testid="inline-review-close" className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <X className="size-3.5" />
        </button>
      </div>

      {entries.length > 1 && (
        <div role="radiogroup" aria-label="Candidate FlowFi transactions" className="mt-2 flex flex-col overflow-hidden rounded-md border border-border/70 bg-card" data-testid="inline-candidates">
          {entries.map((e) => {
            const on = e.record.id === target?.record.id;
            return (
              <button
                key={e.record.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => p.onPick(e.record.id)}
                data-testid="inline-candidate"
                data-record-id={e.record.id}
                className={cn("flex h-8 items-center gap-2 border-b border-border/50 px-2 text-left text-xs last:border-b-0 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset", on && "bg-primary/10")}
              >
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full border", on ? "border-primary bg-primary" : "border-muted-foreground/50")} />
                <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{shortDate(e.record.dateTime)}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{e.record.description || "No description"}</span>
                <span className="shrink-0 tabular-nums">{formatCurrencyPrecise(e.record.amount)}</span>
                <span className="hidden max-w-[16rem] shrink-0 truncate text-[11px] text-muted-foreground @min-[48rem]:inline">
                  {e.candidate
                    ? evidenceTags(e.candidate, { sameAccount: true })
                        .filter((t) => t.key !== "account")
                        .map((t) => t.label.replace(" in FlowFi", ""))
                        .join(" · ")
                    : ROLE_LABEL[e.role]}
                </span>
                {e.linkedRowId && e.linkedRowId !== row.id && <Mark tone="warning">Kept by another row</Mark>}
              </button>
            );
          })}
        </div>
      )}

      {target ? (
        <div className="mt-2 overflow-hidden rounded-md border border-border/70 bg-card" data-testid="inline-compare" data-record-id={target.record.id}>
          <div role="table" aria-label="Existing FlowFi vs imported statement" className="text-xs">
            <div role="row" className="grid grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)] border-b border-border/70 bg-muted/50 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
              <span role="columnheader" className="px-2 py-1">
                Field
              </span>
              <span role="columnheader" className="border-l border-border/50 px-2 py-1">
                Existing FlowFi
              </span>
              <span role="columnheader" className="border-l border-border/50 px-2 py-1">
                Imported statement
              </span>
              <span role="columnheader" className="border-l border-border/50 px-2 py-1">
                Difference
              </span>
            </div>
            {diffs
              .filter((d) => d.key !== "origin" || d.existing !== "Unknown")
              .map((d) => (
                <div key={d.key} role="row" data-field={d.key} data-verdict={d.verdict} className={cn("grid grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)] border-b border-border/40 last:border-b-0", d.verdict === "diff" && "bg-warning/[0.07]")}>
                  <span role="rowheader" className="px-2 py-1 text-muted-foreground">
                    {d.label}
                  </span>
                  <span role="cell" className={cn("min-w-0 border-l border-border/40 px-2 py-1 break-words", d.verdict === "diff" && "font-semibold text-foreground")}>
                    {d.existing}
                  </span>
                  <span role="cell" className={cn("min-w-0 border-l border-border/40 px-2 py-1 break-words", d.verdict === "diff" && "font-semibold text-foreground")}>
                    {d.statement}
                  </span>
                  <span role="cell" className={cn("min-w-0 border-l border-border/40 px-2 py-1", d.verdict === "same" ? "text-success" : d.verdict === "diff" ? "font-medium text-warning" : "text-muted-foreground")}>
                    {d.detail || (d.verdict === "same" ? "Same" : "")}
                  </span>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <p className="mt-2 rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground" data-testid="inline-no-candidate">
          {imported ? "This exact row was imported earlier." : "Nothing on this account looks like this row, so there is nothing to keep — import it, or save it for later."}
        </p>
      )}

      {target?.viewOnly && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="inline-view-only">
          {target.viewOnly.message}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="inline-decisions">
        {target && (
          <button
            type="button"
            disabled={!keepExisting.enabled}
            title={keepExisting.reason ?? "FlowFi already has it — keep that one and don't import this row."}
            onClick={() => target && p.onKeepExisting(target.record.id)}
            aria-pressed={keepExisting.selected}
            data-testid="inline-keep-existing"
            className={cn(BTN, keepExisting.selected ? BTN_ON : BTN_PRIMARY)}
          >
            <Link2 className="size-3.5" aria-hidden /> Already recorded
          </button>
        )}
        {!imported && possible && (
          <>
            <button
              type="button"
              disabled={!row.include}
              title="A different transaction — FlowFi's suggestion is set aside for this row (Not this one), and the row imports like any new row once it is complete."
              onClick={p.onImportNew}
              data-testid="inline-import"
              className={cn(BTN, BTN_SECONDARY)}
            >
              <Plus className="size-3.5" aria-hidden /> Import as new
            </button>
            <button
              type="button"
              disabled={!keepBoth.enabled}
              title={keepBoth.reason ?? "They are separate transactions although alike — FlowFi's stays, and this row is imported too."}
              onClick={p.onKeepBoth}
              aria-pressed={keepBothOn}
              data-testid="inline-keep-both"
              className={cn(BTN, keepBothOn ? BTN_ON : BTN_SECONDARY)}
            >
              <Copy className="size-3.5" aria-hidden /> Keep both
            </button>
          </>
        )}
        <button type="button" disabled={!reviewLater.enabled} title="Leave it unresolved — final approval waits for it." onClick={p.onReviewLater} aria-pressed={reviewLater.selected} data-testid="inline-review-later" className={cn(BTN, reviewLater.selected ? BTN_ON : BTN_SECONDARY)}>
          <CircleHelp className="size-3.5" aria-hidden /> Review later
        </button>
        {target && target.record.kind === "transaction" && match.candidates.some((c) => c.recordId === target.record.id) && (
          <button type="button" onClick={() => p.onNotThisOne(target.record.id)} title="Drop this FlowFi transaction as a candidate for the row. Nothing is imported or deleted." data-testid="inline-not-a-match" className={cn(BTN, "text-muted-foreground")}>
            Not a match
          </button>
        )}
        {decided && (
          <button type="button" onClick={p.onClearDecision} data-testid="inline-clear" className={cn(BTN, "text-muted-foreground")}>
            Clear decision
          </button>
        )}
        {decided && (
          <span className="inline-flex items-center gap-1 text-[11px] text-success" data-testid="inline-decided">
            <CheckCircle2 className="size-3.5" aria-hidden /> Decision kept — nothing is written until you import.
          </span>
        )}
        <Link href="/transactions" title={REPLACE_UNSUPPORTED} className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Existing details wrong? Correct them in Transactions
        </Link>
      </div>

      <p className="sr-only">{formatRowDate(row.date)}</p>
    </div>
  );
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
}

const BTN = "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45";
const BTN_PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const BTN_SECONDARY = "border border-border-strong/70 bg-card text-foreground hover:bg-muted";
const BTN_ON = "bg-success/15 text-success ring-1 ring-success/40";
