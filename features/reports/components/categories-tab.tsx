"use client";

import { useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Receipt } from "lucide-react";
import { ChartContainer } from "@/components/analytics/chart-container";
import { ChartLegend } from "@/components/analytics/legend";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";
import { ExportPanel } from "@/components/analytics/export-panel";
import { FilterBar } from "@/components/analytics/filter-bar";
import { EmptyState } from "@/components/finance";
import { FloatingCard } from "@/components/foundation/floating-card";
import type { ReportsData } from "@/features/reports/hooks/use-reports-data";
import { axisStyle } from "@/lib/charts/theme";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

const FILTERS = ["All", "Over Budget", "Under Budget"] as const;

export function CategoriesTab({ data }: { data: ReportsData }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const { categorySpending } = data;

  if (categorySpending.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No spending yet this month"
        description="Category totals will appear here once you log expense transactions."
      />
    );
  }

  const filtered = categorySpending.filter((c) => {
    if (filter === "Over Budget") return c.budget != null && c.amount > c.budget;
    if (filter === "Under Budget") return c.budget == null || c.amount <= c.budget;
    return true;
  });

  // Recharts needs a plain number for the "budget" bar — categories with no real Budget document
  // simply render no budget bar (0), never a fabricated limit.
  const chartData = filtered.map((c) => ({ ...c, budgetBar: c.budget ?? 0 }));

  return (
    <div className="flex flex-col gap-6">
      <FilterBar options={[...FILTERS]} value={filter} onChange={(v) => setFilter(v as (typeof FILTERS)[number])} />

      {filtered.length === 0 ? (
        <EmptyState icon={Receipt} title="No categories match this filter" />
      ) : (
        <>
          <ChartContainer
            eyebrow="Categories"
            title="Spent vs. budget"
            toolbar={<ExportPanel />}
            legend={
              <ChartLegend
                entries={[
                  { label: "Spent", color: "var(--primary)" },
                  { label: "Budget", color: "var(--muted-foreground)", dashed: true },
                ]}
              />
            }
            height={Math.max(240, filtered.length * 44)}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                <XAxis type="number" {...axisStyle} tickFormatter={formatCurrencyCompact} />
                <YAxis type="category" dataKey="category" {...axisStyle} width={110} />
                <Tooltip content={<ChartTooltip formatter={formatCurrency} />} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
                <Bar dataKey="budgetBar" name="Budget" fill="var(--muted)" radius={[0, 4, 4, 0]} maxBarSize={16} />
                <Bar dataKey="amount" name="Spent" radius={[0, 4, 4, 0]} maxBarSize={16}>
                  {chartData.map((c) => (
                    <Cell key={c.categoryId} fill={c.budget != null && c.amount > c.budget ? "var(--expense)" : "var(--primary)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((c) => {
              const hasBudget = c.budget != null && c.budget > 0;
              const pct = hasBudget ? (c.amount / c.budget!) * 100 : 0;
              const over = hasBudget && c.amount > c.budget!;
              return (
                <FloatingCard key={c.categoryId} interactive={false} elevation={1} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground">{c.category}</p>
                    {hasBudget && (
                      <span className={cn("text-xs font-semibold", over ? "text-expense" : "text-success")}>
                        {pct.toFixed(0)}%
                      </span>
                    )}
                  </div>
                  {hasBudget && (
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.min(pct, 100)}%`, background: over ? "var(--expense)" : "var(--primary)" }}
                      />
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(c.amount)}
                    {hasBudget ? ` of ${formatCurrency(c.budget!)}` : " · no budget set"} · {c.txns} txns
                  </p>
                </FloatingCard>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
