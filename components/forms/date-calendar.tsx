"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What a payment date field knows about the schedule. Context only: it decides which month the calendar can show and
 * which shortcuts it offers — it never fills the field by itself.
 */
export interface DateCalendarContext {
  /** The one installment this date is for: marked in the grid and offered as a "Due …" shortcut. */
  dueDate?: Date | null;
  /** A date shared by several installments: only a jump to their (earliest) due month — no due date is offered. */
  monthHint?: Date | null;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const NAV_BUTTON = "grid size-7 shrink-0 place-items-center rounded-md text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35";
const SELECT = "h-7 rounded-md border border-border bg-card px-1.5 text-xs font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SHORTCUT = "h-7 rounded-md border border-border px-2 text-xs font-semibold text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

/**
 * The month grid behind a payment date field: month and year picked directly, shortcuts to the due date and today.
 * Purely local — mounted each time the calendar opens, so it always starts from the current value (else the due month,
 * else today), and browsing months touches nothing outside it. Only picking a day (or a shortcut that names a date)
 * calls `onSelect`.
 */
export function DateCalendar({ value, min, max, context, onSelect }: { value: string; min?: string; max?: string; context: DateCalendarContext; onSelect: (iso: string) => void }) {
  const today = new Date();
  const todayIso = toIso(today);
  const dueIso = context.dueDate ? toIso(context.dueDate) : null;
  const allowed = (iso: string) => (min == null || iso >= min) && (max == null || iso <= max);

  const [view, setView] = React.useState(() => {
    const start = monthStart(fromIso(value) ?? context.dueDate ?? context.monthHint ?? today);
    // A due month entirely past `max` (an installment paid ahead) has nothing to pick: open on the last allowed month.
    return max != null && toIso(start) > max ? monthStart(fromIso(max) ?? today) : start;
  });
  const year = view.getFullYear();
  const month = view.getMonth();

  const known = [today, context.dueDate, context.monthHint, fromIso(value), view].filter((d): d is Date => d != null).map((d) => d.getFullYear());
  const firstYear = min != null ? Number(min.slice(0, 4)) : Math.min(...known) - 10;
  const lastYear = max != null ? Number(max.slice(0, 4)) : Math.max(...known) + 5;
  const years = Array.from({ length: Math.max(1, lastYear - firstYear + 1) }, (_, i) => firstYear + i);

  const offset = view.getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const canGoBack = min == null || toIso(new Date(year, month, 0)) >= min;
  const canGoOn = max == null || toIso(new Date(year, month + 1, 1)) <= max;

  return (
    <div className="flex flex-col gap-2" data-testid="date-calendar">
      <div className="flex items-center gap-1">
        <button type="button" className={NAV_BUTTON} aria-label="Previous month" disabled={!canGoBack} onClick={() => setView(new Date(year, month - 1, 1))}>
          <ChevronLeftIcon className="size-4" />
        </button>
        <select className={cn(SELECT, "flex-1")} aria-label="Month" value={month} onChange={(e) => setView(new Date(year, Number(e.target.value), 1))}>
          {MONTHS.map((name, i) => (
            <option key={name} value={i}>
              {name}
            </option>
          ))}
        </select>
        <select className={SELECT} aria-label="Year" value={year} onChange={(e) => setView(new Date(Number(e.target.value), month, 1))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button type="button" className={NAV_BUTTON} aria-label="Next month" disabled={!canGoOn} onClick={() => setView(new Date(year, month + 1, 1))}>
          <ChevronRightIcon className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((w) => (
          <span key={w} aria-hidden className="py-0.5 text-[10.5px] font-medium text-muted-foreground">
            {w}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const day = new Date(year, month, i + 1);
          const iso = toIso(day);
          const selected = iso === value;
          const isDue = iso === dueIso;
          return (
            <button
              key={iso}
              type="button"
              disabled={!allowed(iso)}
              aria-label={`${shortDate(day)}${isDue ? " (due date)" : ""}`}
              aria-pressed={selected}
              aria-current={iso === todayIso ? "date" : undefined}
              onClick={() => onSelect(iso)}
              className={cn(
                "mx-auto grid size-8 place-items-center rounded-full text-sm tabular-nums outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35",
                iso === todayIso && "font-bold underline underline-offset-4",
                isDue && "ring-1 ring-primary-accent-text ring-inset",
                selected && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
              )}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
        {context.dueDate && dueIso && (
          // Out of range (not due yet, for a payment already made): it can still be viewed, never picked.
          <button type="button" className={SHORTCUT} disabled={!allowed(dueIso)} onClick={() => onSelect(dueIso)}>
            Due {shortDate(context.dueDate)}
          </button>
        )}
        {!context.dueDate && context.monthHint && (
          <button type="button" className={SHORTCUT} onClick={() => setView(monthStart(context.monthHint!))}>
            Show {context.monthHint.toLocaleDateString("en-IN", { month: "short", year: "numeric" })}
          </button>
        )}
        <button type="button" className={cn(SHORTCUT, "ml-auto")} disabled={!allowed(todayIso)} onClick={() => onSelect(todayIso)}>
          Today
        </button>
      </div>
    </div>
  );
}
