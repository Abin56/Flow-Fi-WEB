"use client";

/**
 * Reports overview — the first screen: a six-figure KPI strip, the cash-flow chart (four views of the same periods)
 * and "Where the money went". Presentation only: every number arrives from `PeriodFigures` / `PeriodDetail` /
 * `CurrentPosition` (shared engines); nothing here computes money beyond picking which figure to draw.
 */

import { BarChart3, Table2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PeriodDetail, PeriodFigures } from "@/lib/engines/period-report";
import type { ReportPeriod } from "@/lib/engines/report-period";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CurrentPosition } from "@/features/reports/hooks/use-financial-report-data";
import { AXIS, DeltaChip, EmptyNote, FigureRow, GRID, InfoHint, LegendRow, MONEY, onIndexClick, percentLabel, RichTooltip, Segmented, SegmentedBar, signedCurrency, Sparkline } from "./report-ui";

export interface TrendPoint {
  period: ReportPeriod;
  figures: PeriodFigures;
}

// ---------------------------------------------------------------- KPI strip

export type KpiKey = "income" | "outflow" | "net" | "myspend" | "debt" | "networth";

export interface KpiSpec {
  key: KpiKey;
  label: string;
  value: number;
  format?: (v: number) => string;
  tone: string;
  delta?: number | null;
  upIsGood?: boolean;
  hint: string;
  note?: ReactNode;
  spark?: number[];
  /** Small composition bar instead of a sparkline (debt). */
  parts?: { label: string; value: number; color: string }[];
  emphasis?: boolean;
}

