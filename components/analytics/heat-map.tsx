"use client";

import { useState } from "react";
import { FloatingCard } from "@/components/foundation/floating-card";
import { SectionHeader } from "@/components/foundation/section-header";
import { tooltipContentStyle } from "@/lib/charts/theme";
import { cn } from "@/lib/utils";

interface HeatMapProps {
  title: string;
  description?: string;
  rows: string[];
  columns: string[];
  values: number[][];
  format: (value: number) => string;
  className?: string;
}

/** Category x day intensity grid — sequential single-hue ramp (magnitude, not identity), per the
 *  dataviz color formula. Cells shade by opacity of --primary so it reads correctly in dark mode too. */
export function HeatMap({ title, description, rows, columns, values, format, className }: HeatMapProps) {
  const [hovered, setHovered] = useState<{ r: number; c: number } | null>(null);
  const max = Math.max(1, ...values.flat());

  return (
    <FloatingCard interactive={false} elevation={2} className={cn("flex flex-col", className)}>
      <SectionHeader eyebrow="Intensity" title={title} description={description} />
      <div className="mt-5 overflow-x-auto">
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `7rem repeat(${columns.length}, minmax(2.25rem, 1fr))` }}>
          <div />
          {columns.map((col) => (
            <div key={col} className="text-center text-[10px] font-medium text-muted-foreground">
              {col}
            </div>
          ))}
          {rows.map((row, r) => (
            <div key={row} className="contents">
              <div className="truncate pr-2 text-xs text-muted-foreground">{row}</div>
              {columns.map((_, c) => {
                const value = values[r]?.[c] ?? 0;
                const intensity = value / max;
                const isHovered = hovered?.r === r && hovered?.c === c;
                return (
                  <div key={c} className="relative">
                    <button
                      type="button"
                      onMouseEnter={() => setHovered({ r, c })}
                      onMouseLeave={() => setHovered(null)}
                      className="aspect-square w-full rounded-md transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      style={{
                        background:
                          value === 0
                            ? "var(--muted)"
                            : `color-mix(in oklch, var(--primary) ${Math.max(intensity * 100, 12)}%, var(--muted))`,
                        transform: isHovered ? "scale(1.12)" : undefined,
                      }}
                      aria-label={`${row}, ${columns[c]}: ${format(value)}`}
                    />
                    {isHovered && value > 0 && (
                      <div
                        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 text-xs whitespace-nowrap"
                        style={tooltipContentStyle}
                      >
                        {format(value)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </FloatingCard>
  );
}
