"use client";

import { ArrowDownLeft, ArrowUpRight, BarChart3 } from "lucide-react";
import { Bar, BarChart, Cell, ResponsiveContainer } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

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
  return (
    <DashPanel label="Cash flow">
      <DashPanelHeader icon={BarChart3} title="Cash flow · this month" href="/month-cycle" hrefLabel="Month cycle" />
      {isLoading ? (
        <div className="flex flex-1 flex-col gap-3 p-4">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className={DASH_LABEL}>Net cash flow</p>
              <p className={cn("text-[28px] leading-tight font-bold tracking-tight tabular-nums", cashFlow.net < 0 ? "text-expense" : "text-foreground")}>
                {formatCurrency(cashFlow.net)}
              </p>
            </div>
            <div className="flex gap-4">
              <div>
                <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-success">
                  <ArrowDownLeft className="size-3" strokeWidth={2.25} />
                  Income
                </p>
                <p className="text-[15px] font-bold text-foreground tabular-nums">{formatCurrency(cashFlow.income)}</p>
              </div>
              <div>
                <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-expense">
                  <ArrowUpRight className="size-3" strokeWidth={2.25} />
                  Expenses
                </p>
                <p className="text-[15px] font-bold text-foreground tabular-nums">{formatCurrency(cashFlow.expenses)}</p>
              </div>
            </div>
          </div>

          <div className="mt-auto">
            <div className="h-24 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cashFlow.weeks} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <Bar dataKey="value" radius={[3, 3, 3, 3]}>
                    {cashFlow.weeks.map((week) => (
                      <Cell key={week.label} fill={week.value >= 0 ? "var(--success)" : "var(--expense)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 flex justify-around border-t border-border-strong/40 pt-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
              {cashFlow.weeks.map((week) => (
                <span key={week.label}>{week.label}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </DashPanel>
  );
}
