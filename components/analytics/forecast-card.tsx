"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Sparkles } from "lucide-react";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";
import { FloatingCard } from "@/components/foundation/floating-card";
import { SectionHeader } from "@/components/foundation/section-header";
import { axisStyle } from "@/lib/charts/theme";
import { cn } from "@/lib/utils";

interface ForecastPoint {
  label: string;
  actual?: number;
  projected?: number;
}

interface ForecastCardProps {
  title: string;
  description?: string;
  data: ForecastPoint[];
  format: (value: number) => string;
  className?: string;
}

/** Projected-value chart: solid line for actuals, dashed for the forecasted tail — so the projection
 *  boundary is always visible without relying on color alone. */
export function ForecastCard({ title, description, data, format, className }: ForecastCardProps) {
  return (
    <FloatingCard interactive={false} elevation={2} className={cn("flex flex-col", className)}>
      <SectionHeader
        eyebrow="Forecast"
        title={title}
        description={description}
        action={
          <span className="flex items-center gap-1 text-xs font-medium text-purple">
            <Sparkles className="size-3.5" />
            AI projected
          </span>
        }
      />
      <div style={{ height: 220 }} className="mt-4 -ml-2 w-[calc(100%+0.5rem)]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" {...axisStyle} />
            <Tooltip content={<ChartTooltip formatter={format} />} />
            <Line
              type="monotone"
              dataKey="actual"
              stroke="var(--primary)"
              strokeWidth={2}
              dot={{ r: 4, fill: "var(--primary)", strokeWidth: 2, stroke: "var(--card)" }}
              connectNulls={false}
              name="Actual"
            />
            <Line
              type="monotone"
              dataKey="projected"
              stroke="var(--purple)"
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={{ r: 4, fill: "var(--purple)", strokeWidth: 2, stroke: "var(--card)" }}
              connectNulls
              name="Projected"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </FloatingCard>
  );
}
