"use client";

import { PieChart as PieChartIcon } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { EmptyState } from "@/components/finance/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
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
  if (isLoading) {
    return (
      <section className="surface-flat flex h-full flex-col gap-4 rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-40" />
        <div className="flex items-center gap-4">
          <Skeleton className="size-32 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-3.5 w-full" />
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (expensesByCategory.items.length === 0) {
    return (
      <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
        <h2 className="text-sm font-semibold text-foreground">Expenses by Category</h2>
        <EmptyState
          icon={PieChartIcon}
          title="No expenses this month"
          description="Expense transactions will show up here once logged."
          className="flex-1"
        />
      </section>
    );
  }

  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <h2 className="text-sm font-semibold text-foreground">Expenses by Category</h2>

      <div className="mt-2 flex items-center gap-4">
        <div className="relative size-32 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={expensesByCategory.items}
                dataKey="amount"
                nameKey="category"
                innerRadius="70%"
                outerRadius="100%"
                paddingAngle={2}
                stroke="none"
              >
                {expensesByCategory.items.map((item) => (
                  <Cell key={item.category} fill={CHART_COLOR[item.color]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] text-muted-foreground">Total</span>
            <span className="text-sm font-bold tabular-nums text-foreground">
              {formatCurrency(expensesByCategory.total)}
            </span>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {expensesByCategory.items.map((item) => (
            <div key={item.category} className="flex items-center gap-2 text-xs">
              <span className={cn("size-2 shrink-0 rounded-full", DOT_COLOR[item.color])} />
              <span className="min-w-0 flex-1 truncate text-foreground">{item.category}</span>
              <span className="shrink-0 font-medium tabular-nums text-foreground">{formatCurrency(item.amount)}</span>
              <span className="w-8 shrink-0 text-right text-muted-foreground">{item.percent}%</span>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="mt-4 rounded-xl bg-muted/70 py-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
      >
        View Full Report
      </button>
    </section>
  );
}
