"use client";

import type { NameType, Payload, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { tooltipContentStyle, tooltipLabelStyle } from "@/lib/charts/theme";

interface ChartTooltipProps {
  active?: boolean;
  payload?: Payload<ValueType, NameType>[];
  label?: string | number;
  formatter?: (value: number) => string;
}

/** Shared recharts tooltip styled like a mini FloatingCard — the one tooltip every chart in the app uses. */
export function ChartTooltip({ active, payload, label, formatter = String }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div style={tooltipContentStyle}>
      {label !== undefined && <p style={tooltipLabelStyle}>{label}</p>}
      <div className="flex flex-col gap-1">
        {payload.map((entry) => (
          <div key={entry.name} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" style={{ background: entry.color }} />
            <span className="text-muted-foreground">{entry.name}</span>
            <span className="ml-auto font-semibold text-foreground tabular-nums">
              {formatter(entry.value as number)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
