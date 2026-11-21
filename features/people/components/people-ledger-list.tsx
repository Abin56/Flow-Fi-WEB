"use client";

import { useState } from "react";
import {
  ArrowDownUp,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PEOPLE_SORTS, type PeopleSort } from "@/features/people/lib/people-sort";
import { FilterTabs, LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import {
  cycleContaining,
  formatCycleLabel,
  sameCycle,
  shiftCycle,
  type PersonCycleStatement,
  type StatementCycle,
  type StatementDirection,
} from "@/lib/engines/person-cycle-statement";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import { cn } from "@/lib/utils";
import { DateInput } from "@/components/forms/date-input";

/**
 * People Ledger list controls — the cycle navigator, the cycle totals and the search / filter toolbar. The people
 * themselves are drawn by `PeopleLedgerGrid` (cards) and the cycle overview by `PeopleCycleOverview`; every figure
 * is read straight from each person's `PersonCycleStatement`.
 */

export type PeopleFilter = "all" | StatementDirection;

export interface PeopleLedgerRow {
  id: string;
  name: string;
  statement: PersonCycleStatement;
  /** Newest ledger activity (any cycle) — display + "Recent activity" sort only. */
  lastActive?: Date | null;
  lastActiveLabel?: string;
}

const FILTERS: { value: PeopleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "theyOwe", label: "You need to receive" },
  { value: "iOwe", label: "You need to give" },
  { value: "settled", label: "Settled" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
 * cycle starting in it on the global start day — the engine's own `cycleContaining`) and a date field that resolves any
 * date to the cycle containing it. Nothing after the current cycle is reachable.
 */
export function PeopleCycleControl({
  cycle,
  onCycleChange,
  direction,
  isFollowingGlobalCycle,
  onFollowGlobalCycle,
}: {
  cycle: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  direction: -1 | 0 | 1;
  /** Whether this list is showing the same cycle as the top-bar's global navigator. Omit to hide the sync affordance (e.g. a scoped sub-view). */
  isFollowingGlobalCycle?: boolean;
  onFollowGlobalCycle?: () => void;
}) {
  const startDay = useMonthCycleStartDay();
  const current = cycleContaining(new Date(), startDay);
  const isCurrent = sameCycle(cycle, current);
  // Whole days from today to the cycle's last day (inclusive) — display only, from the cycle's own end date.
  const daysLeft = isCurrent ? Math.max(0, Math.round((cycle.end.getTime() - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()) / 86_400_000)) : null;
  const navButton = cn(
    LE_RADIUS.control,
    "flex h-9 shrink-0 cursor-pointer items-center gap-1 px-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent",
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 sm:flex-none">
        <button
          type="button"
          aria-label="Previous cycle"
          onClick={() => onCycleChange(shiftCycle(cycle, -1, startDay))}
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
          onClick={() => onCycleChange(shiftCycle(cycle, 1, startDay))}
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
          {daysLeft != null && (
            <span className="font-medium text-muted-foreground tabular-nums">
              · {daysLeft === 0 ? "last day" : `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`}
            </span>
          )}
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

      {isFollowingGlobalCycle === false && (
        <button
          type="button"
          onClick={onFollowGlobalCycle}
          className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-dashed border-border-strong px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          Sync with top-bar cycle
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
  const startDay = useMonthCycleStartDay();
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
              className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
            >
              <ChevronRight className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1 p-2">
          {MONTHS.map((label, m) => {
            // The cycle opening in this month (on the global start day, clamped) — resolved by the engine.
            const target = cycleContaining(new Date(year, m, Math.min(startDay, new Date(year, m + 1, 0).getDate())), startDay);
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
                  "flex h-11 cursor-pointer flex-col items-center justify-center rounded-[6px] border text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground/70",
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
            if (d) pick(cycleContaining(d, startDay));
          }}
        >
          <label htmlFor="people-cycle-date" className="text-[11px] font-medium text-muted-foreground">
            Jump to the cycle containing a date
          </label>
          <div className="flex gap-2">
            <DateInput
              id="people-cycle-date"
              wrapperClassName="min-w-0 flex-1"
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
              Opens {formatCycleLabel(cycleContaining(parseDateInput(dateValue)!, startDay))}
            </p>
          )}
        </form>

        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <span className="text-[11px] text-muted-foreground">{startDay <= 1 ? "Cycles follow calendar months" : `Cycles run ${ordinalDay(startDay)} → ${ordinalDay(startDay - 1)}`}</span>
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
 * The selected cycle's totals by direction, GROSS — each person's `toReceive` and `toGive` (engine), never
 * their net. A person who owes me ₹1,000 while I owe them ₹500 adds ₹1,000 to receive AND ₹500 to give
 * (and counts on both sides): the two are settled separately. An unapplied advance a person paid me is
 * held money — its own total (`advanceBalance`, engine), never added to "to give" or taken off "to receive".
 */
export function cycleTotals(rows: PeopleLedgerRow[]) {
  let toReceive = 0;
  let receiveCount = 0;
  let toPay = 0;
  let payCount = 0;
  let activity = 0;
  let advanceHeld = 0;
  let advanceHeldCount = 0;
  for (const r of rows) {
    activity += r.statement.rows.length;
    const adv = r.statement.advanceBalance ?? 0;
    if (adv < 0) {
      advanceHeld -= adv;
      advanceHeldCount += 1;
    }
    if (r.statement.toReceive > 0) {
      toReceive += r.statement.toReceive;
      receiveCount += 1;
    }
    if (r.statement.toGive > 0) {
      toPay += r.statement.toGive;
      payCount += 1;
    }
  }
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return { toReceive: round2(toReceive), receiveCount, toPay: round2(toPay), payCount, advanceHeld: round2(advanceHeld), advanceHeldCount, activity };
}

// ---------------------------------------------------------------------------------------------------
// Toolbar

/** Search, direction filters (with selected-cycle counts) and the sort menu — one compact row. */
export function PeopleListToolbar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  counts,
  sort,
  onSortChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  filter: PeopleFilter;
  onFilterChange: (value: PeopleFilter) => void;
  counts: Record<PeopleFilter, number>;
  sort: PeopleSort;
  onSortChange: (value: PeopleSort) => void;
}) {
  const sortLabel = PEOPLE_SORTS.find((s) => s.value === sort)?.label ?? "Sort";
  return (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
      <div className="relative w-full sm:max-w-56">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
        />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search people"
          aria-label="Search people"
          className="h-9 w-full rounded-full border border-border-strong bg-card pr-8 pl-9 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-tertiary-foreground hover:border-muted-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring dark:bg-input"
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Sort people: ${sortLabel}`}
            className="ml-auto inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary-accent-text"
          >
            <ArrowDownUp className="size-3.5 text-muted-foreground" strokeWidth={2} aria-hidden />
            <span className="text-muted-foreground">Sort</span>
            {sortLabel}
            <ChevronDown className="size-3.5 text-muted-foreground" strokeWidth={2} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 rounded-[10px]">
          <DropdownMenuLabel className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Sort people</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSortChange(v as PeopleSort)}>
            {PEOPLE_SORTS.map((s) => (
              <DropdownMenuRadioItem key={s.value} value={s.value} className="cursor-pointer">
                {s.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
