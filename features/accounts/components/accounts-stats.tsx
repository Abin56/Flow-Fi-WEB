"use client";

import { Bell, ChevronRight, Coins, Info, Landmark, Wallet } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import type { BalanceScope } from "@/features/accounts/components/balance-breakdown-sheet";
import { useAccountsStats } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import visuals from "./accounts-visuals.module.css";

/**
 * One summary panel (Loan & EMI style): Total balance leads; In banks and Cash on hand support it.
 * The change-vs-last-month and upcoming figures aren't computed yet (`useAccountsStats` reports 0 for
 * them), so they're shown as not tracked rather than as a real "0%" / "₹0".
 */
export function AccountsStats({ accountCount, onExplain }: { accountCount?: number; onExplain?: (scope: BalanceScope) => void }) {
  const { stats } = useAccountsStats();

  return (
    <section aria-label="Summary" className="@container overflow-hidden rounded-xl border border-border-strong/60 bg-card shadow-e1">
      <div className="grid @[43rem]:grid-cols-[minmax(14rem,1.4fr)_minmax(0,3fr)]">
        <div className={cn("relative isolate min-w-0 overflow-hidden border-b border-border px-3.5 py-3 @[43rem]:border-r @[43rem]:border-b-0 sm:px-4", visuals.summaryLead)}>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Wallet className="size-3.5 text-primary-accent-text" aria-hidden />
            Total balance
          </span>
          {onExplain ? (
            <button
              type="button"
              onClick={() => onExplain({ kind: "total" })}
              aria-label="Explain total balance"
              title="View breakdown"
              className="group mt-1 flex max-w-full items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="wrap-anywhere text-[2rem] leading-none font-bold tracking-tight tabular-nums">{formatCurrency(stats.totalBalance)}</span>
              <Info className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
            </button>
          ) : (
            <p className="mt-1 wrap-anywhere text-[2rem] leading-none font-bold tracking-tight tabular-nums">{formatCurrency(stats.totalBalance)}</p>
          )}
          <div className="my-0.5 flex flex-wrap items-center justify-between gap-x-2 empty:hidden">
            {accountCount != null && (
              <p className="text-xs text-muted-foreground">Across {accountCount} {accountCount === 1 ? "account" : "accounts"}</p>
            )}
            {onExplain && (
              <button
                type="button"
                onClick={() => onExplain({ kind: "total" })}
                className="group inline-flex min-h-7 items-center gap-0.5 rounded-md text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                View breakdown
                <ChevronRight className="size-3.5 motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" aria-hidden />
              </button>
            )}
          </div>
          <BalanceSplit total={stats.totalBalance} banks={stats.totalInBanks} cash={stats.cashOnHand} />
        </div>

        <div className="grid min-w-0 grid-cols-2 gap-px bg-border @[30rem]:grid-cols-3">
          <Figure icon={Landmark} label="In banks" value={formatCurrency(stats.totalInBanks)} onExplain={onExplain && (() => onExplain({ kind: "banks" }))} />
          <Figure icon={Coins} label="Cash on hand" value={formatCurrency(stats.cashOnHand)} onExplain={onExplain && (() => onExplain({ kind: "cash" }))} />
          <Figure icon={Bell} label="Upcoming · 7 days" value={null} />
        </div>
      </div>
    </section>
  );
}

/** Where the total sits — banks / cash / everything else — as one bar. Display only, from the same stats. */
function BalanceSplit({ total, banks, cash }: { total: number; banks: number; cash: number }) {
  const reduceMotion = useReducedMotion();
  if (total <= 0) return null;
  const other = Math.max(0, total - Math.max(0, banks) - Math.max(0, cash));
  const parts = [
    { key: "banks", label: "Banks", value: Math.max(0, banks), color: "var(--success)" },
    { key: "cash", label: "Cash", value: Math.max(0, cash), color: "var(--warning)" },
    { key: "other", label: "Other", value: other, color: "var(--muted-foreground)" },
  ].filter((p) => p.value > 0.005);
  const sum = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div className="mt-0.5 flex flex-col gap-1">
      <div className="flex h-1 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
        {parts.map((p, i) => (
          <motion.span
            key={p.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ background: p.color }}
            initial={reduceMotion ? false : { width: 0 }}
            animate={{ width: `${(p.value / sum) * 100}%` }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.5, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
          />
        ))}
      </div>
      <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: p.color }} />
            {p.label} <span className="font-semibold text-foreground tabular-nums">{Math.round((p.value / sum) * 100)}%</span>
          </span>
        ))}
      </p>
    </div>
  );
}

function Figure({ icon: Icon, label, value, onExplain }: { icon: typeof Bell; label: string; value: string | null; onExplain?: () => void }) {
  const Wrapper = onExplain ? "button" : "div";
  return (
    <Wrapper
      {...(onExplain ? { type: "button" as const, onClick: onExplain, "aria-label": `Explain ${label.toLowerCase()}`, title: "See how this is calculated" } : {})}
      className={cn(
        "flex min-w-0 items-center gap-2 bg-card px-2.5 py-2 text-left @[43rem]:px-3.5",
        onExplain && "group outline-none motion-safe:transition-colors hover:bg-secondary/55 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        value == null && "col-span-2 @[30rem]:col-span-1",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
      </span>
      <div className={cn("min-w-0", value == null && "flex flex-wrap items-center gap-x-2 @[30rem]:block")}>
        <p className="text-xs leading-snug font-medium text-muted-foreground">{label}</p>
        {value != null ? (
          <p className="mt-0.5 wrap-anywhere text-base leading-tight font-semibold text-foreground tabular-nums">{value}</p>
        ) : (
          <p className="text-xs leading-tight font-medium text-foreground @[30rem]:mt-0.5">Not tracked yet</p>
        )}
      </div>
      {onExplain && (
        <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" aria-hidden />
      )}
    </Wrapper>
  );
}
