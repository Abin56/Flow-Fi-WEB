"use client";

import Link from "next/link";
import { ArrowRight, Eye, EyeOff, Landmark } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DASH_PANEL } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface NetWorthHeroProps {
  netWorth: {
    amount: number;
    changeAmount: number;
    changePercent: number;
    /** Cumulative net (income - expense) for each of the last 7 days, oldest first — see `use-dashboard-data.ts`. */
    trend: number[];
    /** Everything owned (accounts, money lent, what people owe you) — Net Worth + Debt + Held for people. */
    assets?: number;
    /** Every liability once: card debt + remaining Loan/EMI principal (`liabilityTotals`). */
    debt?: number;
    /** The Loan/EMI part of `debt`. */
    loanDebt?: number;
    /** Owed to people directly (People ledger) — part of `debt`. */
    peopleDebt?: number;
    /** Advances people paid you, not yet applied — cash you hold for them; neither debt nor yours. */
    heldForPeople?: number;
  };
  isLoading?: boolean;
  hideAmount?: boolean;
  onToggleHideAmount?: () => void;
}

/**
 * Net worth — the page's headline figure. `netWorth` comes from `netWorthWithLoans` via `useDashboardData`.
 * The month-over-month change isn't tracked yet (no balance history — the hook reports 0), so it's only
 * shown once it's non-zero; the old mock "Financial Health" score is no longer displayed as if it were real.
 */
export function NetWorthHero({ netWorth, isLoading, hideAmount = false, onToggleHideAmount }: NetWorthHeroProps) {
  const hasTrend = !hideAmount && netWorth.trend.length > 0 && netWorth.trend.some((v) => v !== netWorth.trend[0]);
  const hasChange = netWorth.changeAmount !== 0;

  return (
    <section
      aria-label="Net worth"
      className={cn(DASH_PANEL, "relative flex h-full flex-col justify-between gap-4 bg-gradient-to-br from-primary/20 via-card to-card p-5 sm:p-6 dark:from-primary/10")}
    >
      <span className="pointer-events-none absolute -top-16 -right-12 size-48 rounded-full bg-primary/20 blur-3xl dark:bg-primary/10" aria-hidden />

      <div className="relative flex items-center justify-between gap-2">
        <span className={cn(DASH_LABEL, "inline-flex items-center gap-1.5")}>
          <Landmark className="size-3.5 text-foreground" strokeWidth={1.75} />
          Net worth
        </span>
        <button
          type="button"
          onClick={onToggleHideAmount}
          aria-label={hideAmount ? "Show net worth" : "Hide net worth"}
          aria-pressed={hideAmount}
          className="flex h-7 items-center gap-1 rounded-[6px] border border-border-strong/60 bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {hideAmount ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {hideAmount ? "Show" : "Hide"}
        </button>
      </div>

      <div className="relative">
        {isLoading ? (
          <Skeleton className="h-11 w-56" />
        ) : (
          <p className="text-[38px] leading-none font-bold tracking-tight text-foreground tabular-nums sm:text-[44px]">
            {hideAmount ? "••••••" : <AnimatedNumber value={netWorth.amount} format={formatCurrency} />}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {hasChange && !hideAmount
            ? `${netWorth.changeAmount > 0 ? "+" : ""}${formatCurrency(netWorth.changeAmount)} (${netWorth.changePercent}%) this month`
            : "Everything you own, minus everything you owe"}
        </p>
        {!isLoading && netWorth.assets != null && netWorth.debt != null && (
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-xs text-muted-foreground">Assets</dt>
              <dd className="font-semibold text-foreground tabular-nums">{hideAmount ? "••••" : formatCurrency(netWorth.assets)}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-xs text-muted-foreground">Debt</dt>
              <dd className="font-semibold text-expense tabular-nums">{hideAmount ? "••••" : formatCurrency(netWorth.debt)}</dd>
              {!hideAmount && (netWorth.loanDebt ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">incl. {formatCurrency(netWorth.loanDebt!)} loans/EMI</span>
              )}
              {!hideAmount && (netWorth.peopleDebt ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">incl. {formatCurrency(netWorth.peopleDebt!)} owed to people</span>
              )}
            </div>
            {(netWorth.heldForPeople ?? 0) > 0 && (
              <div className="flex items-baseline gap-1.5">
                <dt className="text-xs text-muted-foreground">Held for people</dt>
                <dd className="font-semibold text-foreground tabular-nums">{hideAmount ? "••••" : formatCurrency(netWorth.heldForPeople!)}</dd>
                {!hideAmount && <span className="text-xs text-muted-foreground">advances not yet applied</span>}
              </div>
            )}
          </dl>
        )}
      </div>

      <div className="relative flex items-end justify-between gap-4">
        {hasTrend ? (
          <div className="h-12 w-full max-w-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={netWorth.trend.map((v) => ({ v }))} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
                <defs>
                  <linearGradient id="net-worth-trend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary-accent-text)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--primary-accent-text)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="v" stroke="var(--primary-accent-text)" strokeWidth={2} strokeLinecap="round" fill="url(#net-worth-trend)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
            <p className="text-[10.5px] text-muted-foreground">Last 7 days</p>
          </div>
        ) : (
          <span />
        )}
        <Link
          href="/accounts"
          className="flex h-8 shrink-0 items-center gap-1 rounded-[6px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          Accounts
          <ArrowRight className="size-3.5" strokeWidth={2} />
        </Link>
      </div>
    </section>
  );
}
