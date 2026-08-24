"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Receipt } from "lucide-react";
import { ChartContainer } from "@/components/analytics/chart-container";
import { ChartLegend } from "@/components/analytics/legend";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";
import { ExportPanel } from "@/components/analytics/export-panel";
import { HeatMap } from "@/components/analytics/heat-map";
import { KpiGrid } from "@/components/analytics/kpi-grid";
import { MetricCard } from "@/components/analytics/metric-card";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { EmptyState } from "@/components/finance";
import type { ReportsData } from "@/features/reports/hooks/use-reports-data";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";

const SLICE_COLORS = ["var(--primary)", "var(--purple)", "var(--success)", "var(--chart-2)", "var(--warning)", "var(--chart-3)", "var(--chart-4)"];

export function SpendingTab({ data }: { data: ReportsData }) {
  const { categorySpending, spendingHeatmap } = data;

  if (categorySpending.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No spending yet this month"
        description="Once you log expense transactions, this month's category breakdown and spend intensity will show up here."
      />
    );
  }

  const total = categorySpending.reduce((s, c) => s + c.amount, 0);
  const totalTxns = categorySpending.reduce((s, c) => s + c.txns, 0);
  const overBudget = categorySpending.filter((c) => c.budget != null && c.amount > c.budget);
  const avgTxn = totalTxns > 0 ? total / totalTxns : 0;
  const topCategory = categorySpending[0];

  return (
    <Stagger className="flex flex-col gap-6">
      <StaggerItem>
        <KpiGrid>
          <MetricCard label="Total Spending" value={total} format={formatCurrencyCompact} upIsGood={false} />
          <MetricCard label="Top Category" value={topCategory.amount} format={formatCurrencyCompact} />
          <MetricCard label="Categories Over Budget" value={overBudget.length} format={(v) => `${v}`} upIsGood={false} />
          <MetricCard label="Avg. Transaction" value={avgTxn} format={formatCurrencyCompact} />
        </KpiGrid>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <ChartContainer
            eyebrow="Spending"
            title="Share by category"
            className="lg:col-span-1"
            height={260}
            toolbar={<ExportPanel />}
            legend={
              <ChartLegend
                entries={categorySpending.map((c, i) => ({ label: c.category, color: SLICE_COLORS[i % SLICE_COLORS.length] }))}
                className="grid grid-cols-1 gap-1.5"
              />
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip content={<ChartTooltip formatter={formatCurrency} />} />
                <Pie data={categorySpending} dataKey="amount" nameKey="category" innerRadius="55%" outerRadius="85%" paddingAngle={2} strokeWidth={0}>
                  {categorySpending.map((c, i) => (
                    <Cell key={c.categoryId} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </ChartContainer>

          {spendingHeatmap.categories.length > 0 ? (
            <HeatMap
              title="Spending intensity by week"
              description="Category x week-of-month — darker means more spent"
              rows={spendingHeatmap.categories}
              columns={spendingHeatmap.weeks}
              values={spendingHeatmap.values}
              format={formatCurrency}
              className="lg:col-span-2"
            />
          ) : (
            <div className="lg:col-span-2">
              <EmptyState icon={Receipt} title="Not enough data for an intensity grid yet" />
            </div>
          )}
        </div>
      </StaggerItem>
    </Stagger>
  );
}
