"use client";

import { CalendarRange, ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import type { ReportPeriod, ReportPeriodSelection } from "@/lib/engines/report-period";
import { cn } from "@/lib/utils";
import { Segmented } from "./report-ui";

type Mode = "cycle" | "month" | "range";

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString("en-IN", { month: "short" }));

function toInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromInputValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The reporting-period control shared by Reports and Analytics: Month Cycle (the configured start day), calendar
 * month, or custom range — with previous / next stepping, a picker, and a one-click return to today.
 */
export function PeriodBar({
  selection,
  onChange,
  period,
  startDay,
  now,
  resolve,
  className,
}: {
  selection: ReportPeriodSelection;
  onChange: (s: ReportPeriodSelection) => void;
  period: ReportPeriod;
  startDay: number;
  now: Date;
  resolve: (s: ReportPeriodSelection) => ReportPeriod;
  className?: string;
}) {
  const isCustomCycle = startDay > 1;
  // With a 1st-of-month cycle the cycle IS the calendar month — one "Month" mode covers both.
  const mode: Mode = selection.kind === "cycle" && !isCustomCycle ? "month" : selection.kind;
  const [open, setOpen] = useState(false);

  const modes = useMemo(
    () =>
      isCustomCycle
        ? ([
            { value: "cycle", label: "Cycle", title: `Month Cycle: ${ordinalDay(startDay)} to ${ordinalDay(startDay - 1)}` },
            { value: "month", label: "Calendar month" },
            { value: "range", label: "Custom" },
          ] as const)
        : ([
            { value: "month", label: "Month" },
            { value: "range", label: "Custom" },
          ] as const),
    [isCustomCycle, startDay],
  );

  const setMode = (m: Mode) => {
    if (m === "cycle") onChange({ kind: "cycle", offset: 0 });
    else if (m === "month") onChange({ kind: "month", year: now.getFullYear(), month: now.getMonth() });
    else onChange({ kind: "range", start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29), end: now });
  };

  const step = (dir: -1 | 1) => {
    if (selection.kind === "cycle") onChange({ kind: "cycle", offset: selection.offset + dir });
    else if (selection.kind === "month") {
      const d = new Date(selection.year, selection.month + dir, 1);
      onChange({ kind: "month", year: d.getFullYear(), month: d.getMonth() });
    } else {
      const len = period.days;
      const start = new Date(period.start.getFullYear(), period.start.getMonth(), period.start.getDate() + dir * len);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + len - 1);
      onChange({ kind: "range", start, end });
    }
  };

  const canGoNext = period.end.getTime() < now.getTime();
  const basis =
    selection.kind === "cycle" && isCustomCycle
      ? `Cycle · ${ordinalDay(startDay)} → ${ordinalDay(startDay - 1)}`
      : selection.kind === "range"
        ? `Custom range · ${period.days} days`
        : "Calendar month";

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} data-testid="period-bar">
      <Segmented value={mode} options={modes} onChange={setMode} testId="period-mode" ariaLabel="Reporting period type" />
      <div className="flex items-center rounded-xl border border-border/70 bg-card shadow-e1">
        <button type="button" onClick={() => step(-1)} className="grid size-8 place-items-center rounded-l-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Previous period" data-testid="period-prev">
          <ChevronLeft className="size-4" />
        </button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="flex h-8 items-center gap-1.5 border-x border-border/70 px-3 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted" data-testid="period-label">
              <CalendarRange className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="whitespace-nowrap">{period.label}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-3">
            {mode === "range" ? (
              <RangePicker selection={selection} period={period} now={now} onPick={(s) => { onChange(s); setOpen(false); }} />
            ) : mode === "cycle" ? (
              <CyclePicker selection={selection} resolve={resolve} onPick={(s) => { onChange(s); setOpen(false); }} />
            ) : (
              <MonthPicker period={period} now={now} onPick={(y, m) => { onChange({ kind: "month", year: y, month: m }); setOpen(false); }} />
            )}
          </PopoverContent>
        </Popover>
        <button type="button" onClick={() => step(1)} disabled={!canGoNext} className="grid size-8 place-items-center rounded-r-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35" aria-label="Next period" data-testid="period-next">
          <ChevronRight className="size-4" />
        </button>
      </div>
      {!period.isCurrent && selection.kind !== "range" && (
        <button type="button" onClick={() => setMode(mode)} className="inline-flex h-8 items-center gap-1 rounded-xl px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" data-testid="period-today">
          <RotateCcw className="size-3.5" aria-hidden />
          Current
        </button>
      )}
      <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground" data-testid="period-basis">
        {basis}
        {period.isCurrent && period.daysElapsed < period.days ? ` · day ${period.daysElapsed} of ${period.days}` : ""}
      </span>
    </div>
  );
}

