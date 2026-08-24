"use client";

import { cn } from "@/lib/utils";

export const TIME_RANGES = ["1M", "3M", "6M", "1Y", "YTD", "All"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

interface TimeRangePickerProps {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
  className?: string;
}

/** Segmented pill control for chart date ranges — clay-pressed active state, local filtering only. */
export function TimeRangePicker({ value, onChange, className }: TimeRangePickerProps) {
  return (
    <div className={cn("clay-pressed inline-flex items-center gap-0.5 rounded-2xl p-1", className)}>
      {TIME_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          onClick={() => onChange(range)}
          className={cn(
            "rounded-xl px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            value === range
              ? "bg-card text-foreground shadow-e1"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {range}
        </button>
      ))}
    </div>
  );
}
