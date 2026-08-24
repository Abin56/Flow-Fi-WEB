"use client";

import { Expand } from "lucide-react";
import { Bar, BarChart, Cell, ResponsiveContainer } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";

export interface CashFlowCardProps {
  cashFlow: {
    income: number;
    expenses: number;
    net: number;
    weeks: { label: string; value: number }[];
  };
  isLoading?: boolean;
}

/** `cashFlow` comes from `cashFlowThisMonth` (lib/engines/cash-flow.ts) via `useDashboardData`. */
export function CashFlowCard({ cashFlow, isLoading }: CashFlowCardProps) {
  if (isLoading) {
    return (
      <section className="surface-flat flex h-full flex-col gap-4 rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-24" />
        <div className="flex flex-1 items-center gap-4">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-20" />
            ))}
          </div>
          <Skeleton className="h-32 flex-1" />
        </div>
      </section>
    );
  }

  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          Cash Flow <span className="font-normal text-muted-foreground">- This Month</span>
        </h2>
        <Expand className="size-4 text-muted-foreground" />
      </div>

      <div className="mt-4 flex flex-1 items-center gap-4">
        <div className="flex flex-col gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full bg-success" /> Income
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatCurrency(cashFlow.income)}</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full bg-expense" /> Expenses
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatCurrency(cashFlow.expenses)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net Cash Flow</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatCurrency(cashFlow.net)}</p>
          </div>
        </div>

        <div className="h-32 min-w-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cashFlow.weeks} margin={{ top: 8, right: 0, bottom: 20, left: 0 }}>
              <Bar dataKey="value" radius={[4, 4, 4, 4]}>
                {cashFlow.weeks.map((week) => (
                  <Cell key={week.label} fill={week.value >= 0 ? "var(--success)" : "var(--expense)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mt-1 flex justify-around text-[11px] text-muted-foreground">
        {cashFlow.weeks.map((week) => (
          <span key={week.label}>{week.label}</span>
        ))}
      </div>
    </section>
  );
}
