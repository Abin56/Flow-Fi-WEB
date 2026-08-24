"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatMonthYear } from "@/features/transactions/lib/transaction-flag";

interface MonthYearStepperProps {
  value: Date;
  onChange: (date: Date) => void;
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** Port of `Finance_App`'s `MonthYearStepper` — prev/next month, bounded to now-5y..now+2y (matches the mobile reference). */
export function MonthYearStepper({ value, onChange }: MonthYearStepperProps) {
  const now = new Date();
  const min = new Date(now.getFullYear() - 5, now.getMonth(), 1);
  const max = new Date(now.getFullYear() + 2, now.getMonth(), 1);
  const normalized = new Date(value.getFullYear(), value.getMonth(), 1);
  const atMin = normalized.getTime() <= min.getTime();
  const atMax = normalized.getTime() >= max.getTime();

  return (
    <div className="clay-pressed flex items-center justify-between rounded-xl px-2 py-1.5">
      <button
        type="button"
        disabled={atMin}
        onClick={() => onChange(addMonths(normalized, -1))}
        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Previous month"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="text-sm font-medium tabular-nums text-foreground">{formatMonthYear(normalized)}</span>
      <button
        type="button"
        disabled={atMax}
        onClick={() => onChange(addMonths(normalized, 1))}
        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Next month"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
