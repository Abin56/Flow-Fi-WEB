"use client";

import { ChevronDown, ChevronLeft, ChevronRight, Share2 } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { cycleContaining, formatCycleLabel, sameCycle, shiftCycle, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { StatementPreviewDialog } from "./statement-preview-dialog";
import {
  EmiBadge,
  StatementActivityRow,
  StatementBreakdown,
  StatementCalculation,
  StatementHeadline,
  StatementReconciliation,
} from "./statement-parts";

/** The People Ledger's monthly (18th → 17th) settlement statement for one person. */
export function PersonCycleStatementSection({ personId, phone }: { personId: string; phone?: string | null }) {
  const [cycle, setCycle] = useState<StatementCycle>(() => cycleContaining(new Date()));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const { statement, isLoading, linkedEmis, setRepays } = usePersonCycleStatement(personId, cycle);
  const [savingLink, setSavingLink] = useState<string | null>(null);
  const toggleRepays = async (source: (typeof linkedEmis)[number]) => {
    setSavingLink(source.id);
    try {
      await setRepays(source, !source.repays);
    } catch {
      toast.error("Couldn't update the EMI");
    } finally {
      setSavingLink(null);
    }
  };
  const isCurrent = sameCycle(cycle, cycleContaining(new Date()));

  return (
    <section className="mt-4 rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <button
          type="button"
          aria-label="Previous cycle"
          onClick={() => setCycle((c) => shiftCycle(c, -1))}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="text-center">
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            {isCurrent ? "Current cycle" : "Past cycle"}
          </p>
          <p className="text-sm font-semibold text-foreground tabular-nums">{formatCycleLabel(cycle)}</p>
        </div>
        <div className="flex items-center gap-0.5">
          {!isCurrent && (
            <button
              type="button"
              onClick={() => setCycle(cycleContaining(new Date()))}
              className="rounded-md px-1.5 py-1 text-[11px] font-semibold text-primary-accent-text hover:bg-muted"
            >
              Today
            </button>
          )}
          <button
            type="button"
            aria-label="Next cycle"
            onClick={() => setCycle((c) => shiftCycle(c, 1))}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {isLoading || statement == null ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <div className="p-4">
          <div className="flex items-end justify-between gap-3">
            <StatementHeadline statement={statement} />
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:text-primary-accent-text"
            >
              <Share2 className="size-3.5" />
              Share Statement
            </button>
          </div>

          <div className="mt-3">
            <StatementReconciliation statement={statement} />
          </div>

          {statement.activityBreakdown.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <StatementBreakdown statement={statement} />
            </div>
          )}

          <div className="mt-3 border-t border-border pt-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Activity</p>
            {statement.rows.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No activity in this cycle.</p>
            ) : (
              <ul className="mt-1 max-h-80 divide-y divide-border overflow-y-auto px-2">
                {[...statement.rows].reverse().map((r) => (
                  <StatementActivityRow key={r.key} statement={statement} row={r} />
                ))}
              </ul>
            )}
          </div>

          {linkedEmis.length > 0 && (
            <div className="mt-2 border-t border-border pt-2">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Linked EMIs</p>
              <ul className="mt-1 space-y-1.5">
                {linkedEmis.map((s) => (
                  <li key={`${s.kind}:${s.id}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EmiBadge />
                      <span className="truncate text-foreground">{s.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {s.repays ? `· ${statement.personName} repays you` : "· for them, not counted"}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={savingLink === s.id}
                      onClick={() => toggleRepays(s)}
                      className="shrink-0 rounded-md border border-border px-2 py-0.5 font-semibold text-foreground hover:border-primary-accent-text hover:text-primary-accent-text disabled:opacity-50"
                    >
                      {s.repays ? "Stop counting" : `${statement.personName} repays me`}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Paying the bank doesn&apos;t settle this — record what they pay you with Settle Up.
              </p>
            </div>
          )}

          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              aria-expanded={howOpen}
              onClick={() => setHowOpen((o) => !o)}
              className="flex w-full items-center justify-between py-1 text-xs font-semibold text-foreground"
            >
              How is this calculated?
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", howOpen && "rotate-180")} />
            </button>
            {howOpen && (
              <div className="mt-1 rounded-md bg-muted/40 p-3">
                <StatementCalculation statement={statement} />
              </div>
            )}
          </div>

          <StatementPreviewDialog statement={statement} phone={phone} open={previewOpen} onOpenChange={setPreviewOpen} />
        </div>
      )}
    </section>
  );
}
