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
  Activity,
  Wallet,
  X,
} from "lucide-react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { cyclePosition } from "@/features/people/lib/settlement-presentation";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterTabs, LE_RADIUS, Money } from "@/features/loans/components/loan-emi-ui";
import {
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
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import { cn } from "@/lib/utils";
import { DateInput } from "@/components/forms/date-input";

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
  { value: "theyOwe", label: "You need to receive" },
  { value: "iOwe", label: "You need to give" },
  { value: "settled", label: "Settled" },
];

const DIRECTION_TONE: Record<
  StatementDirection,
  { label: string; edge: string; icon: typeof Check; ring: string }
> = {
  theyOwe: { label: "text-success", edge: "bg-success", icon: ArrowDownLeft, ring: "ring-success/60" },
  iOwe: { label: "text-expense", edge: "bg-expense", icon: ArrowUpRight, ring: "ring-expense/55" },
  settled: { label: "text-muted-foreground", edge: "bg-transparent", icon: Check, ring: "ring-border" },
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
 * cycle starting in it on the global start day — the engine's own `cycleContaining`) and a date field that resolves any
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
  const startDay = useMonthCycleStartDay();
  const current = cycleContaining(new Date(), startDay);
  const isCurrent = sameCycle(cycle, current);
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

export function PeopleCycleSummary({ rows }: { rows: PeopleLedgerRow[] }) {
  const { toReceive, receiveCount, toPay, payCount, advanceHeld, advanceHeldCount, activity } = cycleTotals(rows);
  // Receive vs give as one bar — display only, from the same cycle totals (never netted into one figure).
  const both = toReceive + toPay;
  const receivePct = both > 0 ? (toReceive / both) * 100 : 0;

  return (
    <section aria-label="Cycle summary" className="@container overflow-hidden rounded-[16px] border border-border bg-card shadow-e1">
      <div className="flex flex-col @3xl:flex-row @3xl:items-stretch">
        {/* Hero */}
        <div className="relative flex flex-col gap-1.5 overflow-hidden bg-gradient-to-br from-[#1d2330] via-[#262e3d] to-[#323b4d] px-5 py-5 text-white sm:px-6 @3xl:min-w-[20rem] @3xl:flex-1">
          <span aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-success/25 blur-3xl" />
          <span aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-52 rounded-full border border-white/10" />
          <span className="relative text-[11px] font-semibold tracking-[0.08em] text-white/75 uppercase">You need to receive · this cycle</span>
          <Money amount={Math.round(toReceive)} className="relative text-[36px] leading-none text-white sm:text-[40px]" />
          <span className="relative text-xs text-white/70">
            {receiveCount === 0
              ? "Nothing to receive at the end of this cycle"
              : `Across ${receiveCount} ${receiveCount === 1 ? "person" : "people"}`}
          </span>
          {both > 0 && (
            <div className="relative mt-2 flex flex-col gap-1.5">
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/15" aria-hidden>
                <span className="h-full bg-success transition-[width] duration-700" style={{ width: `${receivePct}%` }} />
                <span className="h-full bg-expense transition-[width] duration-700" style={{ width: `${100 - receivePct}%` }} />
              </div>
              <p className="flex flex-wrap gap-x-3 text-[11px] text-white/75">
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-full bg-success" /> Receive {money(toReceive)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-full bg-expense" /> Give {money(toPay)}
                </span>
              </p>
            </div>
          )}
        </div>

        {/* Supporting figures */}
        <div className={cn("grid min-w-0 gap-2.5 p-3 @3xl:p-4", advanceHeld > 0 ? "grid-cols-1 @lg:grid-cols-3 @3xl:w-[34rem]" : "grid-cols-1 @lg:grid-cols-2 @3xl:w-[24rem]")}>
          <SummaryTile icon={ArrowUpRight} chip="bg-expense/10 text-expense" label="You need to give">
            <Money amount={Math.round(toPay)} className={cn("text-lg leading-none", toPay > 0 ? "text-expense" : "text-foreground/55")} />
            <span className="text-xs text-foreground/60">{payCount === 0 ? "Nothing" : `${payCount} ${payCount === 1 ? "person" : "people"}`}</span>
          </SummaryTile>
          {advanceHeld > 0 && (
            // Money people paid ahead, not yet applied — held for them: not owed by them, not owed by you.
            <SummaryTile icon={Wallet} chip="bg-primary/25 text-foreground dark:text-primary-accent-text" label="Advance held">
              <Money amount={Math.round(advanceHeld)} className="text-lg leading-none text-foreground" />
              <span className="text-xs text-foreground/60">
                Not applied yet · {advanceHeldCount} {advanceHeldCount === 1 ? "person" : "people"}
              </span>
            </SummaryTile>
          )}
          <SummaryTile icon={Activity} chip="bg-purple/12 text-purple" label="Activity">
            <span className="font-heading text-lg leading-none font-bold text-foreground tabular-nums">{activity}</span>
            <span className="text-xs text-foreground/60">{activity === 1 ? "entry" : "entries"} this cycle</span>
          </SummaryTile>
        </div>
      </div>
    </section>
  );
}

function SummaryTile({ icon: Icon, chip, label, children }: { icon: typeof Wallet; chip: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[12px] border border-border bg-secondary/40 px-3.5 py-3">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", chip)}>
        <Icon className="size-4.5" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className={LABEL}>{label}</span>
        {children}
      </span>
    </div>
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
      <span className="text-[11px] font-medium text-muted-foreground xl:hidden">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>
        {value}
      </span>
      {sub && <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{sub}</span>}
    </span>
  );
}

