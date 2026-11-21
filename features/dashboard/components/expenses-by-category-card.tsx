"use client";

import { useState } from "react";
import { PieChart as PieChartIcon } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { DashEmpty, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const DOT_COLOR = {
  purple: "bg-purple",
  pink: "bg-expense",
  warning: "bg-warning",
  info: "bg-royal",
  success: "bg-success",
  muted: "bg-muted-foreground/50",
} as const;

const CHART_COLOR: Record<keyof typeof DOT_COLOR, string> = {
  purple: "var(--purple)",
  pink: "var(--expense)",
  warning: "var(--warning)",
  info: "var(--royal)",
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

/**
 * `expensesByCategory` is grouped from real expense Transactions this month, joined to Category names, in
 * `useDashboardData`. Hovering a slice or a legend row focuses that category: the centre shows its amount and the
 * legend row's share bar is emphasised; the rest dims.
 */
export function ExpensesByCategoryCard({ expensesByCategory, isLoading }: ExpensesByCategoryCardProps) {
  const [active, setActive] = useState<number | null>(null);
  const focused = active != null ? expensesByCategory.items[active] : undefined;

  return (
    <DashPanel label="Expenses by category">
      <DashPanelHeader icon={PieChartIcon} title="Spending by category" href="/reports" hrefLabel="Full report" />
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
        <div className="flex flex-1 items-center gap-5 px-4 py-3">
          <div className="relative size-32 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={expensesByCategory.items}
                  dataKey="amount"
                  nameKey="category"
                  innerRadius="68%"
                  outerRadius="100%"
                  paddingAngle={2}
                  cornerRadius={3}
                  stroke="none"
                  animationDuration={700}
                  onMouseEnter={(_, index) => setActive(index)}
                  onMouseLeave={() => setActive(null)}
                >
                  {expensesByCategory.items.map((item, i) => (
                    <Cell
                      key={item.category}
                      fill={CHART_COLOR[item.color]}
                      fillOpacity={active == null || active === i ? 1 : 0.28}
                      style={{ transition: "fill-opacity 160ms ease", cursor: "pointer", outline: "none" }}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
              <span className="max-w-full truncate text-[9.5px] font-semibold tracking-wide text-muted-foreground uppercase">{focused ? focused.category : "Total"}</span>
              <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(focused ? focused.amount : expensesByCategory.total)}</span>
              {focused && <span className="text-[10.5px] font-semibold text-muted-foreground tabular-nums">{focused.percent}%</span>}
            </div>
          </div>

          <ul className="min-w-0 flex-1">
            {expensesByCategory.items.map((item, i) => (
              <li
                key={item.category}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                className={cn("-mx-1.5 rounded-[6px] px-1.5 py-1 text-xs transition-[background-color,opacity] duration-150", active === i && "bg-secondary/60", active != null && active !== i && "opacity-55")}
              >
                <div className="flex items-center gap-2">
                  <span className={cn("size-2.5 shrink-0 rounded-[3px]", DOT_COLOR[item.color])} aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.category}</span>
                  <span className="shrink-0 font-bold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
                  <span className="w-9 shrink-0 text-right text-muted-foreground tabular-nums">{item.percent}%</span>
                </div>
                <div className="mt-1 ml-[18px] h-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
                  <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out", DOT_COLOR[item.color])} style={{ width: `${Math.min(item.percent, 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DashPanel>
  );
}
