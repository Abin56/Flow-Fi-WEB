"use client";

import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { FloatingCard } from "@/components/foundation/floating-card";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: number;
  format: (value: number) => string;
  delta?: number;
  deltaDirection?: "up" | "down";
  /** Whether "up" is the good direction for this metric — flips delta badge color. Default true. */
  upIsGood?: boolean;
  sparkline?: number[];
  sparklineColor?: string;
  className?: string;
}

/** Stat-tile contract: label + AnimatedNumber value + optional signed delta + optional sparkline. */
export function MetricCard({
  label,
  value,
  format,
  delta,
  deltaDirection = "up",
  upIsGood = true,
  sparkline,
  sparklineColor = "var(--primary)",
  className,
}: MetricCardProps) {
  const isGoodDelta = deltaDirection === "up" ? upIsGood : !upIsGood;
  const DeltaIcon = deltaDirection === "up" ? ArrowUpRight : ArrowDownRight;

  return (
    <FloatingCard interactive={false} elevation={1} className={cn("flex flex-col gap-3", className)}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
        <AnimatedNumber value={value} format={format} />
      </p>
      <div className="flex items-center justify-between gap-2">
        {delta !== undefined ? (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium",
              isGoodDelta ? "text-success" : "text-expense",
            )}
          >
            <DeltaIcon className="size-3.5" />
            {Math.abs(delta).toFixed(1)}%
          </span>
        ) : (
          <span />
        )}
        {sparkline && sparkline.length > 1 && (
          <div className="h-8 w-20">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={sparkline.map((v) => ({ v }))}>
                <defs>
                  <linearGradient id={`spark-${label.replace(/\s+/g, "-")}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={sparklineColor} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={sparklineColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke={sparklineColor}
                  strokeWidth={2}
                  fill={`url(#spark-${label.replace(/\s+/g, "-")})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </FloatingCard>
  );
}
