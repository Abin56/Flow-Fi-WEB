"use client";

import { ArrowRight, ArrowUp, Eye, EyeOff } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { financialHealth } from "@/lib/mock/dashboard-data";

export interface NetWorthHeroProps {
  netWorth: {
    amount: number;
    changeAmount: number;
    changePercent: number;
    /** Cumulative net (income - expense) for each of the last 7 days, oldest first — see `use-dashboard-data.ts`. */
    trend: number[];
  };
  isLoading?: boolean;
  hideAmount?: boolean;
  onToggleHideAmount?: () => void;
}

/**
 * Net Worth + Financial Health, side by side in one gradient hero card — matches the reference dashboard's
 * headline widget: a big number on the left, a health ring on the right, split by a soft vertical divider.
 *
 * `netWorth` comes from `netWorthWithLoans` (lib/engines/loan-balance-sheet.ts) via `useDashboardData` —
 * account balances plus loan principal owed to me, minus loan/EMI principal I owe.
 * `financialHealth` has no ported engine yet (see `use-dashboard-data.ts`'s doc comment), so it stays mock.
 *
 * The 7-day sparkline below the headline number is a direct visual port of
 * `NetWorthWidgetCard`'s `MiniTrendChart` (Finance_App's
 * `net_worth_widget_card.dart`) — white-on-gradient, matching that card's own
 * `color: Colors.white` styling, since it's a single trend line on the app's
 * branded hero surface rather than a categorical/sequential data series.
 */
export function NetWorthHero({ netWorth, isLoading, hideAmount = false, onToggleHideAmount }: NetWorthHeroProps) {
  if (isLoading) {
    return (
      <section
        className="@container/hero relative flex h-full flex-col justify-between gap-6 overflow-hidden rounded-3xl p-5 text-hero-foreground @xs/hero:flex-row @xs/hero:items-center @xs/hero:p-6"
        style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Skeleton className="h-3 w-20 bg-white/20" />
          <Skeleton className="h-9 w-40 bg-white/20" />
          <Skeleton className="h-3 w-32 bg-white/20" />
        </div>
        <Skeleton className="size-[92px] shrink-0 rounded-full bg-white/20" />
      </section>
    );
  }

  return (
    <section
      className="@container/hero relative flex h-full flex-col justify-between gap-6 overflow-hidden rounded-3xl p-5 text-hero-foreground @xs/hero:flex-row @xs/hero:items-center @xs/hero:p-6"
      style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-card)" }}
    >
      <div className="relative flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-hero-foreground/75">Net Worth</p>
          <button
            type="button"
            onClick={onToggleHideAmount}
            aria-label={hideAmount ? "Show net worth" : "Hide net worth"}
            aria-pressed={hideAmount}
            className="rounded-full p-0.5 text-hero-foreground/60 transition-colors hover:text-hero-foreground focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
          >
            {hideAmount ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
        <span className="font-heading text-3xl font-bold tracking-tight tabular-nums sm:text-4xl">
          {hideAmount ? "••••••" : <AnimatedNumber value={netWorth.amount} format={formatCurrency} />}
        </span>
        <p className="flex items-center gap-1 text-xs font-medium text-hero-foreground/85">
          <ArrowUp className="size-3.5" />
          {hideAmount ? "••••" : `${formatCurrency(netWorth.changeAmount)} (${netWorth.changePercent}%)`} this month
        </p>
        {!hideAmount && netWorth.trend.length > 0 && netWorth.trend.some((v) => v !== netWorth.trend[0]) && (
          <div className="h-8 w-full max-w-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={netWorth.trend.map((v) => ({ v }))} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
                <defs>
                  <linearGradient id="net-worth-trend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#ffffff"
                  strokeWidth={2}
                  strokeLinecap="round"
                  fill="url(#net-worth-trend)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        <button
          type="button"
          className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full bg-white/20 px-4 py-2 text-xs font-semibold backdrop-blur-sm transition-colors hover:bg-white/30 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
        >
          View Net Worth
          <ArrowRight className="size-3.5" />
        </button>
      </div>

      <div className="relative flex shrink-0 flex-col items-center gap-2 border-white/20 pt-4 text-center @xs/hero:border-l @xs/hero:pt-0 @xs/hero:pl-6">
        <p className="text-xs font-medium text-hero-foreground/75">Financial Health</p>
        <ProgressRing value={financialHealth.score} size={92} strokeWidth={7} color="white" trackColor="rgba(255,255,255,0.25)">
          <span className="font-heading text-xl font-bold">
            {financialHealth.score}
            <span className="text-xs font-medium text-hero-foreground/70">/100</span>
          </span>
        </ProgressRing>
        <p className="text-sm font-semibold">{financialHealth.label} 🎉</p>
        <p className="max-w-[9rem] text-[11px] leading-snug text-hero-foreground/75">{financialHealth.message}</p>
      </div>
    </section>
  );
}
