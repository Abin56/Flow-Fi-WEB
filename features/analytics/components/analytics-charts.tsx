"use client";

/**
 * Analytics building blocks — presentation only. Every number arrives as `PeriodFigures` / `PeriodDetail` from the
 * shared engine (`lib/engines/period-report.ts`); nothing here computes money beyond sums / averages of those figures
 * for display (averages, shares, quantile colour steps).
 *
 * Layout intent: one overview screen (KPI strip → main chart + focus panel), then ONE tabbed Explore card for the
 * secondary views (categories, savings, balances, daily pattern) — no stack of tall single-chart sections.
 */

import { CalendarDays, Layers, PiggyBank, Scale } from "lucide-react";
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PeriodDetail, PeriodFigures } from "@/lib/engines/period-report";
import type { ReportPeriod } from "@/lib/engines/report-period";
import { reportDayKey } from "@/lib/engines/period-report";
import { incomeCompositionNote } from "@/features/reports/lib/income-note";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AXIS,
  CATEGORY_COLORS,
  changePercent,
  DeltaChip,
  EmptyNote,
  GRID,
  LegendRow,
  MONEY,
  onIndexClick,
  OTHER_COLOR,
  percentLabel,
  RichTooltip,
  Segmented,
  signedCurrency,
  Sparkline,
} from "@/features/reports/components/report-ui";
import type { ReportAccountInfo } from "@/features/reports/hooks/use-financial-report-data";

export type MetricKey = "income" | "outflow" | "mySpend" | "net";
export type MainView = "flow" | MetricKey;

export const METRICS: { key: MetricKey; label: string; color: string; upIsGood: boolean; read: (f: PeriodFigures) => number; hint: string }[] = [
  { key: "income", label: "Income", color: MONEY.in, upIsGood: true, read: (f) => f.income, hint: "Month Cycle income" },
  { key: "outflow", label: "Outflow", color: MONEY.out, upIsGood: false, read: (f) => f.outflow, hint: "Everything spent (Month Cycle)" },
  { key: "mySpend", label: "My spend", color: MONEY.spend, upIsGood: false, read: (f) => f.mySpend, hint: "My share only" },
  { key: "net", label: "Net cash flow", color: MONEY.net, upIsGood: true, read: (f) => f.net, hint: "Income − outflow" },
];

