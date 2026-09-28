"use client";

import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterTabs, LE_RADIUS, Money } from "@/features/loans/components/loan-emi-ui";
import {
  PEOPLE_CYCLE_END_DAY,
  cycleContaining,
  directionHeadline,
  formatCycleLabel,
  perspectiveAmount,
  sameCycle,
  shiftCycle,
  type PersonCycleStatement,
  type StatementCycle,
  type StatementDirection,
} from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * The People Ledger list — one row per person for the selected cycle, read straight from that
 * person's `PersonCycleStatement` (previous pending → this cycle → settlements → current pending).
 * Amounts are shown from the side of the closing position (`perspectiveAmount`), so "₹500" under
 * "You owe them" means you owe ₹500; the direction is always said in words, colour only supports it.
 */

export type PeopleFilter = "all" | StatementDirection;

export interface PeopleLedgerRow {
  id: string;
  name: string;
  statement: PersonCycleStatement;
}

const FILTERS: { value: PeopleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "theyOwe", label: "They owe you" },
  { value: "iOwe", label: "You owe them" },
  { value: "settled", label: "Settled" },
];

const DIRECTION_TONE: Record<
  StatementDirection,
  { label: string; edge: string; icon: typeof Check }
> = {
  theyOwe: { label: "text-success", edge: "bg-success", icon: ArrowDownLeft },
  iOwe: { label: "text-expense", edge: "bg-expense", icon: ArrowUpRight },
  settled: { label: "text-muted-foreground", edge: "bg-transparent", icon: Check },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const hasValue = (v: number) => Math.abs(v) >= 0.005;
const signed = (v: number) => (v > 0 ? `+${money(v)}` : money(v));

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

/** "2026-08-05" → local midnight, or null. */
function parseDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------
// Cycle navigator

/**
 * Previous / label / Next, with the label opening a quick picker: a month grid (each month opens the
 * cycle starting on its 18th — the engine's own `cycleContaining`) and a date field that resolves any
 * date to the cycle containing it. Nothing after the current cycle is reachable.
 */
export function PeopleCycleControl({
  cycle,
  onCycleChange,
  direction,
}: {
  cycle: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  direction: -1 | 0 | 1;
}) {
  const current = cycleContaining(new Date());
  const isCurrent = sameCycle(cycle, current);
  const navButton = cn(
    LE_RADIUS.control,
    "flex h-9 shrink-0 cursor-pointer items-center gap-1 px-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-transparent",
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 sm:flex-none">
        <button
          type="button"
          aria-label="Previous cycle"
          onClick={() => onCycleChange(shiftCycle(cycle, -1))}
          className={navButton}
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
          <span className="hidden sm:inline">Previous</span>
        </button>

        <CyclePicker cycle={cycle} current={current} onCycleChange={onCycleChange} direction={direction} />

        <button
          type="button"
          aria-label="Next cycle"
          disabled={isCurrent}
          onClick={() => onCycleChange(shiftCycle(cycle, 1))}
          className={navButton}
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      {isCurrent ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <span className="size-1.5 rounded-full bg-primary-accent-text" aria-hidden />
          Current cycle
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onCycleChange(current)}
          className={cn(
            LE_RADIUS.control,
            "inline-flex h-8 cursor-pointer items-center gap-1.5 border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <RotateCcw className="size-3.5" strokeWidth={2} />
          Back to current
        </button>
      )}
    </div>
  );
}

export function CyclePicker({
  cycle,
  current,
  onCycleChange,
  direction,
}: {
  cycle: StatementCycle;
  current: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  direction: -1 | 0 | 1;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(cycle.start.getFullYear());
  const [dateValue, setDateValue] = useState("");
  const today = new Date();
  const maxYear = current.start.getFullYear();

  function pick(next: StatementCycle) {
    onCycleChange(next);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setYear(cycle.start.getFullYear());
          setDateValue("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Selected cycle ${formatCycleLabel(cycle)} — choose another`}
          className={cn(
            LE_RADIUS.control,
            "flex h-10 min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 overflow-hidden border border-border-strong bg-card px-3 outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary-accent-text sm:min-w-[15rem] sm:flex-none",
          )}
        >
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span
            key={cycle.start.getTime()}
            aria-live="polite"
            className={cn(
              "truncate font-heading text-[15px] font-semibold tracking-tight text-foreground tabular-nums animate-in fade-in duration-200 ease-out",
              direction < 0 && "slide-in-from-left-2",
              direction > 0 && "slide-in-from-right-2",
            )}
          >
            {formatCycleLabel(cycle)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] rounded-[10px] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold text-foreground">Select cycle</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="Previous year"
              onClick={() => setYear((y) => y - 1)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft className="size-4" strokeWidth={1.75} />
            </button>
            <span className="w-11 text-center text-sm font-semibold tabular-nums">{year}</span>
            <button
              type="button"
              aria-label="Next year"
              disabled={year >= maxYear}
              onClick={() => setYear((y) => y + 1)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
            >
              <ChevronRight className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1 p-2">
          {MONTHS.map((label, m) => {
            // The cycle opening on this month's 18th — resolved by the engine, never recomputed here.
            const target = cycleContaining(new Date(year, m, PEOPLE_CYCLE_END_DAY + 1));
            const future = target.start.getTime() > current.start.getTime();
            const selected = sameCycle(target, cycle);
            const isNow = sameCycle(target, current);
            return (
              <button
                key={label}
                type="button"
                disabled={future}
                onClick={() => pick(target)}
                title={formatCycleLabel(target)}
                className={cn(
                  "flex h-11 cursor-pointer flex-col items-center justify-center rounded-[6px] border text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground/40",
                  selected
                    ? "border-primary-accent-text bg-primary font-semibold text-primary-foreground"
                    : "border-transparent font-medium text-foreground hover:bg-secondary disabled:hover:bg-transparent",
                )}
              >
                {label}
                <span
                  className={cn(
                    "text-[10px] leading-none tabular-nums",
                    selected ? "text-primary-foreground/80" : "text-muted-foreground",
                    future && "opacity-40",
                  )}
                >
                  {isNow ? "Current" : " "}
                </span>
              </button>
            );
          })}
        </div>

        <form
          className="flex flex-col gap-1.5 border-t border-border px-3 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            const d = parseDateInput(dateValue);
            if (d) pick(cycleContaining(d));
          }}
        >
          <label htmlFor="people-cycle-date" className="text-[11px] font-medium text-muted-foreground">
            Jump to the cycle containing a date
          </label>
          <div className="flex gap-2">
            <input
              id="people-cycle-date"
              type="date"
              max={toDateInput(today)}
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              className="h-9 min-w-0 flex-1 rounded-[6px] border border-border-strong bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary-accent-text focus:ring-2 focus:ring-ring dark:bg-input"
            />
            <button
              type="submit"
              disabled={!parseDateInput(dateValue)}
              className="h-9 cursor-pointer rounded-[6px] border border-primary-accent-text bg-primary px-3 text-sm font-semibold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              Go
            </button>
          </div>
          {parseDateInput(dateValue) && (
            <p className="text-xs text-muted-foreground tabular-nums">
              Opens {formatCycleLabel(cycleContaining(parseDateInput(dateValue)!))}
            </p>
          )}
        </form>

        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <span className="text-[11px] text-muted-foreground">Cycles run 18th → 17th</span>
          <button
            type="button"
            onClick={() => pick(current)}
            className="h-7 cursor-pointer rounded-[6px] px-2 text-xs font-semibold text-primary-accent-text outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          >
            Current cycle
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------------
// Cycle summary

/**
 * Total to receive for the selected cycle — the sum of every row's current pending where the engine says
 * "They owe you" (`direction === "theyOwe"`, `amount = |currentPending|`). Never netted against what the
 * user owes; that figure is shown beside it, from the same rows.
 */
export function cycleTotals(rows: PeopleLedgerRow[]) {
  let toReceive = 0;
  let receiveCount = 0;
  let toPay = 0;
  let payCount = 0;
  let activity = 0;
  for (const r of rows) {
    activity += r.statement.rows.length;
    if (r.statement.direction === "theyOwe") {
      toReceive += r.statement.amount;
      receiveCount += 1;
    } else if (r.statement.direction === "iOwe") {
      toPay += r.statement.amount;
      payCount += 1;
    }
  }
  return { toReceive, receiveCount, toPay, payCount, activity };
}

export function PeopleCycleSummary({ rows }: { rows: PeopleLedgerRow[] }) {
  const { toReceive, receiveCount, toPay, payCount, activity } = cycleTotals(rows);

  return (
    <section
      aria-label="Cycle summary"
      className={cn(LE_RADIUS.panel, "flex flex-col border border-border bg-card shadow-e1 sm:flex-row sm:items-stretch")}
    >
      <div className="flex flex-1 flex-col gap-1.5 px-5 py-4 sm:px-6">
        <span className={LABEL}>To receive this cycle</span>
        <Money amount={Math.round(toReceive)} className="text-[32px] leading-none text-foreground sm:text-[38px]" />
        <span className="text-xs text-muted-foreground">
          {receiveCount === 0
            ? "No one owes you at the end of this cycle"
            : `Across ${receiveCount} ${receiveCount === 1 ? "person" : "people"}`}
        </span>
      </div>
      <div className="grid grid-cols-2 border-t border-border sm:w-80 sm:border-t-0 sm:border-l">
        <div className="flex flex-col gap-1 px-5 py-3.5 sm:justify-center">
          <span className={LABEL}>You owe</span>
          <Money amount={Math.round(toPay)} className={cn("text-lg leading-none", toPay > 0 ? "text-expense" : "text-muted-foreground")} />
          <span className="text-xs text-muted-foreground">
            {payCount === 0 ? "Nothing" : `${payCount} ${payCount === 1 ? "person" : "people"}`}
          </span>
        </div>
        <div className="flex flex-col gap-1 border-l border-border px-5 py-3.5 sm:justify-center">
          <span className={LABEL}>Activity</span>
          <span className="font-heading text-lg leading-none font-bold text-foreground tabular-nums">{activity}</span>
          <span className="text-xs text-muted-foreground">
            {activity === 1 ? "entry" : "entries"} this cycle
          </span>
        </div>
      </div>
    </section>
  );
}

export function PeopleCycleSummarySkeleton() {
  return (
    <div className={cn(LE_RADIUS.panel, "flex flex-col gap-2 border border-border bg-card px-5 py-4 sm:px-6")}>
      <Skeleton className="h-3 w-36" />
      <Skeleton className="h-9 w-44" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Toolbar

/** Search on the left, direction filters (with selected-cycle counts) on the right. */
export function PeopleListToolbar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  counts,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  filter: PeopleFilter;
  onFilterChange: (value: PeopleFilter) => void;
  counts: Record<PeopleFilter, number>;
}) {
  return (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full sm:max-w-60">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
        />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search people"
          aria-label="Search people"
          className="h-9 w-full rounded-[6px] border border-border-strong bg-card pr-8 pl-9 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-tertiary-foreground hover:border-muted-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring dark:bg-input"
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearchChange("")}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        )}
      </div>
      <FilterTabs
        ariaLabel="Filter by direction"
        value={filter}
        onChange={onFilterChange}
        options={FILTERS.map((f) => ({ ...f, count: counts[f.value] }))}
        className="w-full overflow-x-auto sm:w-auto"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Person row

function Figure({
  label,
  value,
  sub,
  muted,
}: {
  label: string;
  value: string;
  sub?: string | null;
  muted: boolean;
}) {
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="text-[11px] font-medium text-muted-foreground md:hidden">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>
        {value}
      </span>
      {sub && <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{sub}</span>}
    </span>
  );
}

/** Shared desktop column template — the header row and every person row use it. */
const ROW_GRID = "md:grid-cols-[minmax(0,1fr)_7rem_8rem_10rem_1rem] md:gap-x-5";

function PersonRow({
  row,
  onOpen,
  index,
}: {
  row: PeopleLedgerRow;
  onOpen: () => void;
  index: number;
}) {
  const s = row.statement;
  const tone = DIRECTION_TONE[s.direction];
  const DirIcon = tone.icon;
  const previous = perspectiveAmount(s, s.previousPending);
  const activity = perspectiveAmount(s, s.cycleActivity);
  const settled = perspectiveAmount(s, s.cycleSettlements);
  const n = s.rows.length;
  const isSettled = s.direction === "settled";
  const activityText = hasValue(activity) ? signed(activity) : money(0);
  const settledText = hasValue(settled) ? `Settled ${signed(settled)}` : null;

  return (
    <li
      className="animate-in fade-in fill-mode-both duration-200 ease-out"
      style={{ animationDelay: `${Math.min(index, 8) * 20}ms` }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${row.name}'s ledger — ${directionHeadline(s.direction)}${isSettled ? "" : ` ${money(s.amount)}`}`}
        className={cn(
          "group relative grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3.5 text-left outline-none transition-colors duration-150 hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5",
          ROW_GRID,
        )}
      >
        <span className={cn("absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full", tone.edge)} aria-hidden />

        {/* Identity */}
        <span className="flex min-w-0 items-center gap-3">
          <ClayAvatar name={row.name} size={36} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-heading text-[15px] leading-tight font-semibold text-foreground">{row.name}</span>
            <span className="text-xs text-muted-foreground">
              {n === 0 ? "No activity" : `${n} ${n === 1 ? "activity" : "activities"}`}
            </span>
          </span>
        </span>

        {/* Desktop: previous + this cycle columns */}
        <span className="hidden md:block">
          <Figure label="Previous" value={money(previous)} muted={!hasValue(previous)} />
        </span>
        <span className="hidden md:block">
          <Figure label="This cycle" value={activityText} sub={settledText} muted={!hasValue(activity)} />
        </span>

        {/* Current pending + who owes whom */}
        <span className="flex flex-col items-end gap-0.5">
          <span
            key={`${s.cycle.start.getTime()}-${s.currentPending}`}
            className={cn(
              "font-heading text-xl leading-tight font-bold tracking-tight tabular-nums animate-in fade-in duration-200",
              isSettled ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {money(s.amount)}
          </span>
          <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", tone.label)}>
            <DirIcon className="size-3.5" strokeWidth={2} aria-hidden />
            {directionHeadline(s.direction)}
          </span>
        </span>

        <ChevronRight
          className="hidden size-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground md:block"
          strokeWidth={2}
          aria-hidden
        />

        {/* Phone / tablet: the trail on one line under the name */}
        <span className="col-span-2 flex flex-wrap gap-x-1.5 pl-12 text-xs text-muted-foreground tabular-nums md:hidden">
          <span>
            Previous <span className="font-semibold text-foreground">{money(previous)}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            This cycle <span className="font-semibold text-foreground">{activityText}</span>
          </span>
          {settledText && (
            <>
              <span aria-hidden>·</span>
              <span className="font-semibold text-foreground">{settledText}</span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

export function PeopleLedgerList({
  rows,
  onOpen,
}: {
  rows: PeopleLedgerRow[];
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <div className={cn("hidden border-b border-border px-5 py-2 md:grid", ROW_GRID)} aria-hidden>
        <span className={LABEL}>Person</span>
        <span className={cn(LABEL, "text-right")}>Previous</span>
        <span className={cn(LABEL, "text-right")}>This cycle</span>
        <span className={cn(LABEL, "text-right")}>Current pending</span>
        <span />
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row, i) => (
          <PersonRow key={row.id} row={row} index={i} onOpen={() => onOpen(row.id)} />
        ))}
      </ul>
    </div>
  );
}

export function PeopleLedgerListSkeleton() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-4">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="ml-auto flex flex-col items-end gap-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
