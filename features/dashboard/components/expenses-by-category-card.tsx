"use client";

import { PieChart as PieChartIcon } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { DashEmpty, DashFooterLink, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const DOT_COLOR = {
  purple: "bg-purple",
  pink: "bg-expense",
  warning: "bg-warning",
  info: "bg-blue-500",
  success: "bg-success",
  muted: "bg-muted-foreground/50",
} as const;

const CHART_COLOR: Record<keyof typeof DOT_COLOR, string> = {
  purple: "var(--purple)",
  pink: "var(--expense)",
  warning: "var(--warning)",
  info: "#3b82f6",
  success: "var(--success)",
  muted: "var(--muted-foreground)",
};

export interface ExpensesByCategoryCardProps {
  expensesByCategory: {
    total: number;
    items: {
      category: string;
      amount: number;
      percent: number;
      color: keyof typeof DOT_COLOR;
    }[];
  };
  isLoading?: boolean;
}

/** `expensesByCategory` is grouped from real expense Transactions this month, joined to Category names, in `useDashboardData`. */
export function ExpensesByCategoryCard({ expensesByCategory, isLoading }: ExpensesByCategoryCardProps) {
  return (
    <DashPanel label="Expenses by category">
      <DashPanelHeader icon={PieChartIcon} title="Spending by category" />
      {isLoading ? (
        <div className="flex items-center gap-4 p-4">
          <Skeleton className="size-28 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-3.5 w-full" />
            ))}
          </div>
        </div>
      ) : expensesByCategory.items.length === 0 ? (
        <DashEmpty title="No expenses this month" description="Expense transactions will show up here once logged." />
      ) : (
        <div className="flex items-center gap-4 p-4">
          <div className="relative size-28 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={expensesByCategory.items} dataKey="amount" nameKey="category" innerRadius="70%" outerRadius="100%" paddingAngle={2} stroke="none">
                  {expensesByCategory.items.map((item) => (
                    <Cell key={item.category} fill={CHART_COLOR[item.color]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[9px] font-semibold tracking-wide text-muted-foreground uppercase">Total</span>
              <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(expensesByCategory.total)}</span>
            </div>
          </div>

          <div className="min-w-0 flex-1 divide-y divide-border-strong/40">
            {expensesByCategory.items.map((item) => (
              <div key={item.category} className="flex items-center gap-2 py-1.5 text-xs">
                <span className={cn("size-2.5 shrink-0 rounded-full", DOT_COLOR[item.color])} />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.category}</span>
                <span className="shrink-0 font-bold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
                <span className="w-9 shrink-0 text-right text-muted-foreground tabular-nums">{item.percent}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <DashFooterLink href="/reports">Full report</DashFooterLink>
    </DashPanel>
  );
}