export function KpiStrip({ items, focusIndex, active, onPick }: { items: KpiSpec[]; focusIndex: number; active: KpiKey | null; onPick: (k: KpiKey) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-3 @5xl:grid-cols-6" data-testid="rep-kpis">
      {items.map((k) => {
        const on = active === k.key;
        return (
          // A div with button semantics — the tile holds an InfoHint button, and a <button> may not contain another.
          <div
            key={k.key}
            role="button"
            tabIndex={0}
            onClick={() => onPick(k.key)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              onPick(k.key);
            }}
            aria-pressed={on}
            data-testid={`kpi-${k.key}`}
            className={cn(
              "group relative flex min-w-0 cursor-pointer flex-col gap-1.5 overflow-hidden rounded-2xl border bg-card px-3 py-2.5 text-left shadow-e1 transition-all duration-200 hover:-translate-y-px hover:shadow-e2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              on ? "border-transparent ring-2" : "border-border/60",
              k.emphasis && !on && "bg-primary/[0.05]",
            )}
            style={on ? ({ "--tw-ring-color": `color-mix(in oklch, ${k.tone} 55%, transparent)` } as CSSProperties) : undefined}
          >
            <span className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: k.tone }} aria-hidden />
              <span className="truncate text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{k.label}</span>
              <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                <InfoHint text={k.hint} />
              </span>
            </span>
            <span className="truncate font-heading text-[1.2rem] leading-none font-semibold tracking-tight text-foreground tabular-nums" data-testid={`kpi-${k.key}-value`} data-value={k.value}>
              {(k.format ?? formatCurrency)(k.value)}
            </span>
            <span className="flex min-h-[22px] items-end justify-between gap-2">
              {k.delta !== undefined ? <DeltaChip value={k.delta} upIsGood={k.upIsGood ?? true} className="truncate" /> : <span className="min-w-0 truncate text-[11px] text-muted-foreground">{k.note}</span>}
              {k.spark && k.spark.length > 1 ? (
                <Sparkline values={k.spark} color={k.tone} focusIndex={Math.min(focusIndex, k.spark.length - 1)} width={64} height={22} />
              ) : k.parts && k.parts.length > 0 ? (
                <MiniParts parts={k.parts} />
              ) : null}
            </span>
            {k.delta !== undefined && k.note && <span className="-mt-0.5 truncate text-[11px] text-muted-foreground">{k.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

function MiniParts({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return null;
  return (
    <span className="flex h-1.5 w-16 shrink-0 gap-px overflow-hidden rounded-full" title={parts.map((p) => `${p.label} ${formatCurrencyCompact(p.value)}`).join(" · ")} aria-hidden>
      {parts.map((p) => (
        <span key={p.label} className="h-full" style={{ flexGrow: p.value, flexBasis: 0, background: p.color }} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- Cash flow chart

export type FlowView = "flow" | "net" | "spend" | "cash";

const VIEW_COPY: Record<FlowView, { title: string; legend: { label: string; color: string; line?: boolean }[] }> = {
  flow: {
    title: "Income vs outflow",
    legend: [
      { label: "Income", color: MONEY.in },
      { label: "Total outflow", color: MONEY.out },
      { label: "Net", color: MONEY.net, line: true },
    ],
  },
  net: {
    title: "Net cash flow",
    legend: [
      { label: "Saved", color: MONEY.in },
      { label: "Overspent", color: MONEY.out },
    ],
  },
  spend: {
    title: "Outflow vs my spend",
    legend: [
      { label: "Total outflow", color: MONEY.out },
      { label: "My spend", color: MONEY.spend },
    ],
  },
  cash: {
    title: "Cash in vs out",
    legend: [
      { label: "Money in", color: MONEY.in },
      { label: "Money out", color: MONEY.out },
      { label: "Net cash", color: MONEY.net, line: true },
    ],
  },
};

const VIEW_HINT: Record<FlowView, string> = {
  flow: "Income and Total outflow the Month Cycle way: card purchases when made, EMI installments when paid. Transfers, loan money and People settlements never count.",
  net: "Income − Total outflow for each period. Above zero you kept money; below zero you spent more than you earned.",
  spend: "Total outflow includes EMIs, loan payments and other people's share of split bills you paid. My spend is only your own share of purchases.",
  cash: "What actually reached or left your bank, cash and wallet accounts (the Dashboard's Money In / Money Out). Card purchases count when the card bill is paid.",
};

export function CashFlowChart({
  points,
  selected,
  onSelect,
  view,
  onView,
  windowSize,
  onWindow,
  showTable,
  onShowTable,
  recordsNote,
}: {
  points: TrendPoint[];
  selected: ReportPeriod;
  onSelect: (p: ReportPeriod) => void;
  view: FlowView;
  onView: (v: FlowView) => void;
  windowSize: "6" | "12";
  onWindow: (v: "6" | "12") => void;
  showTable: boolean;
  onShowTable: (v: boolean) => void;
  recordsNote: string | null;
}) {
  const unit = selected.kind === "cycle" && !selected.monthGranular ? "cycles" : "months";
  const sel = selected.start.getTime();
  const data = points.map(({ period, figures }) => ({
    key: period.start.getTime(),
    label: period.shortLabel,
    full: period.label,
    period,
    income: figures.income,
    outflow: figures.outflow,
    net: figures.net,
    mySpend: figures.mySpend,
    othersShare: figures.othersShare,
    cashIn: figures.cash.moneyIn,
    cashOut: figures.cash.moneyOut,
    cashNet: figures.cash.net,
    rate: figures.savingsRate,
  }));
  const hasAny = data.some((d) => d.income || d.outflow || d.cashIn || d.cashOut);
  const copy = VIEW_COPY[view];
  const dim = (key: number) => (key === sel ? 1 : 0.5);

  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border/60 bg-card p-4 shadow-e1" data-testid="rep-trend">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">{copy.title}</h2>
          <InfoHint text={VIEW_HINT[view]} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Segmented
            value={view}
            onChange={onView}
            size="xs"
            ariaLabel="Chart view"
            testId="rep-trend-view"
            options={[
              { value: "flow", label: "Income/Outflow", title: "Income vs total outflow" },
              { value: "net", label: "Net", title: "Net cash flow per period" },
              { value: "spend", label: "My spend", title: "Total outflow vs my own share" },
              { value: "cash", label: "Cash", title: "Money in vs money out of your accounts" },
            ]}
          />
          <Segmented
            value={windowSize}
            onChange={onWindow}
            size="xs"
            ariaLabel={`How many ${unit}`}
            testId="rep-window"
            options={[
              { value: "6", label: "6" },
              { value: "12", label: "12" },
            ]}
          />
          <button
            type="button"
            onClick={() => onShowTable(!showTable)}
            aria-pressed={showTable}
            aria-label={showTable ? "Show chart" : "Show as table"}
            title={showTable ? "Show chart" : "Show as table"}
            data-testid="rep-trend-table-toggle"
            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {showTable ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />}
          </button>
        </div>
      </header>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <LegendRow items={copy.legend} />
        <span className="text-[11px] text-muted-foreground">{recordsNote ?? `Last ${points.length} ${unit} · click a column to open it`}</span>
      </div>

      <div className="mt-2 h-[13.5rem] min-h-0">
        {!hasAny ? (
          <EmptyNote className="h-full">No income or outflow recorded in these periods yet.</EmptyNote>
        ) : showTable ? (
          <div className="h-full overflow-auto" data-testid="rep-trend-table">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-card text-[10.5px] tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="py-1.5 text-left font-medium">Period</th>
                  <th className="py-1.5 text-right font-medium">Income</th>
                  <th className="py-1.5 text-right font-medium">Outflow</th>
                  <th className="py-1.5 text-right font-medium">Net</th>
                  <th className="py-1.5 text-right font-medium">My spend</th>
                  <th className="py-1.5 text-right font-medium">Cash in</th>
                  <th className="py-1.5 text-right font-medium">Cash out</th>
                </tr>
              </thead>
              <tbody>
                {[...data].reverse().map((d) => (
                  <tr key={d.key} onClick={() => onSelect(d.period)} className={cn("cursor-pointer border-t border-border/50 hover:bg-muted/50", d.key === sel && "bg-primary/[0.06] font-medium")}>
                    <td className="py-1.5 pr-2 text-left">{d.full}</td>
                    <td className="py-1.5 text-right">{formatCurrency(d.income)}</td>
                    <td className="py-1.5 text-right">{formatCurrency(d.outflow)}</td>
                    <td className={cn("py-1.5 text-right", d.net < 0 ? "text-expense" : "text-success")}>{signedCurrency(d.net)}</td>
                    <td className="py-1.5 text-right">{formatCurrency(d.mySpend)}</td>
                    <td className="py-1.5 text-right">{formatCurrency(d.cashIn)}</td>
                    <td className="py-1.5 text-right">{formatCurrency(d.cashOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 6, right: 4, left: -8, bottom: 0 }} barGap={2} onClick={onIndexClick(data, (row) => onSelect(row.period))} className="cursor-pointer">
              <CartesianGrid {...GRID} />
              <XAxis dataKey="label" {...AXIS} />
              <YAxis {...AXIS} tickFormatter={formatCurrencyCompact} width={56} />
              {(view === "net" || view === "flow" || view === "cash") && <ReferenceLine y={0} stroke="var(--border)" />}
              <Tooltip
                cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                content={
                  <RichTooltip
                    title={(row) => String(row?.full ?? "")}
                    format={view === "net" ? signedCurrency : formatCurrency}
                    footer={(row) => {
                      if (!row) return null;
                      if (view === "spend") return Number(row.othersShare) > 0 ? `Others' share I paid ${formatCurrency(Number(row.othersShare))}` : "No split bills fronted";
                      if (view === "cash") return "Cash basis — matches the Dashboard";
                      return `Savings rate ${percentLabel(row.rate as number | null)}`;
                    }}
                  />
                }
              />
              {view === "flow" && (
                <>
                  <Bar dataKey="income" name="Income" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive animationDuration={450}>
                    {data.map((d) => <Cell key={d.key} fill={MONEY.in} fillOpacity={dim(d.key)} />)}
                  </Bar>
                  <Bar dataKey="outflow" name="Total outflow" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive animationDuration={450}>
                    {data.map((d) => <Cell key={d.key} fill={MONEY.out} fillOpacity={dim(d.key)} />)}
                  </Bar>
                  <Line type="monotone" dataKey="net" name="Net" stroke={MONEY.net} strokeWidth={2} dot={{ r: 3.5, strokeWidth: 2, stroke: "var(--card)", fill: MONEY.net }} activeDot={{ r: 5 }} />
                </>
              )}
              {view === "net" && (
                <Bar dataKey="net" name="Net cash flow" radius={[4, 4, 4, 4]} maxBarSize={30} isAnimationActive animationDuration={450}>
                  {data.map((d) => <Cell key={d.key} fill={d.net < 0 ? MONEY.out : MONEY.in} fillOpacity={dim(d.key)} />)}
                </Bar>
              )}
              {view === "spend" && (
                <>
                  <Bar dataKey="outflow" name="Total outflow" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive animationDuration={450}>
                    {data.map((d) => <Cell key={d.key} fill={MONEY.out} fillOpacity={dim(d.key) * 0.75} />)}
                  </Bar>
                  <Bar dataKey="mySpend" name="My spend" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive animationDuration={450}>
                    {data.map((d) => <Cell key={d.key} fill={MONEY.spend} fillOpacity={dim(d.key)} />)}
                  </Bar>
                </>
              )}
              {view === "cash" && (
                <>
                  <Bar dataKey="cashIn" name="Money in" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive animationDuration={450}>
                    {data.map((d) => <Cell key={d.key} fill={MONEY.in} fillOpacity={dim(d.key)} />)}
                  </Bar>
                  <Bar dataKey="cashOut" name="Money out" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive animationDuration={450}>
                    {data.map((d) => <Cell key={d.key} fill={MONEY.out} fillOpacity={dim(d.key)} />)}
                  </Bar>
                  <Line type="monotone" dataKey="cashNet" name="Net cash" stroke={MONEY.net} strokeWidth={2} dot={{ r: 3.5, strokeWidth: 2, stroke: "var(--card)", fill: MONEY.net }} activeDot={{ r: 5 }} />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Where the money went (+ cash basis)

const OUTFLOW_COLORS: Record<string, string> = {
  "My Expenses": "var(--expense)",
  "Shared Expenses": "color-mix(in oklch, var(--expense) 50%, var(--card))",
  EMIs: "var(--chart-4)",
  Loans: "var(--purple)",
  Bills: "var(--chart-2)",
  "Credit Card Payments": "var(--chart-2)",
};
const OUTFLOW_LABEL: Record<string, string> = {
  "My Expenses": "My expenses",
  "Shared Expenses": "Others' share I paid",
  EMIs: "EMI installments",
  Loans: "Loan payments (older records)",
};

export function MoneyFlowPanel({ detail, position }: { detail: PeriodDetail; position: CurrentPosition }) {
  const parts = Object.entries(detail.outflowBreakdown).map(([k, v]) => ({ label: OUTFLOW_LABEL[k] ?? k, value: v, color: OUTFLOW_COLORS[k] ?? MONEY.muted }));
  const cardPurchases = detail.cards.reduce((s, c) => s + c.purchases, 0);
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border/60 bg-card p-4 shadow-e1" data-testid="rep-moneyflow">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">Where the money went</h2>
          <InfoHint text="Total outflow follows Month Cycle: card purchases count when you make them, EMI installments when paid, and transfers, loan money and People settlements never count as spending." />
        </div>
        <span className="font-heading text-[15px] font-semibold tabular-nums" data-testid="rep-outflow-total">
          {formatCurrency(detail.outflow)}
        </span>
      </header>
      <div className="mt-2.5">
        <SegmentedBar parts={parts} testId="rep-outflow-bar" />
      </div>
      <div className="mt-1.5 flex-1">
        {parts.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">Nothing spent in this period.</p>
        ) : (
          parts.map((p) => <FigureRow key={p.label} label={p.label} tone={p.color} value={formatCurrency(p.value)} sub={detail.outflow > 0 ? `${((p.value / detail.outflow) * 100).toFixed(0)}%` : undefined} />)
        )}
      </div>

      <div className="mt-2 rounded-xl bg-muted/55 px-3 py-2.5" data-testid="rep-cash-basis">
        <div className="mb-1.5 flex items-center gap-1.5">
          <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Cash basis · accounts</p>
          <InfoHint text="What actually reached or left your bank, cash and wallet accounts (the Dashboard's Money In / Money Out). Card purchases aren't cash until you pay the card bill, so card bill payments count here instead. Money collected on split expenses counts as money in." />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <CashStat label="Money in" tone="text-success" testId="rep-cash-in" value={detail.cash.moneyIn} />
          <CashStat label="Money out" tone="text-expense" testId="rep-cash-out" value={detail.cash.moneyOut} />
          <CashStat label="Net cash" testId="rep-cash-net" value={detail.cash.net} signed />
        </div>
        {(cardPurchases > 0 || detail.debt.cardBillPayments > 0) && (
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            {detail.debt.cardBillPayments > 0 ? `Includes ${formatCurrency(detail.debt.cardBillPayments)} of card bills paid. ` : ""}
            {cardPurchases > 0 ? `${formatCurrency(cardPurchases)} of card purchases count in outflow, not here.` : ""}
          </p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          In your accounts today: <span className="font-medium text-foreground tabular-nums">{formatCurrency(position.liquidBalance)}</span>
        </p>
      </div>
    </section>
  );
}

function CashStat({ label, value, tone, testId, signed }: { label: string; value: number; tone?: string; testId: string; signed?: boolean }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("truncate text-[13px] font-semibold tabular-nums", tone)}>
        <span data-value={value}>{signed ? signedCurrency(value) : formatCurrency(value)}</span>
      </p>
    </div>
  );
}
