"use client";

import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { cn } from "@/lib/utils";

interface AnalyticsHeroProps {
  eyebrow: string;
  title: string;
  value: number;
  format: (value: number) => string;
  delta?: number;
  deltaDirection?: "up" | "down";
  upIsGood?: boolean;
  sparkline?: number[];
  action?: React.ReactNode;
  className?: string;
}

/** Big editorial header for a workspace tab — Sunset's gradient-hero surface, a large AnimatedNumber
 *  hero figure, a trend delta chip, and an optional full-bleed sparkline wash beneath the copy. */
export function AnalyticsHero({
  eyebrow,
  title,
  value,
  format,
  delta,
  deltaDirection = "up",
  upIsGood = true,
  sparkline,
  action,
  className,
}: AnalyticsHeroProps) {
  const isGoodDelta = deltaDirection === "up" ? upIsGood : !upIsGood;
  const DeltaIcon = deltaDirection === "up" ? ArrowUpRight : ArrowDownRight;

  return (
    <section
      className={cn(
        "relative flex min-h-56 flex-col justify-between overflow-hidden rounded-3xl px-8 py-7 text-primary-foreground",
        className,
      )}
      style={{ background: "var(--gradient-hero)", boxShadow: "var(--glow-primary)" }}
    >
      <div className="pointer-events-none absolute -top-16 -right-16 size-64 rounded-full bg-white/10 blur-3xl" />
      {sparkline && sparkline.length > 1 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 opacity-40">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkline.map((v) => ({ v }))} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="hero-spark" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="white" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="white" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke="white" strokeWidth={2} fill="url(#hero-spark)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wide text-primary-foreground/75 uppercase">{eyebrow}</p>
          <h1 className="mt-1 font-heading text-lg font-semibold">{title}</h1>
        </div>
        {action}
      </div>

      <div className="relative flex items-end gap-3">
        <p className="font-heading text-4xl font-semibold tracking-tight tabular-nums lg:text-5xl">
          <AnimatedNumber value={value} format={format} />
        </p>
        {delta !== undefined && (
          <span
            className={cn(
              "mb-1.5 flex items-center gap-0.5 rounded-full bg-white/20 px-2.5 py-1 text-xs font-semibold backdrop-blur-sm",
              isGoodDelta ? "text-white" : "text-white",
            )}
          >
            <DeltaIcon className="size-3.5" />
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
    </section>
  );
}
