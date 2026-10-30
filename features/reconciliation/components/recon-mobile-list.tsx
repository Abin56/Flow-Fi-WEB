"use client";

/** Mobile reconciliation list — compact cards; tapping one opens the details/match sheet. No grid, no sideways scroll. */

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReconRow, RowDecision, RowMatch } from "../lib/types";
import { DecisionChip, Money, StateBadge, formatRowDate } from "./recon-ui";
import { evidenceLine } from "./recon-table";
import { rowCheckLabel } from "../lib/decisions";

export function ReconMobileList({
  rows,
  numberOf,
  matches,
  decisions,
  onOpen,
  pendingLabel,
}: {
  rows: ReconRow[];
  numberOf: (rowId: string) => number;
  matches: Map<string, RowMatch>;
  decisions: Record<string, RowDecision>;
  onOpen: (rowId: string) => void;
  pendingLabel: string;
}) {
  if (rows.length === 0) return <p className="surface-primary rounded-3xl px-4 py-10 text-center text-sm text-muted-foreground">No rows match these filters.</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label="Statement rows">
      {rows.map((row) => {
        const match = matches.get(row.id);
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onOpen(row.id)}
              data-testid="recon-card"
              data-row-id={row.id}
              data-state={match?.state ?? "pending"}
              className={cn("surface-primary flex w-full min-w-0 items-center gap-3 rounded-2xl p-3 text-left transition-colors active:bg-foreground/5", !row.include && "opacity-60")}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="tabular-nums">#{numberOf(row.id)}</span>
                  <span>{formatRowDate(row.date)}</span>
                  {match && <StateBadge state={match.state} compact />}
                </div>
                <p className="mt-1 truncate text-sm font-medium text-foreground">{row.description || "No description"}</p>
                {rowCheckLabel(row) && <p className="truncate text-[11px] font-medium text-warning" data-testid="row-check-label">{rowCheckLabel(row)}</p>}
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  {match?.state !== "excluded" && <DecisionChip kind={decisions[row.id]?.kind ?? null} />}
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">{evidenceLine(match, pendingLabel)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Money amount={row.amount} direction={row.direction} />
                <ChevronRight className="size-4 text-muted-foreground" />
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
