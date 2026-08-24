"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function buildMonthGrid(monthDate: Date) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = firstDay.getDay();

  const days: (Date | null)[] = Array.from({ length: startOffset }, () => null);
  for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));
  return days;
}

export interface DatePickerProps {
  label?: string;
  value?: Date;
  onChange?: (date: Date) => void;
  placeholder?: string;
  className?: string;
}

/** Lightweight month-grid date picker (no external date library) — click the trigger to open a calendar
 *  popover, navigate months with the chevrons, click a day to select and close. */
export function DatePicker({ label, value, onChange, placeholder = "Select date", className }: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [visibleMonth, setVisibleMonth] = React.useState(value ?? new Date());
  const id = React.useId();

  const days = React.useMemo(() => buildMonthGrid(visibleMonth), [visibleMonth]);
  const monthLabel = visibleMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="flex flex-col gap-1.5">
      {label && <SettingsLabel htmlFor={id}>{label}</SettingsLabel>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" className={cn("w-56 justify-start gap-2 font-normal", className)}>
            <CalendarIcon className="size-4 text-muted-foreground" />
            {value ? value.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64" align="start">
          <div className="mb-3 flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous month"
              onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span className="text-sm font-medium">{monthLabel}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next month"
              onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
            {WEEKDAYS.map((w, i) => (
              <div key={i} className="py-1">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((day, i) => {
              if (!day) return <div key={i} />;
              const selected = value && isSameDay(day, value);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    onChange?.(day);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full text-sm transition-colors hover:bg-muted",
                    selected && "bg-primary text-primary-foreground hover:bg-primary",
                  )}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
