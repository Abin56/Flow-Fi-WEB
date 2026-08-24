"use client";

import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { FloatingCard } from "@/components/foundation/floating-card";
import { cn } from "@/lib/utils";

interface TrendCardProps {
  label: string;
  value: string;
  direction: "up" | "down";
  delta: string;
  upIsGood?: boolean;
  sparkline: number[];
  className?: string;
}

/** Compact stat + directional arrow + colored sparkline — smaller than MetricCard, for dense grids. */
export function TrendCard({ label, value, direction, delta, upIsGood = true, sparkline, className }: TrendCardProps) {
  const isGood = direction === "up" ? upIsGood : !upIsGood;
  const color = isGood ? "var(--success)" : "var(--expense)";
  const DeltaIcon = direction === "up" ? ArrowUpRight : ArrowDownRight;
  const id = `trend-spark-${label.replace(/\s+/g, "-")}`;

  return (
    <FloatingCard interactive={false} elevation={1} className={cn("flex items-center gap-3 p-4", className)}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 font-heading text-lg font-semibold tracking-tight tabular-nums">{value}</p>
        <span className="mt-0.5 flex items-center gap-0.5 text-xs font-medium" style={{ color }}>
          <DeltaIcon className="size-3.5" />
          {delta}
        </span>
      </div>
      <div className="h-10 w-16 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={sparkline.map((v) => ({ v }))}>
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${id})`} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </FloatingCard>
  );
}
