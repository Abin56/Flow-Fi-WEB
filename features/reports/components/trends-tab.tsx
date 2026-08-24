"use client";

import { KpiGrid } from "@/components/analytics/kpi-grid";
import { MetricCard } from "@/components/analytics/metric-card";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { SectionHeader } from "@/components/foundation/section-header";
import { HistoryGapNotice } from "@/features/reports/components/history-gap-notice";
import type { ReportsData } from "@/features/reports/hooks/use-reports-data";
import { formatCurrencyCompact } from "@/lib/format";

/**
 * The mock's `trendHighlights` (deltas vs. a prior period), the savings-rate
 * *history* line chart, and the hardcoded narrative timeline all need
 * multi-month history that doesn't exist yet (see
 * `features/reports/hooks/use-reports-data.ts`'s doc comment) — this tab is
 * reduced to this month's real figures with no invented deltas/sparklines,
 * plus an honest placeholder where the narrative timeline used to cite
 * specific fabricated numbers.
 */
export function TrendsTab({ data }: { data: ReportsData }) {
  const { cashFlow } = data;

  return (
    <Stagger className="flex flex-col gap-6">
      <StaggerItem>
        <KpiGrid>
          <MetricCard label="Income (This Month)" value={cashFlow.income} format={formatCurrencyCompact} />
          <MetricCard label="Expense (This Month)" value={cashFlow.expenses} format={formatCurrencyCompact} />
          <MetricCard label="Net Savings (This Month)" value={cashFlow.net} format={formatCurrencyCompact} />
          <MetricCard label="Savings Rate (This Month)" value={cashFlow.savingsRate} format={(v) => `${v.toFixed(1)}%`} />
        </KpiGrid>
        <p className="mt-3 text-xs text-muted-foreground">
          These are this month&apos;s real figures. Month-over-month deltas and multi-month averages aren&apos;t
          shown because no balance/spend history is tracked yet.
        </p>
      </StaggerItem>

      <StaggerItem>
        <HistoryGapNotice title="Savings rate trend not yet available" />
      </StaggerItem>

      <StaggerItem>
        <SectionHeader eyebrow="Story" title="Notable moments" className="mb-4" />
        <div className="rounded-3xl border border-border/60 bg-card p-6" style={{ boxShadow: "var(--shadow-e2)" }}>
          <p className="text-sm text-muted-foreground">
            AI-generated trend narratives (Milestone 12) aren&apos;t built yet. Once that engine lands, notable
            moments across your real transaction history will surface here instead of this placeholder.
          </p>
        </div>
      </StaggerItem>
    </Stagger>
  );
}
