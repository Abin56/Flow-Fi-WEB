"use client";

import { Bell, Coins, Landmark, Wallet } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useAccountsStats } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

/**
 * One summary panel (Loan & EMI style): Total balance leads; In banks and Cash on hand support it.
 * The change-vs-last-month and upcoming figures aren't computed yet (`useAccountsStats` reports 0 for
 * them), so they're shown as not tracked rather than as a real "0%" / "₹0".
 */
export function AccountsStats({ accountCount }: { accountCount?: number }) {
  const { stats } = useAccountsStats();

  return (
    // Container queries (@…): the panel sizes to the room it actually has — the sidebar and the account side panel
    // take a big share of the viewport, so viewport breakpoints (lg:) squeezed the figures out of sight.
    <section aria-label="Summary" className="@container overflow-hidden rounded-[16px] border border-border-strong/60 bg-card shadow-e1">
     <div className="flex flex-col @4xl:flex-row @4xl:items-stretch">
      <div className="relative flex flex-col gap-1.5 overflow-hidden bg-gradient-to-br from-[#1d2330] via-[#262e3d] to-[#323b4d] px-5 py-5 text-white sm:px-6 @4xl:min-w-80">
        <span aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-primary/25 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-52 rounded-full border border-white/10" />
        <span className="relative inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-white/75 uppercase">
          <Wallet className="size-3.5" strokeWidth={1.9} />
          Total balance
        </span>
        <p className="relative text-[36px] leading-none font-bold tracking-tight tabular-nums sm:text-[40px]">{formatCurrency(stats.totalBalance)}</p>
        {accountCount != null && (
          <p className="relative text-xs text-white/70">
            Across <span className="font-semibold text-white">{accountCount}</span> {accountCount === 1 ? "account" : "accounts"}
          </p>
        )}
        <BalanceSplit onDark total={stats.totalBalance} banks={stats.totalInBanks} cash={stats.cashOnHand} />
      </div>

      <div className="grid min-w-0 flex-1 grid-cols-1 gap-2.5 p-3 @xl:grid-cols-3 @4xl:p-4">
        <Figure icon={Landmark} tone="bg-success/12 text-success" label="In banks" value={formatCurrency(stats.totalInBanks)} />
        <Figure icon={Coins} tone="bg-warning/20 text-warning-foreground dark:text-warning" label="Cash on hand" value={formatCurrency(stats.cashOnHand)} />
        <Figure icon={Bell} tone="bg-purple/12 text-purple" label="Upcoming · 7 days" value={null} />
      </div>
     </div>
    </section>
  );
}

/** Where the total sits — banks / cash / everything else — as one bar. Display only, from the same stats. */
function BalanceSplit({ total, banks, cash, onDark }: { total: number; banks: number; cash: number; onDark?: boolean }) {
  const reduceMotion = useReducedMotion();
  if (total <= 0) return null;
  const other = Math.max(0, total - Math.max(0, banks) - Math.max(0, cash));
  const parts = [
    { key: "banks", label: "Banks", value: Math.max(0, banks), color: "var(--success)" },
    { key: "cash", label: "Cash", value: Math.max(0, cash), color: "var(--warning)" },
    { key: "other", label: "Other", value: other, color: "var(--purple)" },
  ].filter((p) => p.value > 0.005);
  const sum = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div className="relative mt-2 flex flex-col gap-1.5">
      <div className={cn("flex h-2 w-full overflow-hidden rounded-full", onDark ? "bg-white/15" : "bg-secondary")} aria-hidden>
        {parts.map((p, i) => (
          <motion.span
            key={p.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ background: p.color }}
            initial={reduceMotion ? false : { width: 0 }}
            animate={{ width: `${(p.value / sum) * 100}%` }}
            transition={{ duration: 0.7, delay: 0.1 + i * 0.08, ease: [0.22, 1, 0.36, 1] }}
          />
        ))}
      </div>
      <p className={cn("flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]", onDark ? "text-white/75" : "text-foreground/70")}>
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            {p.label} <span className={cn("font-semibold tabular-nums", onDark ? "text-white" : "text-foreground")}>{Math.round((p.value / sum) * 100)}%</span>
          </span>
        ))}
      </p>
    </div>
  );
}

function Figure({ icon: Icon, tone, label, value }: { icon: typeof Bell; tone: string; label: string; value: string | null }) {
  return (
    <div className="flex items-center gap-3 rounded-[12px] border border-border-strong/50 bg-secondary/40 px-3.5 py-3 transition-colors hover:bg-secondary/70">
      <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-full", tone)}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className={LABEL}>{label}</p>
        {value != null ? (
          <p className="mt-0.5 text-lg leading-tight font-bold text-foreground tabular-nums">{value}</p>
        ) : (
          <p className="mt-0.5 text-sm font-medium text-muted-foreground">Not tracked yet</p>
        )}
      </div>
    </div>
  );
}
