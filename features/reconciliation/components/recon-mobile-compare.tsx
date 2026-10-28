"use client";

/**
 * Phones: the two sheets become two tabs — New statement and Existing FlowFi — instead of two squeezed grids. The
 * selected statement row stays pinned above the FlowFi tab, so switching never loses the context; each FlowFi card
 * shows the compact comparison (amount and date difference, origin, match strength) and Keep existing. Every other
 * decision opens the row's sheet, where the explicit confirmations live.
 */

import { ArrowLeftRight, ChevronRight, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import { originText, type ExistingEntry } from "../lib/merge-studio";
import type { ReconRow, RowDecision } from "../lib/types";
import { TIER_SHORT } from "./existing-sheet";
import { Chip, DecisionChip, Money, formatRowDate } from "./recon-ui";

export type MobileTab = "statement" | "existing";

export function MobileSheetSwitch({ tab, onTab, statementCount, existingCount }: { tab: MobileTab; onTab: (tab: MobileTab) => void; statementCount: number; existingCount: number | null }) {
  return (
    <div role="tablist" aria-label="Sheets" className="grid grid-cols-2 rounded-xl bg-foreground/[0.06] p-1 text-xs font-semibold" data-testid="mobile-sheet-switch">
      {(
        [
          ["statement", `New statement (${statementCount})`],
          ["existing", `Existing FlowFi${existingCount != null ? ` (${existingCount})` : ""}`],
        ] as const
      ).map(([t, label]) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          data-testid={`mobile-tab-${t}`}
          onClick={() => onTab(t)}
          className={cn("h-9 rounded-lg transition-colors", tab === t ? "bg-card text-foreground shadow-e1" : "text-muted-foreground")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function MobileExistingList({
  row,
  rowNumber,
  decision,
  keepBoth,
  entries,
  numberOf,
  pendingLabel,
  onKeepExisting,
  onDecide,
  onPickRow,
}: {
  row: ReconRow | null;
  rowNumber: number | null;
  decision: RowDecision | null;
  keepBoth: boolean;
  entries: ExistingEntry[];
  numberOf: (rowId: string) => number;
  pendingLabel: string | null;
  onKeepExisting: (recordId: string) => void;
  onDecide: () => void;
  onPickRow: () => void;
}) {
  if (!row) {
    return (
      <p className="surface-primary rounded-3xl px-4 py-10 text-center text-sm text-muted-foreground">
        Pick a statement row first.{" "}
        <button type="button" onClick={onPickRow} className="font-medium text-primary-accent-text underline">
          Show statement
        </button>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="mobile-existing">
      <div className="sticky top-0 z-[1] flex items-center gap-3 rounded-2xl border border-primary/30 bg-card p-3 shadow-e1" data-testid="mobile-context">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted-foreground">
            Row {rowNumber} · {formatRowDate(row.date)}
          </p>
          <p className="truncate text-sm font-medium text-foreground">{row.description || "No description"}</p>
          <div className="mt-1 flex items-center gap-2">
            <Money amount={row.amount} direction={row.direction} />
            {decision && <DecisionChip kind={decision.kind} keepBoth={keepBoth} />}
          </div>
        </div>
        <button type="button" onClick={onDecide} className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground" data-testid="mobile-decide">
          Decide <ChevronRight className="size-3.5" />
        </button>
      </div>
      {pendingLabel ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">{pendingLabel}</p>
      ) : entries.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground" data-testid="existing-empty">
          No possible match on this account for row {rowNumber}.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Existing FlowFi transactions">
          {entries.map((entry) => {
            const { record, candidate } = entry;
            const kept = decision?.kind === "link" && decision.linkedRecordId === record.id;
            return (
              <li key={record.id} data-testid="mobile-existing-card" data-record-id={record.id} className={cn("surface-primary rounded-2xl p-3", kept && "ring-2 ring-success/50")}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{record.description || "No description"}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {record.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })} · {originText(record)}
                    </p>
                  </div>
                  <Money amount={record.amount} direction={record.direction} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {entry.role === "imported" ? <Chip tone="success">Imported earlier</Chip> : candidate ? <Chip tone={candidate.tier === "exact" ? "primary" : "warning"}>{TIER_SHORT[candidate.tier]}</Chip> : null}
                  {candidate && (
                    <span className="text-muted-foreground">
                      {describeAmountDelta(candidate.amountDeltaPaise).replace(" in FlowFi", "")} · {describeDayGap(candidate.dayGap).replace(" in FlowFi", "")}
                    </span>
                  )}
                  {entry.linkedRowId && entry.linkedRowId !== row.id && (
                    <span className="inline-flex items-center gap-1 text-success">
                      <ArrowLeftRight className="size-3" /> Kept by row {numberOf(entry.linkedRowId)}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {kept ? (
                    <span className="text-xs font-semibold text-success">✓ Kept — this row won&apos;t be imported</span>
                  ) : (
                    <button
                      type="button"
                      disabled={!!entry.viewOnly}
                      onClick={() => onKeepExisting(record.id)}
                      aria-label={`Keep existing ${record.description || "transaction"}`}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border-strong/70 px-3 text-xs font-medium text-foreground disabled:opacity-45"
                    >
                      <Link2 className="size-3.5" /> Keep existing
                    </button>
                  )}
                  {entry.viewOnly && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{entry.viewOnly.message}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