/** Shared desktop column template — the header row and every person row use it. It needs ~660px, which only fits
 *  from xl (below that the sidebar leaves too little room), so phones and tablets use the stacked row instead. */
const ROW_GRID = "xl:grid-cols-[minmax(0,1fr)_7rem_8rem_8rem_10rem_1rem] xl:gap-x-5";

/**
 * The cycle's payment status in the shared settlement wording (`settlement-presentation.ts`), from engine
 * values only: paid something but still pending → partial; pending with nothing paid → due; nothing
 * pending after activity or a payment → paid in full.
 */
function cycleStatus(s: PeopleLedgerRow["statement"], moved: number): { label: string; className: string } | null {
  if (s.direction !== "settled") {
    if (moved > 0.005) return { label: "Partially paid", className: "border-warning/60 bg-warning/10 text-foreground" };
    return s.direction === "theyOwe"
      ? { label: "Payment due", className: "border-success/50 bg-success/10 text-foreground" }
      : { label: "You need to pay", className: "border-expense/50 bg-expense/10 text-foreground" };
  }
  if (moved > 0.005 || Math.abs(s.cycleActivity) >= 0.005) return { label: "Paid in full", className: "border-border-strong bg-secondary text-foreground" };
  return null;
}

/** One gross direction in a person row, as a tinted chip: "↙ Receive ₹1,000". */
function DirectionFigure({ side, amount }: { side: "theyOwe" | "iOwe"; amount: number }) {
  const receive = side === "theyOwe";
  const Icon = receive ? ArrowDownLeft : ArrowUpRight;
  return (
    <span
      className={cn(
        "flex w-full max-w-[10rem] items-center justify-between gap-2 rounded-full border px-2.5 py-1",
        receive ? "border-success/30 bg-success/10" : "border-expense/30 bg-expense/10",
      )}
    >
      <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold", receive ? "text-success" : "text-expense")}>
        <Icon className="size-3.5" strokeWidth={2.25} aria-hidden />
        {receive ? "Receive" : "Give"}
      </span>
      <span className="font-heading text-[15px] leading-tight font-bold whitespace-nowrap tabular-nums text-foreground">{money(amount)}</span>
    </span>
  );
}

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
  const n = s.rows.length;
  const isSettled = s.direction === "settled";
  const activityText = hasValue(activity) ? signed(activity) : money(0);
  // Real money this cycle and advance held apart from pending — engine values via `cyclePosition`.
  const pos = cyclePosition(s, row.name);
  const moved = pos.cashReceived > 0 ? pos.cashReceived : pos.cashPaid;
  const movedText = pos.cashReceived > 0 ? money(pos.cashReceived) : pos.cashPaid > 0 ? `Paid ${money(pos.cashPaid)}` : money(0);
  const status = cycleStatus(s, moved);
  // Held money, never folded into the amount above: their advance is not something you owe them.
  const advanceText = pos.advance ? `${pos.advance.from === "them" ? "Advance held" : "Advance paid"} ${money(pos.advance.amount)}` : null;
  const bothSides = s.toReceive > 0 && s.toGive > 0;

  return (
    <li
      className="animate-in fade-in fill-mode-both duration-200 ease-out"
      style={{ animationDelay: `${Math.min(index, 8) * 20}ms` }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${row.name}'s ledger — ${
          bothSides ? `You need to receive ${money(s.toReceive)}, you need to give ${money(s.toGive)}` : `${directionHeadline(s.direction)}${isSettled ? "" : ` ${money(s.amount)}`}`
        }`}
        className={cn(
          "group relative grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3.5 text-left outline-none transition-colors duration-150 hover:bg-gradient-to-r hover:from-secondary/80 hover:to-transparent focus-visible:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset xl:px-5",
          ROW_GRID,
        )}
      >
        <span className={cn("absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full transition-all duration-200 group-hover:top-2 group-hover:bottom-2 group-hover:w-1", tone.edge)} aria-hidden />

        {/* Identity */}
        <span className="flex min-w-0 items-center gap-3">
          <span className={cn("shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-card transition-transform duration-200 group-hover:scale-105", tone.ring)}>
            <ClayAvatar name={row.name} size={36} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-heading text-[15px] leading-tight font-semibold text-foreground">{row.name}</span>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
              {status && (
                <span className={cn("rounded-full border px-2 py-px text-[11px] font-semibold", status.className)}>{status.label}</span>
              )}
              {advanceText && <span className="rounded-full border border-primary-accent-text/50 bg-primary/15 px-2 py-px text-[11px] font-semibold text-foreground">{advanceText}</span>}
              {!status && !advanceText && (n === 0 ? "No activity" : `${n} ${n === 1 ? "activity" : "activities"}`)}
            </span>
          </span>
        </span>

        {/* Desktop: previous + this cycle columns */}
        <span className="hidden xl:block">
          <Figure label="Previous" value={money(previous)} muted={!hasValue(previous)} />
        </span>
        <span className="hidden xl:block">
          <Figure label="This cycle" value={activityText} muted={!hasValue(activity)} />
        </span>
        <span className="hidden xl:block">
          <Figure label={pos.cashPaid > 0 && pos.cashReceived <= 0 ? "Paid" : "Received"} value={movedText} muted={moved <= 0} />
        </span>

        {/* Current pending + who owes whom — both directions, gross, when both are open (never netted) */}
        {bothSides ? (
          <span className="flex min-w-0 flex-col items-end gap-1">
            <DirectionFigure side="theyOwe" amount={s.toReceive} />
            <DirectionFigure side="iOwe" amount={s.toGive} />
          </span>
        ) : (
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
        )}

        <ChevronRight
          className="hidden size-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground xl:block"
          strokeWidth={2}
          aria-hidden
        />

        {/* Phone / tablet: the trail on one line under the name */}
        <span className="col-span-2 flex flex-wrap gap-x-1.5 pl-12 text-xs text-muted-foreground tabular-nums xl:hidden">
          <span>
            Previous <span className="font-semibold text-foreground">{money(previous)}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            This cycle <span className="font-semibold text-foreground">{activityText}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            {pos.cashPaid > 0 && pos.cashReceived <= 0 ? "Paid" : "Received"} <span className="font-semibold text-foreground">{movedText.replace(/^Paid /, "")}</span>
          </span>
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
      <div className={cn("hidden border-b border-border px-5 py-2 xl:grid", ROW_GRID)} aria-hidden>
        <span className={LABEL}>Person</span>
        <span className={cn(LABEL, "text-right")}>Previous</span>
        <span className={cn(LABEL, "text-right")}>This cycle</span>
        <span className={cn(LABEL, "text-right")}>Received / paid</span>
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
