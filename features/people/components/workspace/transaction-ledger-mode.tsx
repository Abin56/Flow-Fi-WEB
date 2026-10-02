"use client";

import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, HandCoins, ListX, Plus, Search, Split } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { CyclePicker } from "@/features/people/components/people-ledger-list";
import { CarriedForwardNote, ScopeSwitch, type LedgerRowHandlers, type LedgerScope } from "@/features/people/components/person-activity-feed";
import type { SettlementLookupsWithAccounts } from "@/features/people/hooks/use-settlement-lookups";
import { filterLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import type { SettlementStatusFilter, SettlementTypeFilter } from "@/features/people/lib/settlement-presentation";
import {
  cycleContaining,
  formatCycleLabel,
  sameCycle,
  shiftCycle,
  type PersonCycleStatement,
  type StatementCycle,
  type StatementDirection,
} from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";
import { InlineReveal } from "./ledger-ui";
import { WS_PAD, WS_PRIMARY, WS_SECONDARY } from "./person-workspace-ui";
import { applySettlementFilters, CycleReconciliation, CyclePaymentHistory, SettlementFilters } from "./settlement-summary";
import { SettlementTable } from "./settlement-table";
import { linkedTrailFor } from "@/features/people/components/linked-funds";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";

/** The expanded workspace's internal navigation — the ledger, or one of the Person-level flows in its place. */
export type LedgerView = "transactions" | "settle" | "split";

const NAV_BUTTON =
  "flex size-8 items-center justify-center rounded-[6px] text-foreground/70 transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** Previous / quick picker / Next — the same month-grid + date picker as the People list (`CyclePicker`). */
export function CycleNavigator({ cycle, onCycleChange }: { cycle: StatementCycle; onCycleChange: (cycle: StatementCycle) => void }) {
  const startDay = useMonthCycleStartDay();
  const current = cycleContaining(new Date(), startDay);
  const isCurrent = sameCycle(cycle, current);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" aria-label="Previous cycle" onClick={() => onCycleChange(shiftCycle(cycle, -1, startDay))} className={NAV_BUTTON}>
        <ChevronLeft className="size-4" strokeWidth={1.75} />
      </button>
      <CyclePicker cycle={cycle} current={current} onCycleChange={onCycleChange} direction={0} />
      <button
        type="button"
        aria-label="Next cycle"
        disabled={isCurrent}
        onClick={() => onCycleChange(shiftCycle(cycle, 1, startDay))}
        className={cn(NAV_BUTTON, "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent")}
      >
        <ChevronRight className="size-4" strokeWidth={1.75} />
      </button>
      {isCurrent ? (
        <span className="ml-1 rounded-[4px] bg-primary/20 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-primary-accent-text uppercase">Current</span>
      ) : (
        <button
          type="button"
          onClick={() => onCycleChange(current)}
          className="ml-1 rounded-[4px] text-xs font-semibold whitespace-nowrap text-primary-accent-text underline-offset-2 hover:underline"
        >
          Back to current
        </button>
      )}
    </div>
  );
}

/**
 * The Person's full transaction workspace — the Person workspace grown to most of the viewport.
 * Fixed: title and position, period, actions, search and filters; scrolling: only the ledger body.
 * Add opens in place above the ledger. Settle Balance and Split Expense navigate within this same
 * workspace (← Back to Transactions) using the existing flows; this component stays mounted meanwhile,
 * so search, filter, expanded rows and scroll position are exactly as left. Period and cycle are the
 * Person workspace's shared state, so this view always shows what the compact view showed.
 */
