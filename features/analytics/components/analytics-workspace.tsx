"use client";

import { TrendingUp } from "lucide-react";
import { Bar, BarChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AnalyticsHero } from "@/components/analytics/analytics-hero";
import { ChartContainer } from "@/components/analytics/chart-container";
import { ChartLegend } from "@/components/analytics/legend";
import { ChartTooltip } from "@/components/analytics/chart-tooltip";
import { InsightCard } from "@/components/analytics/insight-card";
import { KpiGrid } from "@/components/analytics/kpi-grid";
import { MetricCard } from "@/components/analytics/metric-card";
import { EmptyState } from "@/components/finance/empty-state";
import { FloatingCard } from "@/components/foundation/floating-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalyticsData } from "@/features/analytics/hooks/use-analytics-data";
import { axisStyle } from "@/lib/charts/theme";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";

export function AnalyticsWorkspace() {
  const data = useAnalyticsData();

  if (data.isLoading) {
    return (
      <div className="flex flex-col gap-6 pb-6">
        <Skeleton className="h-56 w-full rounded-3xl" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-80 w-full rounded-3xl" />
      </div>
    );
  }

  const spendingSparkline = data.spendingTrend.map((m) => m.value);

  return (
    <div className="flex flex-col gap-6 pb-6">
      <AnalyticsHero
        eyebrow="Analytics"
        title="Spending trends"
        value={data.thisMonthSpend}
        format={formatCurrency}
        delta={data.spendDelta}
        deltaDirection={data.spendDelta >= 0 ? "up" : "down"}
        upIsGood={false}
        sparkline={spendingSparkline}
      />

      <KpiGrid>
        <MetricCard
          label="This Month Spend"
          value={data.thisMonthSpend}
          format={formatCurrency}
          delta={data.spendDelta}
          deltaDirection={data.spendDelta >= 0 ? "up" : "down"}
          upIsGood={false}
          sparkline={spendingSparkline}
        />
        <MetricCard
          label="Savings Rate"
          value={data.healthIndicators.savingsRate}
          format={(v) => `${v.toFixed(1)}%`}
          upIsGood
        />
        <MetricCard
          label="Budget Adherence"
          value={data.healthIndicators.budgetAdherence ?? 0}
          format={(v) => (data.healthIndicators.budgetAdherence == null ? "No budgets" : `${v.toFixed(0)}%`)}
          upIsGood
        />
        <MetricCard
          label="Top Category"
          value={data.topCategories[0]?.amount ?? 0}
          format={formatCurrency}
          upIsGood={false}
        />
      </KpiGrid>

      <ChartContainer
        eyebrow="Trends"
        title="Income vs. spending"
        description="Last 6 months, from your recorded transactions."
        legend={
          <ChartLegend
            entries={[
              { label: "Income", color: "var(--success)" },
              { label: "Spending", color: "var(--expense)" },
            ]}
          />
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.spendingTrend.map((m, i) => ({ label: m.label, spending: m.value, income: data.incomeTrend[i]?.value ?? 0 }))}>
            <XAxis dataKey="label" {...axisStyle} />
            <YAxis {...axisStyle} tickFormatter={formatCurrencyCompact} />
            <Tooltip content={<ChartTooltip formatter={formatCurrency} />} />
            <Line type="monotone" dataKey="income" name="Income" stroke="var(--success)" strokeWidth={2} dot={false} />
            <Line
              type="monotone"
              dataKey="spending"
              name="Spending"
              stroke="var(--expense)"
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartContainer>

      <ChartContainer
        eyebrow="Categories"
        title="Highest expense categories"
        description="This month's real expense totals, grouped by category."
        height={Math.max(220, data.topCategories.length * 40)}
      >
        {data.topCategories.length === 0 ? (
          <EmptyState icon={TrendingUp} title="No spending yet this month" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.topCategories} layout="vertical" margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
              <XAxis type="number" {...axisStyle} tickFormatter={formatCurrencyCompact} />
              <YAxis type="category" dataKey="category" {...axisStyle} width={110} />
              <Tooltip content={<ChartTooltip formatter={formatCurrency} />} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
              <Bar dataKey="amount" name="Spent" fill="var(--primary)" radius={[0, 4, 4, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartContainer>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Monthly Insights</h2>
        {data.categoryMovers.length === 0 ? (
          <FloatingCard interactive={false} elevation={1}>
            <EmptyState icon={TrendingUp} title="Not enough data yet" description="Insights appear once you have spending in two consecutive months." />
          </FloatingCard>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.categoryMovers.map((mover) => (
              <InsightCard
                key={mover.categoryId}
                tone={mover.delta > 0 ? "warning" : "success"}
                headline={`${mover.category} ${mover.delta >= 0 ? "up" : "down"} ${Math.abs(mover.delta).toFixed(0)}%`}
                detail={`${formatCurrency(mover.current)} this month vs. ${formatCurrency(mover.previous)} last month.`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