export interface SeriesPoint {
  period: ReportPeriod;
  figures: PeriodFigures;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const money = (key: MetricKey, v: number) => (key === "net" ? signedCurrency(v) : formatCurrency(v));
/** Periods that are finished — an unfinished current period never enters an average. */
const complete = (points: SeriesPoint[]) => points.filter((p) => !p.period.isCurrent);

// ---------------------------------------------------------------- KPI strip

export function KpiStrip({
  points,
  focusIndex,
  focusFigures,
  previous,
  view,
  onView,
}: {
  points: SeriesPoint[];
  /** Window point of the focused period, or -1 when it isn't one of them (a custom range). */
  focusIndex: number;
  /** The focused period's own figures — the tiles read these, never `points[focusIndex]` (a custom range has no point). */
  focusFigures: PeriodFigures;
  /** The comparable previous period's figures, or null when it has no records. */
  previous: PeriodFigures | null;
  view: MainView;
  onView: (v: MainView) => void;
}) {
  const focus = focusFigures;
  return (
    <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4" role="tablist" aria-label="Metric" data-testid="an-kpis">
      {METRICS.map((m) => {
        const v = focus ? m.read(focus) : 0;
        const active = view === m.key;
        const saved =
          m.key === "net" && focus?.savingsRate != null
            ? `Saved ${percentLabel(focus.savingsRate, 0)} of income`
            : m.key === "income" && focus
              ? incomeCompositionNote(focus, formatCurrency)
              : null;
        return (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onView(active ? "flow" : m.key)}
            data-testid={`an-metric-${m.key}`}
            className={cn(
              "group relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-2xl border bg-card p-3.5 text-left shadow-e1 transition-all duration-200 hover:-translate-y-px hover:shadow-e2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              active ? "border-transparent ring-2" : "border-border/60",
            )}
            style={active ? ({ "--tw-ring-color": `color-mix(in oklch, ${m.color} 60%, transparent)` } as CSSProperties) : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                <span className="size-2 rounded-full" style={{ background: m.color }} aria-hidden />
                {m.label}
              </span>
              <DeltaChip value={previous ? changePercent(v, m.read(previous)) : null} upIsGood={m.upIsGood} />
            </div>
            <div className="flex items-end justify-between gap-2">
              <span className="truncate font-heading text-[1.35rem] leading-none font-semibold tracking-tight text-foreground" data-testid={`an-metric-${m.key}-value`} data-value={v}>
                {money(m.key, v)}
              </span>
              <Sparkline values={points.map((p) => m.read(p.figures))} color={m.color} focusIndex={focusIndex} />
            </div>
            <span className="truncate text-[11px] text-muted-foreground">{saved ?? m.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Main chart (cash flow overview, or one metric)

export function MainChart({
  points,
  comparePoints,
  focused,
  onFocus,
  view,
  onView,
  compare,
  onCompare,
  canCompare,
  recordsNote,
}: {
  points: SeriesPoint[];
  comparePoints: SeriesPoint[] | null;
  focused: ReportPeriod;
  onFocus: (p: ReportPeriod) => void;
  view: MainView;
  onView: (v: MainView) => void;
  compare: boolean;
  onCompare: (v: boolean) => void;
  canCompare: boolean;
  recordsNote: string | null;
}) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const focusKey = focused.start.getTime();
  const m = view === "flow" ? null : METRICS.find((x) => x.key === view)!;
  const data = points.map((p, i) => ({
    i,
    label: p.period.shortLabel,
    full: p.period.label,
    income: p.figures.income,
    outflow: p.figures.outflow,
    net: p.figures.net,
    value: m ? m.read(p.figures) : 0,
    compare: m && comparePoints?.[i] ? m.read(comparePoints[i].figures) : undefined,
    compareLabel: comparePoints?.[i]?.period.label,
    rate: p.figures.savingsRate,
    period: p.period,
    key: p.period.start.getTime(),
  }));
  const done = complete(points);
  const average = m ? avg(done.map((p) => m.read(p.figures))) : 0;
  const focusIndex = data.findIndex((d) => d.key === focusKey);

  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border/60 bg-card p-4 shadow-e1" data-testid="an-hero">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={view}
          onChange={onView}
          size="xs"
          ariaLabel="Chart"
          testId="an-view"
          options={[
            { value: "flow", label: "Cash flow" },
            { value: "income", label: "Income" },
            { value: "outflow", label: "Outflow" },
            { value: "mySpend", label: "My spend" },
            { value: "net", label: "Net" },
          ]}
        />
        <div className="flex items-center gap-2">
          {m && (
            <label className={cn("inline-flex items-center gap-1.5 text-[11px] text-muted-foreground select-none", canCompare ? "cursor-pointer" : "cursor-not-allowed opacity-50")} title={canCompare ? undefined : "No records before this window"}>
              <input type="checkbox" checked={compare && canCompare} disabled={!canCompare} onChange={(e) => onCompare(e.target.checked)} className="size-3.5 accent-[var(--primary)]" data-testid="an-compare" />
              Earlier periods
            </label>
          )}
          <Segmented value={mode} onChange={setMode} size="xs" options={[{ value: "chart", label: "Chart" }, { value: "table", label: "Table" }]} testId="an-hero-view" />
        </div>
      </header>

      {mode === "chart" ? (
        <div className="h-60 min-h-0 flex-1" data-testid="an-hero-chart">
          <ResponsiveContainer width="100%" height="100%">
            {m == null ? (
              <ComposedChart data={data} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} barGap={2} onClick={onIndexClick(data, (row) => onFocus(row.period))} className="cursor-pointer">
                <CartesianGrid {...GRID} />
                <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={10} />
                <YAxis {...AXIS} tickFormatter={formatCurrencyCompact} width={56} />
                <ReferenceLine y={0} stroke="var(--border)" />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.55 }}
                  content={<RichTooltip title={(row) => String(row?.full ?? "")} footer={(row) => `Saved ${percentLabel((row?.rate as number | null) ?? null, 0)} of income · click to focus`} />}
                />
                <Bar dataKey="income" name="Income" radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={500}>
                  {data.map((d) => (
                    <Cell key={d.key} fill={MONEY.in} fillOpacity={d.key === focusKey ? 1 : 0.5} />
                  ))}
                </Bar>
                <Bar dataKey="outflow" name="Outflow" radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={500}>
                  {data.map((d) => (
                    <Cell key={d.key} fill={MONEY.out} fillOpacity={d.key === focusKey ? 1 : 0.5} />
                  ))}
                </Bar>
                <Line type="monotone" dataKey="net" name="Net" stroke={MONEY.net} strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: "var(--card)", fill: MONEY.net }} activeDot={{ r: 5 }} animationDuration={600} />
              </ComposedChart>
            ) : (
              <AreaChart data={data} margin={{ top: 10, right: 8, left: -6, bottom: 0 }} onClick={onIndexClick(data, (row) => onFocus(row.period))} className="cursor-pointer">
                <defs>
                  <linearGradient id="an-hero-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={m.color} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={m.color} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={10} />
                <YAxis {...AXIS} tickFormatter={formatCurrencyCompact} width={56} />
                {m.key === "net" && <ReferenceLine y={0} stroke="var(--border)" />}
                {done.length > 0 && <ReferenceLine y={average} stroke="var(--muted-foreground)" strokeDasharray="2 4" strokeOpacity={0.8} label={{ value: "avg", position: "insideTopRight", fill: "var(--muted-foreground)", fontSize: 10 }} />}
                <Tooltip
                  cursor={{ stroke: "var(--border)" }}
                  content={<RichTooltip format={m.key === "net" ? signedCurrency : formatCurrency} title={(row) => String(row?.full ?? "")} footer={(row) => (row?.compareLabel ? `Dashed: ${row.compareLabel}` : "Click to focus this period")} />}
                />
                {compare && canCompare && <Area type="monotone" dataKey="compare" name="Earlier periods" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="5 4" fill="none" dot={false} activeDot={false} isAnimationActive={false} />}
                <Area
                  type="monotone"
                  dataKey="value"
                  name={m.label}
                  stroke={m.color}
                  strokeWidth={2.25}
                  fill="url(#an-hero-fill)"
                  animationDuration={600}
                  dot={(props: { cx?: number; cy?: number; index?: number }) => {
                    const { cx, cy, index } = props;
                    if (cx == null || cy == null) return <g key={index} />;
                    const on = index === focusIndex;
                    return <circle key={index} cx={cx} cy={cy} r={on ? 5.5 : 3} fill={on ? m.color : "var(--card)"} stroke={on ? "var(--card)" : m.color} strokeWidth={2} />;
                  }}
                  activeDot={{ r: 6, strokeWidth: 2, stroke: "var(--card)", fill: m.color }}
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-60 flex-1 overflow-auto" data-testid="an-hero-table">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-card">
              <tr className="text-[10.5px] tracking-wide text-muted-foreground uppercase">
                <th className="py-1.5 text-left font-medium">Period</th>
                {METRICS.map((x) => (
                  <th key={x.key} className="py-1.5 text-right font-medium">
                    {x.label}
                  </th>
                ))}
                <th className="py-1.5 text-right font-medium">Saved</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.period.start.getTime()} className={cn("border-t border-border/50", p.period.start.getTime() === focusKey && "bg-muted/50")}>
                  <td className="py-1.5 pr-2">{p.period.label}</td>
                  {METRICS.map((x) => (
                    <td key={x.key} className="py-1.5 text-right tabular-nums">
                      {money(x.key, x.read(p.figures))}
                    </td>
                  ))}
                  <td className="py-1.5 text-right text-muted-foreground tabular-nums">{percentLabel(p.figures.savingsRate, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <LegendRow
          items={
            m == null
              ? [
                  { label: "Income", color: MONEY.in },
                  { label: "Outflow", color: MONEY.out },
                  { label: "Net", color: MONEY.net, line: true },
                ]
              : [
                  { label: m.label, color: m.color },
                  ...(done.length ? [{ label: `Average ${money(m.key, average)}`, color: "var(--muted-foreground)", dashed: true }] : []),
                  ...(compare && canCompare ? [{ label: "Earlier periods", color: "var(--muted-foreground)", dashed: true }] : []),
                ]
          }
        />
        {recordsNote && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] text-muted-foreground" data-testid="an-records-note">
            {recordsNote}
          </span>
        )}
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------- Focus panel (the selected period at a glance)

export interface Insight {
  id: string;
  tone: "good" | "bad" | "neutral";
  title: string;
  detail: string;
}

export function FocusPanel({ detail, insights, categoryName }: { detail: PeriodDetail; insights: Insight[]; categoryName: (id: string) => string }) {
  const rate = detail.savingsRate;
  const cats = [...detail.spendByCategory].sort((a, b) => b[1].amount - a[1].amount).slice(0, 4);
  const top = cats[0]?.[1].amount ?? 0;
  const { period } = detail;
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 shadow-e1" data-testid="an-focus">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-heading text-[15px] font-semibold tracking-tight">{period.label}</h2>
        <span className="text-[11px] text-muted-foreground">{period.isCurrent && period.daysElapsed < period.days ? `Day ${period.daysElapsed} of ${period.days}` : `${period.days} days`}</span>
      </header>

      <div data-testid="an-focus-rate">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Savings rate</span>
          <span className={cn("font-heading text-lg font-semibold tabular-nums", rate == null ? "text-muted-foreground" : rate >= 0 ? "text-success" : "text-expense")}>{rate == null ? "—" : percentLabel(rate, 0)}</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${rate == null ? 0 : Math.min(100, Math.abs(rate))}%`, background: rate != null && rate < 0 ? MONEY.out : MONEY.in }} />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {rate == null ? "No income recorded in this period." : `${signedCurrency(detail.net)} of ${formatCurrency(detail.income)} income ${detail.net >= 0 ? "kept" : "overspent"}.`}
        </p>
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Top spending</p>
        {cats.length === 0 ? (
          <p className="text-xs text-muted-foreground">No spending in this period.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="an-focus-categories">
            {cats.map(([id, v]) => (
              <li key={id}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-foreground">{categoryName(id)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCurrency(v.amount)} · {detail.mySpend > 0 ? ((v.amount / detail.mySpend) * 100).toFixed(0) : 0}%
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-[var(--chart-2)] transition-[width] duration-700" style={{ width: `${top > 0 ? (v.amount / top) * 100 : 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {insights.length > 0 && (
        <div className="mt-auto border-t border-border/60 pt-2.5" data-testid="an-insights">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">What stands out</p>
          <ul className="space-y-1.5">
            {insights.slice(0, 3).map((i) => (
              <li key={i.id} className="flex gap-2 text-xs leading-snug" data-testid={`an-insight-${i.id}`}>
                <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", i.tone === "good" ? "bg-success" : i.tone === "bad" ? "bg-expense" : "bg-muted-foreground")} aria-hidden />
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{i.title}</span>
                  <span className="text-muted-foreground"> — {i.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Explore card (secondary views as tabs)

export type ExploreTab = "categories" | "savings" | "balances" | "daily";

export function ExploreCard({ tab, onTab, summaries, children }: { tab: ExploreTab; onTab: (t: ExploreTab) => void; summaries: Record<ExploreTab, string>; children: ReactNode }) {
  const tabs: { value: ExploreTab; label: string; icon: typeof Layers }[] = [
    { value: "categories", label: "Categories", icon: Layers },
    { value: "savings", label: "Savings", icon: PiggyBank },
    { value: "balances", label: "Balances", icon: Scale },
    { value: "daily", label: "Daily pattern", icon: CalendarDays },
  ];
  return (
    <section className="rounded-2xl border border-border/60 bg-card shadow-e1" data-testid="an-explore">
      <div className="grid grid-cols-2 border-b border-border/60 @3xl:grid-cols-4" role="tablist" aria-label="Explore">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = t.value === tab;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`an-tab-${t.value}`}
              onClick={() => onTab(t.value)}
              className={cn("relative flex items-center gap-2.5 px-4 py-3 text-left transition-colors first:rounded-tl-2xl @3xl:last:rounded-tr-2xl", active ? "bg-muted/45" : "hover:bg-muted/25")}
            >
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg transition-colors", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                <Icon className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className={cn("block text-[13px] font-semibold", active ? "text-foreground" : "text-muted-foreground")}>{t.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{summaries[t.value]}</span>
              </span>
              {active && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>
      <div key={tab} className="h-[19rem] p-4 animate-in fade-in-0 duration-300 motion-reduce:animate-none" role="tabpanel">
        {children}
      </div>
    </section>
  );
}

/** Two-column body of an Explore tab: chart left, context right. */
function TabBody({ left, right, testId }: { left: ReactNode; right: ReactNode; testId: string }) {
  return (
    <div className="grid h-full min-h-0 gap-5 @4xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]" data-testid={testId}>
      <div className="flex min-h-0 min-w-0 flex-col">{left}</div>
      <div className="flex min-h-0 min-w-0 flex-col border-t border-border/60 pt-4 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-5">{right}</div>
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 truncate font-heading text-base font-semibold tabular-nums" style={tone ? { color: tone } : undefined}>
        {value}
      </p>
      {sub && <p className="truncate text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ---- Categories

export function CategoriesTab({
  points,
  focusedDetail,
  categoryName,
  category,
  onCategory,
  onFocus,
  accountInfo,
}: {
  points: SeriesPoint[];
  focusedDetail: PeriodDetail;
  categoryName: (id: string) => string;
  category: string | null;
  onCategory: (id: string | null) => void;
  onFocus: (p: ReportPeriod) => void;
  accountInfo: Map<string, ReportAccountInfo>;
}) {
  // Colour follows the category: ranked once over the WHOLE window, so the focused period or a filter never repaints.
  const ranked = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of points) for (const [id, v] of p.figures.spendByCategory) totals.set(id, (totals.get(id) ?? 0) + v.amount);
    return [...totals].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [points]);
  const top = useMemo(() => ranked.slice(0, CATEGORY_COLORS.length), [ranked]);
  const colorOf = useCallback(
    (id: string) => {
      const i = top.indexOf(id);
      return i >= 0 ? CATEGORY_COLORS[i] : OTHER_COLOR;
    },
    [top],
  );
  const keys = category ? [category] : [...top, ...(ranked.length > top.length ? ["__other"] : [])];
  const nameOf = (k: string) => (k === "__other" ? "Other" : categoryName(k));
  const data = points.map((p) => {
    const row: Record<string, unknown> = { label: p.period.shortLabel, full: p.period.label, period: p.period };
    let other = 0;
    for (const [id, v] of p.figures.spendByCategory) {
      if (category) {
        if (id === category) row[id] = v.amount;
      } else if (top.includes(id)) row[id] = v.amount;
      else other += v.amount;
    }
    if (!category) row.__other = Math.round(other * 100) / 100;
    return row;
  });

  const slices = useMemo(() => {
    const entries = [...focusedDetail.spendByCategory].sort((a, b) => b[1].amount - a[1].amount);
    const main = entries.filter(([id]) => top.includes(id)).map(([id, v]) => ({ id, name: categoryName(id), value: v.amount, color: colorOf(id) }));
    const rest = entries.filter(([id]) => !top.includes(id));
    if (rest.length) main.push({ id: "__other", name: `Other (${rest.length})`, value: Math.round(rest.reduce((s, [, v]) => s + v.amount, 0) * 100) / 100, color: OTHER_COLOR });
    return main;
  }, [focusedDetail, top, categoryName, colorOf]);
  const [drill, setDrill] = useState<string | null>(null);
  const drillId = category ?? (drill && slices.some((s) => s.id === drill) ? drill : (slices[0]?.id ?? null));
  const drillRows = useMemo(
    () => (drillId ? focusedDetail.spendRows.filter((r) => (drillId === "__other" ? !top.includes(r.transaction.categoryId) : r.transaction.categoryId === drillId)) : []),
    [drillId, focusedDetail, top],
  );
  const total = focusedDetail.mySpend;

  if (ranked.length === 0) return <EmptyNote className="h-full">No spending in this window.</EmptyNote>;

  return (
    <TabBody
      testId="an-categories"
      left={
        <>
          <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="an-category-legend">
            {[...top, ...(ranked.length > top.length ? ["__other"] : [])].map((k) => (
              <button
                key={k}
                type="button"
                disabled={k === "__other"}
                onClick={() => onCategory(category === k ? null : k)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-default",
                  category === k ? "border-foreground/30 bg-muted text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground",
                  category && category !== k && "opacity-50",
                )}
              >
                <span className="size-2 rounded-[3px]" style={{ background: k === "__other" ? OTHER_COLOR : colorOf(k) }} />
                {nameOf(k)}
              </button>
            ))}
            {category && (
              <button type="button" onClick={() => onCategory(null)} className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium hover:bg-muted/70" data-testid="an-category-clear">
                All categories ✕
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1" data-testid="an-category-stack">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 4, left: -6, bottom: 0 }} onClick={onIndexClick(data, (row) => onFocus(row.period as ReportPeriod))}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={10} />
                <YAxis {...AXIS} tickFormatter={formatCurrencyCompact} width={56} />
                <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.55 }} content={<RichTooltip title={(row) => String(row?.full ?? "")} />} />
                {keys.map((k, i) => (
                  <Bar key={k} dataKey={k} name={nameOf(k)} stackId="spend" fill={k === "__other" ? OTHER_COLOR : colorOf(k)} maxBarSize={24} stroke="var(--card)" strokeWidth={1} radius={i === keys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} className="cursor-pointer" animationDuration={500} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      }
      right={
        <div className="flex h-full min-h-0 flex-col">
          {slices.length === 0 ? (
            <EmptyNote className="h-full">No spending in {focusedDetail.period.label}.</EmptyNote>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="relative size-28 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={slices} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="98%" paddingAngle={slices.length > 1 ? 1.5 : 0} cornerRadius={4} stroke="var(--card)" strokeWidth={2} onClick={(_, i) => setDrill(slices[i]?.id ?? null)} className="cursor-pointer" animationDuration={500}>
                        {slices.map((s) => (
                          <Cell key={s.id} fill={s.color} fillOpacity={drillId && drillId !== s.id ? 0.3 : 1} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[9.5px] text-muted-foreground">{focusedDetail.period.shortLabel}</span>
                    <span className="text-[13px] font-semibold tabular-nums">{formatCurrencyCompact(total)}</span>
                  </div>
                </div>
                <ul className="min-w-0 flex-1 space-y-0.5">
                  {slices.map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => setDrill(s.id)} className={cn("flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/60", drillId === s.id && "bg-muted")} data-testid="an-slice">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{total > 0 ? ((s.value / total) * 100).toFixed(0) : 0}%</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-xl bg-muted/40 p-2" data-testid={drillId ? "an-drill" : "an-drill-empty"}>
                {drillId ? (
                  <>
                    <p className="mb-1 px-1 text-[11px] font-semibold text-muted-foreground">
                      {nameOf(drillId)} · {drillRows.length} purchase{drillRows.length === 1 ? "" : "s"} · {formatCurrency(drillRows.reduce((s, r) => s + r.myAmount, 0))}
                    </p>
                    <ul>
                      {drillRows.slice(0, 40).map((r) => (
                        <li key={r.transaction.id} className="flex items-center gap-2 px-1 py-1 text-xs">
                          <span className="w-10 shrink-0 text-muted-foreground tabular-nums">{r.transaction.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                          <span className="min-w-0 flex-1 truncate">
                            {r.transaction.description || categoryName(r.transaction.categoryId)}
                            <span className="text-muted-foreground"> · {accountInfo.get(r.transaction.accountId)?.name ?? "—"}</span>
                          </span>
                          <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(r.myAmount)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="flex h-full items-center justify-center px-2 text-center text-[11px] text-muted-foreground">Pick a category to list its purchases in {focusedDetail.period.label}.</p>
                )}
              </div>
            </>
          )}
        </div>
      }
    />
  );
}

// ---- Savings

export function SavingsTab({ points, focused, onFocus }: { points: SeriesPoint[]; focused: ReportPeriod; onFocus: (p: ReportPeriod) => void }) {
  const data = points.map((p) => ({ label: p.period.shortLabel, full: p.period.label, net: p.figures.net, rate: p.figures.savingsRate, period: p.period }));
  const done = complete(points).filter((p) => p.figures.savingsRate != null);
  const avgRate = done.length ? avg(done.map((p) => p.figures.savingsRate as number)) : null;
  const best = done.reduce<SeriesPoint | null>((b, p) => (b == null || (p.figures.savingsRate as number) > (b.figures.savingsRate as number) ? p : b), null);
  const totalSaved = points.reduce((s, p) => s + p.figures.net, 0);
  const focusKey = focused.start.getTime();
  return (
    <TabBody
      testId="an-savings"
      left={
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 6, right: 4, left: -6, bottom: 0 }} onClick={onIndexClick(data, (row) => onFocus(row.period))}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={10} />
              <YAxis {...AXIS} tickFormatter={formatCurrencyCompact} width={56} />
              <ReferenceLine y={0} stroke="var(--border)" />
              <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.55 }} content={<RichTooltip format={signedCurrency} title={(row) => String(row?.full ?? "")} footer={(row) => `Savings rate ${percentLabel((row?.rate as number | null) ?? null, 1)}`} />} />
              <Bar dataKey="net" name="Net" maxBarSize={24} radius={[4, 4, 4, 4]} className="cursor-pointer" animationDuration={500}>
                {data.map((d) => (
                  <Cell key={d.period.start.getTime()} fill={d.net >= 0 ? MONEY.in : MONEY.out} fillOpacity={d.period.start.getTime() === focusKey ? 1 : 0.55} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      }
      right={
        <div className="flex h-full flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Saved in window" value={signedCurrency(totalSaved)} tone={totalSaved >= 0 ? MONEY.in : MONEY.out} sub={`${points.filter((p) => p.figures.net > 0).length} of ${points.length} periods positive`} />
            <Stat label="Average rate" value={percentLabel(avgRate, 0)} sub={done.length ? `${done.length} finished period${done.length === 1 ? "" : "s"}` : "No finished period yet"} />
          </div>
          {best && <Stat label="Best period" value={percentLabel(best.figures.savingsRate, 0)} sub={best.period.label} />}
          <div className="min-h-0 flex-1">
            <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Savings rate trend</p>
            <div className="h-[calc(100%-1rem)]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 4, right: 4, left: -4, bottom: 0 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis {...AXIS} width={44} tickFormatter={(v) => `${Math.round(v)}%`} domain={["auto", "auto"]} />
                  <ReferenceLine y={0} stroke="var(--border)" />
                  {avgRate != null && <ReferenceLine y={avgRate} stroke="var(--muted-foreground)" strokeDasharray="2 4" />}
                  <Tooltip content={<RichTooltip format={(v) => `${v.toFixed(1)}%`} title={(row) => String(row?.full ?? "")} />} />
                  <Line type="monotone" dataKey="rate" name="Savings rate" stroke="var(--primary)" strokeWidth={2} dot={{ r: 2.5, strokeWidth: 1.5, stroke: "var(--card)", fill: "var(--primary)" }} connectNulls animationDuration={500} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      }
    />
  );
}

// ---- Balances

export function BalancesTab({ data }: { data: { label: string; full: string; liquid: number; netWorth: number | null; cardOwed: number }[] }) {
  const showNetWorth = data.some((d) => d.netWorth != null);
  const last = data[data.length - 1];
  const first = data[0];
  return (
    <TabBody
      testId="an-balances"
      left={
        <>
          <LegendRow className="mb-2" items={[{ label: "Bank, cash & wallets", color: MONEY.in, line: true }, ...(showNetWorth ? [{ label: "Net worth", color: "var(--primary)", line: true }] : [])]} />
          <div className="min-h-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 6, right: 8, left: -6, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={10} />
                <YAxis {...AXIS} tickFormatter={formatCurrencyCompact} width={56} />
                <Tooltip cursor={{ stroke: "var(--border)" }} content={<RichTooltip title={(row) => String(row?.full ?? "")} />} />
                <Line type="monotone" dataKey="liquid" name="Bank, cash & wallets" stroke={MONEY.in} strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }} animationDuration={500} />
                {showNetWorth && <Line type="monotone" dataKey="netWorth" name="Net worth" stroke="var(--primary)" strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }} animationDuration={500} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      }
      right={
        <div className="flex h-full flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Bank, cash & wallets" value={formatCurrency(last?.liquid ?? 0)} sub={first && last ? `${signedCurrency(last.liquid - first.liquid)} in window` : undefined} />
            {showNetWorth ? (
              <Stat label="Net worth" value={formatCurrency(last?.netWorth ?? 0)} sub={first?.netWorth != null && last?.netWorth != null ? `${signedCurrency(last.netWorth - first.netWorth)} in window` : undefined} />
            ) : (
              <Stat label="Net worth" value="—" sub="Hidden while filtering accounts" />
            )}
          </div>
          <div className="min-h-0 flex-1" data-testid="an-card-debt">
            <p className="mb-1 flex items-baseline justify-between text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
              <span>Card balance owed</span>
              <span className="font-medium tracking-normal normal-case">{formatCurrency(last?.cardOwed ?? 0)} now</span>
            </p>
            <div className="h-[calc(100%-1rem)]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 4, right: 4, left: -4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="an-card-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={MONEY.out} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={MONEY.out} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" hide />
                  <YAxis {...AXIS} width={48} tickFormatter={formatCurrencyCompact} />
                  <Tooltip content={<RichTooltip title={(row) => String(row?.full ?? "")} />} />
                  <Area type="monotone" dataKey="cardOwed" name="Card balance owed" stroke={MONEY.out} strokeWidth={2} fill="url(#an-card-fill)" dot={false} animationDuration={500} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <p className="text-[10.5px] leading-snug text-muted-foreground">Worked backwards from today&apos;s balances through your records; loan and EMI payments change Net worth by their interest only.</p>
        </div>
      }
    />
  );
}

// ---- Daily pattern (calendar heatmap)

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Single-hue sequential steps (blue over transparent — no theme tint can shift the hue). */
const STEP_MIX = [0, 26, 48, 72, 100];
const stepColor = (level: number) => (level === 0 ? "var(--muted)" : `color-mix(in oklch, var(--chart-2) ${STEP_MIX[level]}%, transparent)`);

/**
 * Quantile thresholds over the days that had spending, so one very large day can't flatten every other day into the
 * same colour (a linear scale did exactly that). Level 1–4 = up to the 25th / 50th / 75th percentile / above.
 */
export function quantileSteps(values: number[]): number[] {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (xs.length === 0) return [];
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))];
  return [q(0.25), q(0.5), q(0.75)];
}

export function levelFor(v: number, steps: number[]): number {
  if (v <= 0 || steps.length === 0) return 0;
  if (v <= steps[0]) return 1;
  if (v <= steps[1]) return 2;
  if (v <= steps[2]) return 3;
  return 4;
}

export function DailyTab({ detail, category, categoryName }: { detail: PeriodDetail; category: string | null; categoryName: (id: string) => string }) {
  const { period } = detail;
  const daily = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of detail.spendRows) {
      if (r.myAmount === 0 || (category && r.transaction.categoryId !== category)) continue;
      let d = r.transaction.dateTime;
      if (d < period.start) d = period.start;
      if (d > period.end) d = period.end;
      const k = reportDayKey(d);
      map.set(k, Math.round(((map.get(k) ?? 0) + r.myAmount) * 100) / 100);
    }
    return map;
  }, [detail.spendRows, category, period]);

  const today = new Date();
  const days: { date: Date; key: string; value: number; future: boolean }[] = [];
  for (let d = new Date(period.start); d <= period.end && days.length < 400; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const key = reportDayKey(d);
    days.push({ date: d, key, value: daily.get(key) ?? 0, future: d > today });
  }
  const elapsed = days.filter((d) => !d.future);
  const steps = quantileSteps(elapsed.map((d) => d.value));
  const total = elapsed.reduce((s, d) => s + d.value, 0);
  const spendDays = elapsed.filter((d) => d.value > 0).length;
  const peak = elapsed.reduce<(typeof days)[number] | null>((m, d) => (d.value > (m?.value ?? 0) ? d : m), null);
  const weekday = WEEKDAYS.map((label, i) => {
    const xs = elapsed.filter((d) => (d.date.getDay() + 6) % 7 === i);
    return { label, avg: xs.length ? xs.reduce((s, d) => s + d.value, 0) / xs.length : 0 };
  });
  const lead = days.length ? (days[0].date.getDay() + 6) % 7 : 0;
  const cells: ((typeof days)[number] | null)[] = [...Array(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const calendar = days.length <= 42;

  return (
    <TabBody
      testId="an-daily"
      left={
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              {period.label}
              {category ? ` · ${categoryName(category)} only` : ""}
            </span>
            {steps.length > 0 && (
              <span className="flex flex-wrap items-center gap-2" data-testid="an-heat-legend">
                {[1, 2, 3, 4].map((l) => (
                  <span key={l} className="inline-flex items-center gap-1">
                    <span className="size-2.5 rounded-[3px]" style={{ background: stepColor(l) }} />
                    {l < 4 ? `≤${formatCurrencyCompact(steps[l - 1])}` : `>${formatCurrencyCompact(steps[2])}`}
                  </span>
                ))}
              </span>
            )}
          </div>
          {calendar ? (
            <div className="grid min-h-0 flex-1 grid-cols-7 gap-1" style={{ gridTemplateRows: `auto repeat(${cells.length / 7}, minmax(0, 1fr))` }}>
              {WEEKDAYS.map((w) => (
                <span key={w} className="pb-0.5 text-center text-[10px] font-medium text-muted-foreground">
                  {w}
                </span>
              ))}
              {cells.map((c, i) => {
                if (c == null) return <span key={`e${i}`} />;
                const level = c.future ? 0 : levelFor(c.value, steps);
                const strong = level >= 3;
                return (
                  <div
                    key={c.key}
                    data-testid="an-day"
                    data-value={c.value}
                    data-level={level}
                    title={`${c.date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}: ${formatCurrency(c.value)}`}
                    className={cn(
                      "relative flex min-h-0 flex-col justify-between overflow-hidden rounded-md px-1.5 py-1 transition-transform duration-150 hover:z-10 hover:scale-[1.04]",
                      c.future && "opacity-40",
                      c.key === peak?.key && peak.value > 0 && "ring-2 ring-foreground/70",
                    )}
                    style={{ background: stepColor(level) }}
                  >
                    <span className={cn("text-[10px] leading-none tabular-nums", strong ? "text-white" : "text-muted-foreground")}>{c.date.getDate()}</span>
                    {c.value > 0 && <span className={cn("truncate text-right text-[10.5px] leading-none font-semibold tabular-nums", strong ? "text-white" : "text-foreground")}>{formatCurrencyCompact(c.value)}</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="flex gap-[3px]">
                {Array.from({ length: cells.length / 7 }, (_, w) => (
                  <div key={w} className="grid grid-rows-7 gap-[3px]">
                    {cells.slice(w * 7, w * 7 + 7).map((c, i) =>
                      c == null ? (
                        <span key={`e${i}`} className="size-3.5" />
                      ) : (
                        <span
                          key={c.key}
                          data-testid="an-day"
                          data-value={c.value}
                          title={`${c.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}: ${formatCurrency(c.value)}`}
                          className={cn("block size-3.5 rounded-[3px]", c.future && "opacity-40")}
                          style={{ background: stepColor(c.future ? 0 : levelFor(c.value, steps)) }}
                        />
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      }
      right={
        <div className="flex h-full flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Per day" value={formatCurrency(elapsed.length ? total / elapsed.length : 0)} sub={`${spendDays} of ${elapsed.length} days with spending`} />
            <Stat label="Highest day" value={peak && peak.value > 0 ? formatCurrency(peak.value) : "—"} sub={peak && peak.value > 0 ? peak.date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : undefined} />
          </div>
          <div className="min-h-0 flex-1">
            <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Average by weekday</p>
            <div className="h-[calc(100%-1rem)]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weekday} margin={{ top: 4, right: 0, left: -4, bottom: 0 }}>
                  <XAxis dataKey="label" {...AXIS} interval={0} />
                  <YAxis {...AXIS} width={48} tickFormatter={formatCurrencyCompact} />
                  <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.55 }} content={<RichTooltip />} />
                  <Bar dataKey="avg" name="Average a day" fill="var(--chart-2)" radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={500} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      }
    />
  );
}