function MonthPicker({ period, now, onPick }: { period: ReportPeriod; now: Date; onPick: (year: number, month: number) => void }) {
  const [year, setYear] = useState(period.start.getFullYear());
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" className="grid size-7 place-items-center rounded-lg hover:bg-muted" onClick={() => setYear((y) => y - 1)} aria-label="Previous year">
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-sm font-semibold">{year}</span>
        <button type="button" className="grid size-7 place-items-center rounded-lg hover:bg-muted disabled:opacity-35" disabled={year >= now.getFullYear()} onClick={() => setYear((y) => y + 1)} aria-label="Next year">
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {MONTHS.map((label, m) => {
          const future = year > now.getFullYear() || (year === now.getFullYear() && m > now.getMonth());
          const active = period.kind !== "range" && period.start.getFullYear() === year && period.start.getMonth() === m && period.start.getDate() === 1;
          return (
            <button
              key={label}
              type="button"
              disabled={future}
              onClick={() => onPick(year, m)}
              className={cn("rounded-lg py-2 text-xs font-medium transition-colors disabled:opacity-30", active ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CyclePicker({ selection, resolve, onPick }: { selection: ReportPeriodSelection; resolve: (s: ReportPeriodSelection) => ReportPeriod; onPick: (s: ReportPeriodSelection) => void }) {
  const current = selection.kind === "cycle" ? selection.offset : 0;
  const items = Array.from({ length: 13 }, (_, i) => -i);
  return (
    <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
      {items.map((offset) => {
        const p = resolve({ kind: "cycle", offset });
        return (
          <button
            key={offset}
            type="button"
            onClick={() => onPick({ kind: "cycle", offset })}
            className={cn("flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors", offset === current ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
          >
            <span className="font-medium">{p.label}</span>
            <span className={cn("text-[11px]", offset === current ? "opacity-80" : "text-muted-foreground")}>{offset === 0 ? "Current" : offset === -1 ? "Previous" : `${-offset} back`}</span>
          </button>
        );
      })}
    </div>
  );
}

function RangePicker({ selection, period, now, onPick }: { selection: ReportPeriodSelection; period: ReportPeriod; now: Date; onPick: (s: ReportPeriodSelection) => void }) {
  const [from, setFrom] = useState(toInputValue(selection.kind === "range" ? period.start : new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(toInputValue(selection.kind === "range" ? period.end : now));
  const a = fromInputValue(from);
  const b = fromInputValue(to);
  const valid = a != null && b != null && a.getTime() <= b.getTime();
  const preset = (days: number) => onPick({ kind: "range", start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)), end: now });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-1">
        {[
          { label: "Last 7 days", days: 7 },
          { label: "Last 30 days", days: 30 },
          { label: "Last 90 days", days: 90 },
          { label: "Last 365 days", days: 365 },
        ].map((p) => (
          <button key={p.label} type="button" onClick={() => preset(p.days)} className="rounded-lg bg-muted/60 px-2 py-1.5 text-xs font-medium hover:bg-muted">
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => onPick({ kind: "range", start: new Date(now.getFullYear(), 0, 1), end: now })} className="col-span-2 rounded-lg bg-muted/60 px-2 py-1.5 text-xs font-medium hover:bg-muted">
          This year to date
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground" data-testid="range-from" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground" data-testid="range-to" />
        </label>
      </div>
      <button
        type="button"
        disabled={!valid}
        onClick={() => valid && onPick({ kind: "range", start: a!, end: b! })}
        className="h-8 rounded-lg bg-primary text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
        data-testid="range-apply"
      >
        Apply range
      </button>
    </div>
  );
}
