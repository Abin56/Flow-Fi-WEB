"use client";

import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { LinkedEmiSource } from "@/features/people/hooks/use-person-cycle-statement";
import { CycleNavigator } from "@/features/people/components/workspace/transaction-ledger-mode";
import { formatCycleLabel, type PersonCycleStatement, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { CycleReconciliation } from "@/features/people/components/workspace/settlement-summary";
import { cyclePosition } from "@/features/people/lib/settlement-presentation";
import { EmiBadge, StatementBreakdown, StatementCalculation } from "./statement-parts";

/**
 * The People Ledger's monthly (18th → 17th) settlement summary for one person — the balance hero, cycle
 * switcher and compact reconciliation. Presentational only: the statement comes from
 * `usePersonCycleStatement`, owned by the Person workspace so its activity feed reads the same result.
 */
export function PersonCycleStatementSection({
  statement,
  isLoading,
  cycle,
  onCycleChange,
  linkedEmis,
  setRepays,
  actions,
  footnote,
}: {
  statement: PersonCycleStatement | null;
  isLoading: boolean;
  cycle: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  linkedEmis: LinkedEmiSource[];
  setRepays: (source: LinkedEmiSource, repays: boolean) => Promise<void>;
  /** Rendered directly under the balance (the workspace's action bar). */
  actions?: React.ReactNode;
  /** Small print under the actions (e.g. the loans-outside-this-statement note). */
  footnote?: React.ReactNode;
}) {
  const [howOpen, setHowOpen] = useState(false);
  const [savingLink, setSavingLink] = useState<string | null>(null);
  const toggleRepays = async (source: LinkedEmiSource) => {
    setSavingLink(source.id);
    try {
      await setRepays(source, !source.repays);
    } catch {
      toast.error("Couldn't update the EMI");
    } finally {
      setSavingLink(null);
    }
  };
  const loading = isLoading || statement == null;
  const tone =
    statement?.direction === "theyOwe" ? "text-settle-receivable-text" : statement?.direction === "iOwe" ? "text-settle-payable-text" : "text-success";
  const edge =
    statement?.direction === "theyOwe" ? "border-l-settle-receivable-edge" : statement?.direction === "iOwe" ? "border-l-settle-payable-edge" : "border-l-success";
  const DirectionIcon = statement?.direction === "theyOwe" ? ArrowDownLeft : statement?.direction === "iOwe" ? ArrowUpRight : Check;

  return (
    <section className="grid gap-x-8 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)]">
      {/* Balance hero — the strongest element on the page */}
      <div className="min-w-0">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-40" />
          </div>
        ) : (
          <>
            <p className="text-[11.5px] font-semibold tracking-[0.04em] text-foreground/70">Settlement · {formatCycleLabel(cycle)}</p>
            {statement.toReceive > 0 && statement.toGive > 0 ? (
              // Two independent obligations — both gross, each settled on its own; never one netted figure.
              <>
                <div className="mt-1.5 grid max-w-md grid-cols-2 gap-2">
                  <div className="rounded-[8px] border border-settle-receivable-edge/70 border-l-[4px] border-l-settle-receivable-edge bg-settle-receivable-tint px-3 py-2">
                    <p className="text-[11.5px] font-bold tracking-[0.08em] text-settle-receivable-text uppercase">You need to receive</p>
                    <p className="mt-0.5 font-heading text-[26px] leading-none font-bold tracking-tight tabular-nums text-settle-receivable-text sm:text-[30px]">{money(statement.toReceive)}</p>
                  </div>
                  <div className="rounded-[8px] border border-settle-payable-edge/70 border-l-[4px] border-l-settle-payable-edge bg-settle-payable-tint px-3 py-2">
                    <p className="text-[11.5px] font-bold tracking-[0.08em] text-settle-payable-text uppercase">You need to give</p>
                    <p className="mt-0.5 font-heading text-[26px] leading-none font-bold tracking-tight tabular-nums text-settle-payable-text sm:text-[30px]">{money(statement.toGive)}</p>
                  </div>
                </div>
                <p className="mt-1.5 text-[11.5px] font-medium text-foreground/70">Tracked separately — each side is settled on its own.</p>
              </>
            ) : (
            <div className={cn("mt-1.5 border-l-[4px] pl-3", edge)}>
              <p className={cn("inline-flex items-center gap-1.5 text-[13px] font-bold tracking-[0.08em] uppercase", tone)}>
                <DirectionIcon className="size-4" strokeWidth={2.5} aria-hidden />
                {cyclePosition(statement, statement.personName).headline}
              </p>
              <p className={cn("mt-0.5 font-heading text-[34px] leading-none font-bold tracking-tight tabular-nums sm:text-[38px]", statement.direction === "settled" ? "text-foreground" : tone)}>
                {money(statement.amount)}
              </p>
            </div>
            )}
          </>
        )}

        {/* Cycle — the same navigator as the expanded ledger, so both read one shared cycle */}
        <div className="-ml-1.5 mt-2.5">
          <CycleNavigator cycle={cycle} onCycleChange={onCycleChange} />
        </div>

        {actions && <div className="mt-6">{actions}</div>}
        {footnote}
      </div>

      {/* Compact reconciliation */}
      <div className="min-w-0 border-t border-border-strong/75 pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-7">
        {loading ? (
          <div className="space-y-2 pt-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : (
          <>
            <p className="text-[11px] font-bold tracking-[0.08em] text-foreground/75 uppercase">This cycle</p>
            <CycleReconciliation statement={statement} personName={statement.personName} className="mt-1" />

            {linkedEmis.length > 0 && (
              <div className="mt-3 border-t border-border-strong/75 pt-2.5">
                <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Linked EMIs</p>
                <ul className="mt-1.5 space-y-2">
                  {linkedEmis.map((s) => (
                    <li key={`${s.kind}:${s.id}`} className="flex flex-col gap-1 text-xs">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <EmiBadge />
                        <span className="truncate font-medium text-foreground">{s.name}</span>
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">
                          {s.repays ? `${statement.personName} repays you` : "For them, not counted"}
                        </span>
                        <button
                          type="button"
                          disabled={savingLink === s.id}
                          onClick={() => toggleRepays(s)}
                          className="shrink-0 rounded-[6px] border border-border-strong px-2 py-0.5 font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:text-primary-accent-text disabled:opacity-50"
                        >
                          {s.repays ? "Stop counting" : `${statement.personName} repays me`}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Paying the bank doesn&apos;t settle this — record what they pay you with Settle Up.
                </p>
              </div>
            )}

            <div className="mt-2">
              <button
                type="button"
                aria-expanded={howOpen}
                onClick={() => setHowOpen((o) => !o)}
                className="-mx-1 flex w-[calc(100%+0.5rem)] items-center justify-between rounded-[6px] px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                How is this calculated?
                <ChevronDown className={cn("size-3.5 transition-transform", howOpen && "rotate-180")} strokeWidth={1.75} />
              </button>
              {howOpen && (
                <div className="mt-1.5 space-y-3 rounded-[6px] bg-secondary/60 p-3">
                  <StatementBreakdown statement={statement} />
                  <StatementCalculation statement={statement} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
