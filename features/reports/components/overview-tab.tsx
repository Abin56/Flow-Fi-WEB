"use client";

import { AnalyticsHero } from "@/components/analytics/analytics-hero";
import { ComparisonCard } from "@/components/analytics/comparison-card";
import { ExportPanel } from "@/components/analytics/export-panel";
import { InsightCard } from "@/components/analytics/insight-card";
import { KpiGrid } from "@/components/analytics/kpi-grid";
import { MetricCard } from "@/components/analytics/metric-card";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { SectionHeader } from "@/components/foundation/section-header";
import { HistoryGapNotice } from "@/features/reports/components/history-gap-notice";
import type { ReportsData } from "@/features/reports/hooks/use-reports-data";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";

export function OverviewTab({ data }: { data: ReportsData }) {
  const { netWorth, cashFlow } = data;

  return (
    <Stagger className="flex flex-col gap-6">
      <StaggerItem>
        <AnalyticsHero
          eyebrow="Reports"
          title="Financial Overview"
          value={netWorth.amount}
          format={formatCurrency}
          action={<ExportPanel />}
        />
      </StaggerItem>

      <StaggerItem>
        <KpiGrid>
          <MetricCard label="Money In (This Month)" value={cashFlow.income} format={formatCurrencyCompact} />
          <MetricCard label="Money Out (This Month)" value={cashFlow.expenses} format={formatCurrencyCompact} />
          <MetricCard label="Net Savings" value={cashFlow.net} format={formatCurrencyCompact} />
          <MetricCard label="Savings Rate" value={cashFlow.savingsRate} format={(v) => `${v.toFixed(1)}%`} />
        </KpiGrid>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <HistoryGapNotice title="Net worth trend not yet available" className="lg:col-span-2" />
          <ComparisonCard
            title="This Month"
            a={{ label: "Income", value: cashFlow.income, color: "var(--success)" }}
            b={{ label: "Expense", value: cashFlow.expenses, color: "var(--expense)" }}
            format={formatCurrencyCompact}
          />
        </div>
      </StaggerItem>

      <StaggerItem>
        <SectionHeader eyebrow="Insights" title="What stands out" className="mb-4" />
        <InsightCard
          headline="AI Insights are coming soon."
          detail="Automated narrative insights (Milestone 12) aren't built yet — this section will surface personalized callouts once that engine lands."
          tone="neutral"
        />
      </StaggerItem>
    </Stagger>
  );
}
