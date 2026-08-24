"use client";

import { cn } from "@/lib/utils";

/**
 * A34-style left-edge confidence signal, brought inline as a compact meter
 * bar instead of a bare number — reads faster when scanning a dense list
 * than a percentage, and (unlike a ring) fits the grid's row geometry
 * without forcing this row taller than every other cell.
 */
export function ConfidenceCell({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  const tone = percent >= 90 ? "success" : percent >= 70 ? "warning" : "danger";
  return (
    <div className="flex h-full w-full items-center gap-1.5 px-2.5" title={`${percent}% confidence`}>
      <div className="h-1 w-full min-w-6 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "danger" && "bg-danger",
          )}
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      </div>
      <span
        className={cn(
          "shrink-0 text-[11px] font-semibold tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {percent}%
      </span>
    </div>
  );
}
