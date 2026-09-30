"use client";

import { Maximize2, Plus, Search } from "lucide-react";
import { useState } from "react";
import type { EntryEditValues, EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { WS_SECONDARY } from "@/features/people/components/workspace/person-workspace-ui";
import { applySettlementFilters, CyclePaymentHistory, SettledCycleNote, SettlementFilters } from "@/features/people/components/workspace/settlement-summary";
import { SettlementTable } from "@/features/people/components/workspace/settlement-table";
import type { SettlementLookupsWithAccounts } from "@/features/people/hooks/use-settlement-lookups";
import { filterLedgerRows, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import type { SettlementStatusFilter, SettlementTypeFilter } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

export type LedgerScope = "cycle" | "all";

/**
 * "Previous pending ₹500 · carried forward" — the selected cycle's opening balance from earlier cycles
 * (the engine's `previousPending`), so old unpaid money never reads as new activity. Shown when no
 * individual open item from earlier cycles can be listed (e.g. a lump balance).
 */
export function CarriedForwardNote({
  carried,
  personName,
  className,
}: {
  carried: { amount: number; direction: "theyOwe" | "iOwe" } | null;
  personName: string;
  className?: string;
}) {
  if (carried == null) return null;
  const first = personName.split(" ")[0];
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-[6px] border-l-[3px] border-settle-carried-edge bg-settle-carried-tint px-3 py-1.5 text-xs", className)}>
      <span className="font-bold tracking-[0.06em] text-settle-carried-text uppercase">Brought forward</span>
      <span className="font-heading text-sm font-bold text-foreground tabular-nums">{money(carried.amount)}</span>
      <span className="font-medium text-foreground/75">
        {carried.direction === "theyOwe" ? `${first} owes you` : `You owe ${first}`} · from earlier cycles — not new activity
      </span>
    </div>
  );
}

/** "Selected cycle | All transactions" with counts — shared by the compact list and the expanded ledger. */
export function ScopeSwitch({
  scope,
  onScopeChange,
  counts,
  cycleLabel,
}: {
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  counts: Record<LedgerScope, number>;
  cycleLabel: string;
}) {
  return (
    <div role="tablist" aria-label="Which transactions" className="flex items-center rounded-[8px] border border-border-strong bg-secondary/60 p-[3px] text-xs">
      {(
        [
          ["cycle", cycleLabel],
          ["all", "All transactions"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={scope === value}
          onClick={() => onScopeChange(value)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            scope === value
              ? "bg-card font-semibold text-foreground shadow-[inset_0_0_0_1.5px_var(--color-primary-accent-text)]"
              : "font-medium text-foreground/70 hover:text-foreground",
          )}
        >
          {label}
          <span className="font-medium text-foreground/60 tabular-nums">{counts[value]}</span>
        </button>
      ))}
    </div>
  );
}

export interface LedgerRowHandlers {
  settlingKey: string | null;
  onSettleStart: (row: LedgerRow) => void;
  onSettleCancel: () => void;
  onSettleSubmit: (row: LedgerRow, values: EntrySettleValues) => Promise<void>;
  editingKey?: string | null;
  onEditStart?: (row: LedgerRow) => void;
  onEditCancel?: () => void;
  onEditSubmit?: (row: LedgerRow, values: EntryEditValues) => Promise<void>;
  onDelete?: (row: LedgerRow) => void;
  /** Reverses one recorded payment (its confirmation lives in the workspace). */
  onUndoPayment?: (row: LedgerRow, payment: PaymentRecord) => void;
}

/**
 * The Person workspace's settlement table — the selected cycle (or the whole history) as a
 * reconciliation table with status/type filters, open items brought forward from earlier cycles, and
 * the cycle's payment history. On larger screens the heading and filters stay put and only the table
 * scrolls. Rows, amounts and states come from the statement engine via `buildLedgerRows`.
 */
export function PersonActivityFeed({
  personId,
  personName,
  rows,
  carriedRows = [],
  isLoading,
  scope,
  onScopeChange,
  counts,
  cycleLabel,
  onAdd,
  onExpand,
  handlers,
  lookups,
  statement,
  cycleLabelOf,
  carriedForward = null,
}: {
  personId: string;
  personName: string;
  /** The selected scope's rows, newest first. */
  rows: LedgerRow[];
  /** Cycle scope: obligations from earlier cycles that are still open. */
  carriedRows?: LedgerRow[];
  isLoading: boolean;
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  counts: Record<LedgerScope, number>;
  cycleLabel: string;
  onAdd?: () => void;
  onExpand: () => void;
  handlers: LedgerRowHandlers;
  lookups: SettlementLookupsWithAccounts;
  /** The selected cycle's statement — its payment history and settled state. */
  statement: PersonCycleStatement | null;
  cycleLabelOf: (d: Date) => string;
  /** The selected cycle's previous pending (engine value). */
  carriedForward?: { amount: number; direction: "theyOwe" | "iOwe" } | null;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SettlementStatusFilter>("all");
  const [type, setType] = useState<SettlementTypeFilter>("all");
  const firstName = personName.split(" ")[0];

  const searched = filterLedgerRows(rows, "all", search);
  const visible = applySettlementFilters(searched, status, type, lookups);
  const showCarried = scope === "cycle" && !isLoading;
  const carried = showCarried ? applySettlementFilters(filterLedgerRows(carriedRows, "all", search), status, type, lookups) : [];

  const changeScope = (next: LedgerScope) => {
    onScopeChange(next);
  };

  const empty =
    rows.length === 0 && carriedRows.length === 0 ? (
      <div className="flex flex-col items-start gap-2 px-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold text-foreground">
          {scope === "cycle" ? `No activity with ${firstName} in this cycle.` : `No transactions with ${firstName} yet.`}
        </p>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text"
          >
            <Plus className="size-3.5" strokeWidth={2} />
            Add transaction
          </button>
        )}
      </div>
    ) : (
      <p className="px-3 py-4 text-sm font-medium text-foreground/75">No transactions match this search or filter.</p>
    );

  return (
    <section className="flex min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 pb-2">
        <h2 className="font-heading text-base font-semibold text-foreground">
          Transactions{" "}
          <span className="text-sm font-medium text-foreground/65 tabular-nums">· {counts[scope]}</span>
        </h2>
        <ScopeSwitch scope={scope} onScopeChange={changeScope} counts={counts} cycleLabel={cycleLabel} />
        <SettlementFilters rows={[...carriedRows, ...rows]} lookups={lookups} status={status} onStatusChange={setStatus} type={type} onTypeChange={setType} />
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          {rows.length > 5 && (
            <div className="relative min-w-0 flex-1 sm:w-44 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground/55" strokeWidth={1.75} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                aria-label="Search transactions"
                className="h-7 w-full rounded-[6px] border border-border-strong bg-card pr-3 pl-8 text-[13px] text-foreground outline-none transition-colors placeholder:text-foreground/50 focus:border-primary-accent-text"
              />
            </div>
          )}
          <button type="button" onClick={onExpand} title="Open the full transaction workspace" className={cn(WS_SECONDARY, "h-7 shrink-0 px-2.5 text-[12.5px]")}>
            <Maximize2 className="size-3.5" strokeWidth={1.75} />
            Expand
          </button>
        </div>
      </div>

      {showCarried && statement && <SettledCycleNote statement={statement} personName={personName} />}
      {showCarried && carriedRows.length === 0 && <CarriedForwardNote carried={carriedForward} personName={personName} className="mb-2 shrink-0" />}

      {/* Only the table scrolls on larger screens; its header row sticks */}
      <div
        key={scope}
        className={cn(
          "animate-in overflow-x-hidden rounded-[6px] border border-border-strong/80 duration-200 fade-in-0 sm:max-h-[min(66vh,48rem)] sm:overflow-y-auto sm:overscroll-contain",
          showCarried && statement?.direction === "settled" && "mt-2",
        )}
      >
        <SettlementTable
          personId={personId}
          personName={personName}
          rows={visible}
          carriedRows={carried}
          isLoading={isLoading}
          lookups={lookups}
          accountForEntry={lookups.accountForEntry}
          handlers={handlers}
          empty={empty}
          cycleLabelOf={cycleLabelOf}
        />
      </div>

      {scope === "cycle" && statement && !isLoading && (
        <CyclePaymentHistory statement={statement} personName={personName} accountForEntry={lookups.accountForEntry} incomeForEntry={lookups.incomeForEntry} className="mt-3 max-w-3xl" />
      )}
    </section>
  );
}
