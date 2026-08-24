"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { ChartContainer } from "@/components/analytics/chart-container";
import { ChartLegend } from "@/components/analytics/legend";
import { ChartToolbar } from "@/components/analytics/chart-toolbar";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";
import { ComparisonCard } from "@/components/analytics/comparison-card";
import { ExportPanel } from "@/components/analytics/export-panel";
import { KpiGrid } from "@/components/analytics/kpi-grid";
import { MetricCard } from "@/components/analytics/metric-card";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { HistoryGapNotice } from "@/features/reports/components/history-gap-notice";
import type { ReportsData } from "@/features/reports/hooks/use-reports-data";
import { axisStyle } from "@/lib/charts/theme";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";

export function CashFlowTab({ data }: { data: ReportsData }) {
  const { cashFlow } = data;

  return (
    <Stagger className="flex flex-col gap-6">
      <StaggerItem>
        <KpiGrid>
          <MetricCard label="Total Income (This Month)" value={cashFlow.income} format={formatCurrencyCompact} />
          <MetricCard label="Total Expense (This Month)" value={cashFlow.expenses} format={formatCurrencyCompact} />
          <MetricCard label="Net Cash Flow" value={cashFlow.net} format={formatCurrencyCompact} />
          <MetricCard label="Savings Rate" value={cashFlow.savingsRate} format={(v) => `${v.toFixed(1)}%`} />
        </KpiGrid>
      </StaggerItem>

      <StaggerItem>
        <ChartContainer
          eyebrow="Cash Flow"
          title="This month, by week"
          toolbar={
            <ChartToolbar>
              <ExportPanel />
            </ChartToolbar>
          }
          legend={<ChartLegend entries={[{ label: "Expense", color: "var(--expense)" }]} />}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cashFlow.weeks} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barGap={4}>
              <XAxis dataKey="label" {...axisStyle} />
              <Tooltip content={<ChartTooltip formatter={formatCurrency} />} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
              <Bar dataKey="value" name="Expense" fill="var(--expense)" radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <HistoryGapNotice title="Multi-month forecast not yet available" className="lg:col-span-2" />
          <ComparisonCard
            title="This Month"
            a={{ label: "Income", value: cashFlow.income, color: "var(--success)" }}
            b={{ label: "Expense", value: cashFlow.expenses, color: "var(--expense)" }}
            format={formatCurrencyCompact}
          />
        </div>
      </StaggerItem>
    </Stagger>
  );
}