export function TransactionLedgerMode({
  personId,
  personName,
  rows,
  carriedRows = [],
  isLoading,
  scope,
  onScopeChange,
  counts,
  cycle,
  onCycleChange,
  statement,
  balance,
  onClose,
  handlers,
  lookups,
  cycleLabelOf,
  view,
  onViewChange,
  addSection,
  addOpen,
  onAddToggle,
  renderSettle,
  renderSplit,
  deleteAllCount,
  carriedForward = null,
  onDeleteAll,
}: {
  personId: string;
  personName: string;
  rows: LedgerRow[];
  /** Cycle scope: obligations from earlier cycles that are still open. */
  carriedRows?: LedgerRow[];
  isLoading: boolean;
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  counts: Record<LedgerScope, number>;
  cycle: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  /** The selected cycle's statement — the fixed header's position and reconciliation. */
  statement: PersonCycleStatement | null;
  /** Overall position across every cycle. */
  /** `toReceive`/`toGive`: the gross sides (engine) — shown separately whenever both are open. */
  balance: { direction: StatementDirection; amount: number; toReceive?: number; toGive?: number } | null;
  onClose: () => void;
  handlers: LedgerRowHandlers;
  lookups: SettlementLookupsWithAccounts;
  cycleLabelOf: (d: Date) => string;
  view: LedgerView;
  onViewChange: (view: LedgerView) => void;
  /** The existing Add panel, opened in place above the ledger. */
  addSection?: React.ReactNode;
  addOpen: boolean;
  onAddToggle: () => void;
  /** The existing Settle / Split flows, shown in place of the ledger; `back` returns to Transactions. */
  renderSettle?: (back: () => void) => React.ReactNode;
  renderSplit?: (back: () => void) => React.ReactNode;
  deleteAllCount: number;
  /** The selected cycle's previous pending (engine value) — shown while viewing that cycle. */
  carriedForward?: { amount: number; direction: "theyOwe" | "iOwe" } | null;
  onDeleteAll?: () => void;
}) {
  const [status, setStatus] = useState<SettlementStatusFilter>("all");
  const [type, setType] = useState<SettlementTypeFilter>("all");
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const bodyRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  // Coming back from Settle / Split: put the ledger back where it was.
  useLayoutEffect(() => {
    if (view === "transactions" && bodyRef.current) bodyRef.current.scrollTop = savedScroll.current;
  }, [view]);

  /** Leaving the ledger for Settle / Split — remember where it was scrolled. */
  const openFlow = (next: Exclude<LedgerView, "transactions">) => {
    savedScroll.current = bodyRef.current?.scrollTop ?? 0;
    setDirection("forward");
    onViewChange(next);
  };
  const backToTransactions = () => {
    setDirection("back");
    onViewChange("transactions");
  };

  const firstName = personName.split(" ")[0];
  const visible = applySettlementFilters(filterLedgerRows(rows, "all", search), status, type, lookups);
  const carried = scope === "cycle" && !isLoading ? applySettlementFilters(filterLedgerRows(carriedRows, "all", search), status, type, lookups) : [];
  // The fixed position: the selected cycle's statement in cycle view, the overall balance in all-time view.
  const position =
    scope === "cycle" && statement ? { direction: statement.direction, amount: statement.amount, toReceive: statement.toReceive, toGive: statement.toGive } : balance;
  const bothSides = (position?.toReceive ?? 0) > 0 && (position?.toGive ?? 0) > 0;
  const positionTone = position?.direction === "theyOwe" ? "text-settle-receivable-text" : position?.direction === "iOwe" ? "text-settle-payable-text" : "text-success";
  const PositionIcon = position?.direction === "theyOwe" ? ArrowDownLeft : position?.direction === "iOwe" ? ArrowUpRight : Check;
  const headline = position?.direction === "theyOwe" ? `You need to receive from ${firstName}` : position?.direction === "iOwe" ? `You need to give to ${firstName}` : "All settled";

  const slide = cn("animate-in duration-[220ms] ease-out fade-in-0", direction === "forward" ? "slide-in-from-right-4" : "slide-in-from-left-4");

  if (view !== "transactions") {
    const content = view === "settle" ? renderSettle?.(backToTransactions) : renderSplit?.(backToTransactions);
    return (
      <div key={view} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", slide)}>
        {view === "split" ? <div className="mx-auto w-full max-w-5xl">{content}</div> : content}
      </div>
    );
  }

  return (
    <div key="transactions" className={cn("flex h-full min-h-0 flex-col", direction === "back" && slide)}>
      {/* ── Fixed: who, settlement position, cycle reconciliation, period ── */}
      <div className={cn(WS_PAD, "shrink-0 border-b border-border-strong/75 pt-3.5 pb-3")}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {personName} <span className="font-medium text-foreground/65">· {scope === "cycle" ? `Settlement · ${formatCycleLabel(cycle)}` : "All cycles"}</span>
            </p>
            {position && bothSides ? (
              // Two independent obligations: both gross, each settled on its own — never one netted figure.
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <span className="inline-flex items-baseline gap-2">
                  <span className="text-[12px] font-bold tracking-[0.08em] text-settle-receivable-text uppercase">You need to receive</span>
                  <span className="font-heading text-[24px] leading-none font-bold tracking-tight tabular-nums text-settle-receivable-text sm:text-[28px]">{money(position.toReceive ?? 0)}</span>
                </span>
                <span className="inline-flex items-baseline gap-2">
                  <span className="text-[12px] font-bold tracking-[0.08em] text-settle-payable-text uppercase">You need to give</span>
                  <span className="font-heading text-[24px] leading-none font-bold tracking-tight tabular-nums text-settle-payable-text sm:text-[28px]">{money(position.toGive ?? 0)}</span>
                </span>
                <span className="text-xs font-medium text-foreground/65">Tracked separately</span>
              </div>
            ) : position ? (
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-bold tracking-[0.08em] uppercase", positionTone)}>
                  <PositionIcon className="size-4" strokeWidth={2.5} aria-hidden />
                  {headline}
                </span>
                <span className={cn("font-heading text-[28px] leading-none font-bold tracking-tight tabular-nums sm:text-[32px]", position.direction === "settled" ? "text-foreground" : positionTone)}>
                  {money(position.amount)}
                </span>
                {scope === "cycle" && balance && (
                  <span className="text-xs font-medium text-foreground/65">
                    Overall {balance.direction === "settled" ? "settled" : `${balance.direction === "theyOwe" ? `you need to receive ${money(balance.amount)} from ${firstName}` : `you need to give ${money(balance.amount)} to ${firstName}`}`}
                  </span>
                )}
              </div>
            ) : (
              <div className="mt-2 h-9 w-48 animate-pulse rounded-[6px] bg-secondary" />
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <ScopeSwitch scope={scope} onScopeChange={onScopeChange} counts={counts} cycleLabel="Selected cycle" />
              {scope === "cycle" ? (
                <CycleNavigator cycle={cycle} onCycleChange={onCycleChange} />
              ) : (
                <span className="text-[13px] font-medium text-foreground/70">Complete history with {firstName}</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-5">
            {scope === "cycle" && statement && !isLoading && (
              <div className="hidden w-[19rem] border-l border-border-strong/75 pl-5 lg:block">
                <CycleReconciliation statement={statement} personName={personName} />
              </div>
            )}
            <button type="button" onClick={onClose} className={cn(WS_SECONDARY, "h-8 shrink-0 px-3")}>
              <ArrowLeft className="size-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Back to page</span>
              <span className="sm:hidden">Back</span>
            </button>
          </div>
        </div>
        {scope === "cycle" && !isLoading && carriedRows.length === 0 && <CarriedForwardNote carried={carriedForward} personName={personName} className="mt-2.5 max-w-3xl" />}
      </div>

      {/* ── Fixed: toolbar — search & filters, actions on the right ── */}
      <div className={cn(WS_PAD, "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-strong/75 bg-secondary/80 py-2")}>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground/55" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description or type…"
            aria-label="Search transactions"
            className="h-7 w-full rounded-[6px] border border-border-strong bg-card pr-3 pl-8 text-[13px] text-foreground outline-none transition-colors placeholder:text-foreground/50 focus:border-primary-accent-text"
          />
        </div>
        <SettlementFilters rows={[...carriedRows, ...rows]} lookups={lookups} status={status} onStatusChange={setStatus} type={type} onTypeChange={setType} />
        <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
          {onDeleteAll && (
            <button
              type="button"
              onClick={onDeleteAll}
              disabled={deleteAllCount === 0}
              className="flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-xs font-semibold text-foreground/70 outline-none transition-colors hover:bg-expense/8 hover:text-expense focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
            >
              <ListX className="size-4" strokeWidth={1.75} />
              Delete all
            </button>
          )}
          {renderSettle && (
            <button type="button" onClick={() => openFlow("settle")} title="Record a payment against the overall balance" className={cn(WS_SECONDARY, "h-7 px-2.5 text-[12.5px]")}>
              <HandCoins className="size-4" strokeWidth={1.75} />
              Record payment
            </button>
          )}
          {renderSplit && (
            <button type="button" onClick={() => openFlow("split")} className={cn(WS_SECONDARY, "h-7 px-2.5 text-[12.5px]")}>
              <Split className="size-4" strokeWidth={1.75} />
              Split expense
            </button>
          )}
          {addSection && (
            <button
              type="button"
              onClick={() => {
                if (!addOpen) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                onAddToggle();
              }}
              aria-expanded={addOpen}
              className={cn(WS_PRIMARY, "h-7 px-2.5 text-[12.5px]")}
            >
              <Plus className={cn("size-4 transition-transform duration-200", addOpen && "rotate-45")} strokeWidth={2.25} />
              {addOpen ? "Close" : "Add transaction"}
            </button>
          )}
        </div>
      </div>

      {/* ── Scrolling: the ledger body only ── */}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {/* Add opens at the top of the one scrolling region — no second scrollbar in the fixed header */}
        {addSection && (
          <InlineReveal open={addOpen}>
            <div className={cn(WS_PAD, "border-b border-border-strong/75 bg-secondary/70 py-4")}>
              <div className="max-w-4xl">{addSection}</div>
            </div>
          </InlineReveal>
        )}
        <SettlementTable
          personId={personId}
          personName={personName}
          rows={visible}
          carriedRows={carried}
          isLoading={isLoading}
          lookups={lookups}
          accountForEntry={lookups.accountForEntry}
          handlers={handlers}
          linkedTrail={linkedTrailFor(lookups, personName)}
          cycleLabelOf={cycleLabelOf}
          empty={
            <p className={cn(WS_PAD, "py-6 text-sm font-medium text-foreground/75")}>
              {rows.length === 0 && carriedRows.length === 0
                ? scope === "cycle"
                  ? `No activity with ${firstName} between ${formatCycleLabel(cycle)}.`
                  : `No transactions with ${firstName} yet.`
                : "No transactions match this search or filter."}
            </p>
          }
        />
        {scope === "cycle" && statement && !isLoading && (
          <CyclePaymentHistory statement={statement} personName={personName} accountForEntry={lookups.accountForEntry} incomeForEntry={lookups.incomeForEntry} className={cn(WS_PAD, "max-w-4xl py-4")} />
        )}
      </div>
    </div>
  );
}

/** "← Back to Transactions" label for the flows opened from the expanded ledger. */
export const BACK_TO_TRANSACTIONS = "Back to Transactions";

