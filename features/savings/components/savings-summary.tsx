"use client";

import { AlertTriangle, CheckCircle2, Info, Lightbulb, Target, Trophy, Wallet } from "lucide-react";
import { useMemo } from "react";
import { AccountLabel } from "@/components/finance";
import { formatCurrency } from "@/lib/format";
import type { SavingsInsight, SavingsPosition } from "@/lib/engines/savings-goals";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";

const INSIGHT_STYLE: Record<SavingsInsight["tone"], { icon: typeof Info; cls: string }> = {
  good: { icon: CheckCircle2, cls: "text-success" },
  warn: { icon: AlertTriangle, cls: "text-warning-foreground dark:text-warning" },
  bad: { icon: AlertTriangle, cls: "text-expense" },
  info: { icon: Info, cls: "text-muted-foreground" },
};

function Chip({ icon: Icon, label, value }: { icon: typeof Target; label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-muted/40 px-2.5 py-1.5 sm:flex-row sm:items-center sm:gap-2 sm:px-3 sm:py-2">
      <Icon className="hidden size-3.5 shrink-0 text-muted-foreground sm:block" />
      <div className="min-w-0">
        <p className="truncate text-[10px] text-muted-foreground sm:text-[11px]">{label}</p>
        <p className="truncate font-mono text-xs leading-tight font-semibold tabular-nums text-foreground sm:text-[13px]">{value}</p>
      </div>
    </div>
  );
}

/** One compact band: total saved + overall progress, key counts, where the money sits, and the top insights. */
export function SavingsSummary({ position, accounts }: { position: SavingsPosition; accounts: Account[] }) {
  const { totals, insights, reservedByAccount } = position;
  const pct = Math.round(totals.progress * 100);
  const where = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return Array.from(reservedByAccount.entries())
      .map(([id, amount]) => ({ account: byId.get(id), amount }))
      .filter((r): r is { account: Account; amount: number } => r.account != null && r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  }, [reservedByAccount, accounts]);

  return (
    <section className="surface-flat grid gap-4 rounded-3xl border border-border/50 p-4 sm:p-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]" data-testid="savings-summary" aria-label="Savings summary">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Total saved</p>
            <p className="truncate font-mono text-3xl leading-tight font-bold tracking-tight tabular-nums text-foreground" data-testid="total-saved">
              {formatCurrency(totals.saved)}
            </p>
          </div>
          <p className="shrink-0 pb-1 text-xs text-muted-foreground">
            of <span className="font-mono font-semibold text-foreground">{formatCurrency(totals.target)}</span> · {pct}%
          </p>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Overall savings progress">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
          <Chip icon={Wallet} label="To save" value={formatCurrency(totals.remaining)} />
          <Chip icon={Target} label="Active" value={String(totals.openCount)} />
          <Chip icon={Trophy} label="Completed" value={String(totals.completedCount)} />
          <Chip icon={AlertTriangle} label="Overdue" value={String(totals.overdueCount)} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-3 lg:border-l lg:border-border/50 lg:pl-5">
        {where.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Held in</p>
            <ul className="flex flex-wrap gap-1.5">
              {where.slice(0, 4).map(({ account, amount }) => (
                <li key={account.id} className="inline-flex items-center gap-1.5 rounded-full bg-muted/50 py-1 pr-2.5 pl-1.5 text-xs">
                  <AccountLabel account={account} size={14} showKind={false} className="max-w-32" />
                  <span className="font-mono font-semibold tabular-nums">{formatCurrency(amount)}</span>
                </li>
              ))}
              {where.length > 4 && <li className="self-center text-[11px] text-muted-foreground">+{where.length - 4} more</li>}
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <Lightbulb className="size-3" /> Insights
          </p>
          {insights.length === 0 ? (
            <p className="text-xs text-muted-foreground">{totals.saved > 0 ? "Everything looks on track." : "Set aside your first amount and insights will appear here."}</p>
          ) : (
            <ul className="flex flex-col gap-1.5" data-testid="savings-insights">
              {insights.map((i) => {
                const { icon: Icon, cls } = INSIGHT_STYLE[i.tone];
                return (
                  <li key={i.id} className="flex items-start gap-2 text-xs leading-snug text-foreground/85">
                    <Icon className={cn("mt-0.5 size-3.5 shrink-0", cls)} />
                    <span>{i.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
