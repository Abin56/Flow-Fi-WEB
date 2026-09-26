"use client";

import { KpiGrid } from "@/components/analytics/kpi-grid";
import { MetricCard } from "@/components/analytics/metric-card";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { FloatingCard } from "@/components/foundation/floating-card";
import { SectionHeader } from "@/components/foundation/section-header";
import { HistoryGapNotice } from "@/features/reports/components/history-gap-notice";
import type { ReportsData } from "@/features/reports/hooks/use-reports-data";
import { formatCurrencyCompact } from "@/lib/format";

function BreakdownBars({ items, color, total }: { items: { name: string; value: number }[]; color: string; total: number }) {
  if (items.length === 0 || total <= 0) {
    return <p className="text-sm text-muted-foreground">Nothing to show yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.name}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{item.name}</span>
            <span className="font-medium tabular-nums text-foreground">{formatCurrencyCompact(item.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: `${(item.value / total) * 100}%`, background: color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function NetWorthTab({ data }: { data: ReportsData }) {
  const { netWorth, assetsByAccountType, liabilitiesBreakdown, totalLiabilities, totalReceivables } = data;
  const assetsTotal = assetsByAccountType.reduce((s, a) => s + a.value, 0);

  return (
    <Stagger className="flex flex-col gap-6">
      <StaggerItem>
        <KpiGrid>
          <MetricCard label="Net Worth" value={netWorth.amount} format={formatCurrencyCompact} />
          <MetricCard label="Owed to Me" value={totalReceivables} format={formatCurrencyCompact} />
          <MetricCard label="Total Liabilities" value={totalLiabilities} format={formatCurrencyCompact} upIsGood={false} />
        </KpiGrid>
        <p className="mt-3 text-xs text-muted-foreground">
          Net Worth is your account balances, plus loan principal owed to you, minus loan and EMI principal you
          owe. Credit card debt is already inside your card account balances, and a card EMI is counted once, on
          its card. Future interest isn&apos;t counted.
        </p>
      </StaggerItem>

      <StaggerItem>
        <HistoryGapNotice title="Net worth trend not yet available" />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <FloatingCard interactive={false} elevation={1}>
            <SectionHeader eyebrow="Breakdown" title="Assets by account type" className="mb-4" />
            <BreakdownBars items={assetsByAccountType} color="var(--success)" total={assetsTotal} />
          </FloatingCard>
          <FloatingCard interactive={false} elevation={1}>
            <SectionHeader eyebrow="Breakdown" title="Liabilities" className="mb-4" />
            <BreakdownBars items={liabilitiesBreakdown} color="var(--expense)" total={totalLiabilities} />
          </FloatingCard>
        </div>
      </StaggerItem>
    </Stagger>
  );
}
