"use client";

import { Check, ChevronDown, Filter, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { PeriodBar } from "@/features/reports/components/period-bar";
import { Segmented, signedCurrency } from "@/features/reports/components/report-ui";
import { buildInsights } from "@/features/analytics/lib/insights";
import { useFinancialReportData, useSyncedReportPeriod, type FinancialReportData } from "@/features/reports/hooks/use-financial-report-data";
import type { PeriodDetail } from "@/lib/engines/period-report";
import { selectionForTrendPoint, type ReportPeriod } from "@/lib/engines/report-period";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  BalancesTab,
  CategoriesTab,
  DailyTab,
  ExploreCard,
  FocusPanel,
  KpiStrip,
  MainChart,
  SavingsTab,
  type ExploreTab,
  type MainView,
  type SeriesPoint,
} from "./analytics-charts";

type WindowSize = "6" | "12" | "24";
const TAB_KEY = "flowfi.analytics.tab";

function readTab(): ExploreTab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v === "categories" || v === "savings" || v === "balances" || v === "daily") return v;
  } catch {
    // storage unavailable
  }
  return "categories";
}

/**
 * Analytics — how the financial position is changing. Same data and engines as Reports (`useFinancialReportData`);
 * this page only chooses windows, filters and visual forms.
 *
 * Composition (one overview screen, then one tabbed card): KPI strip (Income / Outflow / My spend / Net, each with a
 * sparkline and a comparison) → main chart (cash-flow overview or one metric) beside a focus panel for the selected
 * period → an Explore card whose tabs hold categories, savings, balances and the daily pattern.
 *
 * Sparse history: periods that end before the FIRST record are not drawn as ₹0 months — the window starts at the first
 * period with records (a note says so), and a comparison with a period that has no records reads "No earlier data".
 */
export function AnalyticsWorkspace() {
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const data = useFinancialReportData({ accountIds });
  const [selection, setSelection, isFollowingGlobalCycle, followGlobalCycle] = useSyncedReportPeriod("analytics");
  const [windowSize, setWindowSize] = useState<WindowSize>("12");
  const [view, setView] = useState<MainView>("flow");
  const [compare, setCompare] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [tab, setTabState] = useState<ExploreTab>(() => (typeof window === "undefined" ? "categories" : readTab()));
  const setTab = (t: ExploreTab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      // ignore
    }
  };
  const { resolve, trendOf, previousOf, figuresFor, detailFor, netWorthAtEnds, accountBalancesAtEnds, hasRecordsIn, firstRecordDate } = data;

  const focused = useMemo(() => resolve(selection), [resolve, selection]);
  // The window ends with the focused period and starts no earlier than the first period with records.
  const requested = useMemo(() => trendOf(focused, Number(windowSize)), [trendOf, focused, windowSize]);
  const periods = useMemo(() => {
    const withRecords = requested.filter((p) => hasRecordsIn(p));
    return withRecords.length ? withRecords : [requested[requested.length - 1]];
  }, [requested, hasRecordsIn]);
  const trimmed = periods.length < requested.length;
  const points: SeriesPoint[] = useMemo(() => periods.map((p) => ({ period: p, figures: figuresFor(p) })), [periods, figuresFor]);
  const earlier = useMemo(() => (periods.length ? trendOf(previousOf(periods[0]), periods.length) : []), [periods, trendOf, previousOf]);
  const canCompare = earlier.some((p) => hasRecordsIn(p));
  const comparePoints: SeriesPoint[] | null = useMemo(() => {
    if (!compare || !canCompare) return null;
    return earlier.map((p) => ({ period: p, figures: figuresFor(p) }));
  }, [compare, canCompare, earlier, figuresFor]);
  const focusedDetail = useMemo(() => detailFor(focused), [detailFor, focused]);
  const previousPeriod = useMemo(() => previousOf(focused), [previousOf, focused]);
  const previousDetail = useMemo(() => (hasRecordsIn(previousPeriod) ? detailFor(previousPeriod) : null), [hasRecordsIn, previousPeriod, detailFor]);
  const focusIndex = Math.max(0, points.findIndex((p) => p.period.start.getTime() === focused.start.getTime()));

  const balanceData = useMemo(() => {
    const balances = accountBalancesAtEnds(periods);
    const nw = accountIds.length ? null : netWorthAtEnds(periods);
    return periods.map((p, i) => {
      let liquid = 0;
      let cardOwed = 0;
      for (const [id, series] of balances) {
        const info = data.accountInfo.get(id);
        if (!info || (accountIds.length && !accountIds.includes(id))) continue;
        if (info.isCard) cardOwed -= series[i];
        else liquid += series[i];
      }
      return { label: p.shortLabel, full: p.label, liquid: Math.round(liquid * 100) / 100, cardOwed: Math.round(cardOwed * 100) / 100, netWorth: nw ? nw[i] : null };
    });
  }, [accountBalancesAtEnds, netWorthAtEnds, periods, accountIds, data.accountInfo]);

  const insights = useMemo(() => buildInsights(points, focusedDetail, previousDetail, data.categoryName), [points, focusedDetail, previousDetail, data.categoryName]);

  const unit = periods[0]?.kind === "cycle" && !periods[0].monthGranular ? "cycles" : "months";
  const recordsNote =
    trimmed && firstRecordDate
      ? `Records start ${firstRecordDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · showing ${periods.length} of ${requested.length} ${unit}`
      : null;

  const { categoryName } = data;
  const summaries: Record<ExploreTab, string> = useMemo(() => {
    const topCat = [...focusedDetail.spendByCategory].sort((a, b) => b[1].amount - a[1].amount)[0];
    const saved = points.reduce((s, p) => s + p.figures.net, 0);
    const lastBal = balanceData[balanceData.length - 1];
    const elapsed = Math.max(1, focusedDetail.period.daysElapsed);
    return {
      categories: topCat ? `${categoryName(topCat[0])} · ${focusedDetail.mySpend > 0 ? ((topCat[1].amount / focusedDetail.mySpend) * 100).toFixed(0) : 0}%` : "No spending",
      savings: `${signedCurrency(saved)} in window`,
      balances: lastBal ? `${formatCurrencyCompact(lastBal.liquid)} in bank & cash` : "—",
      daily: `${formatCurrency(focusedDetail.mySpend / elapsed)} a day`,
    };
  }, [focusedDetail, points, balanceData, categoryName]);

  const focus = (p: ReportPeriod) => setSelection(selectionForTrendPoint(p, data.startDay, data.now));

  if (data.isLoading) return <AnalyticsSkeleton />;

  return (
    <div className="@container flex flex-col gap-3 pb-8" data-testid="analytics-page">
      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-b-2xl bg-background/95 px-1 py-1.5 backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-background before:content-['']" data-testid="an-controls">
        <h1 className="mr-1 font-heading text-xl font-semibold tracking-tight text-foreground">Analytics</h1>
        <PeriodBar selection={selection} onChange={setSelection} period={focused} startDay={data.startDay} now={data.now} resolve={resolve} />
        {!isFollowingGlobalCycle && (
          <button
            type="button"
            onClick={followGlobalCycle}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-dashed border-border-strong px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Sync with top-bar cycle
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2 @6xl:ml-auto">
          <Segmented
            value={windowSize}
            onChange={setWindowSize}
            ariaLabel={`How many ${unit} to show`}
            testId="an-window"
            size="xs"
            options={[
              { value: "6", label: `6 ${unit === "cycles" ? "cyc" : "mo"}` },
              { value: "12", label: `12 ${unit === "cycles" ? "cyc" : "mo"}` },
              { value: "24", label: `24 ${unit === "cycles" ? "cyc" : "mo"}` },
            ]}
          />
          <AccountFilter data={data} value={accountIds} onChange={setAccountIds} />
          <CategoryFilter data={data} detail={focusedDetail} value={category} onChange={setCategory} />
        </div>
      </div>

      {accountIds.length > 0 && (
        <p className="rounded-xl bg-muted/70 px-3 py-2 text-xs text-muted-foreground" data-testid="an-account-note">
          Showing money on {accountIds.length === 1 ? (data.accountInfo.get(accountIds[0])?.name ?? "1 account") : `${accountIds.length} accounts`} only. EMI payments count on the account that paid them. Net worth covers everything you own and owe, so it&apos;s hidden while filtering.
          {data.unattributedPaymentCount > 0 && (
            <span data-testid="an-account-unattributed">
              {" "}
              {data.unattributedPaymentCount} older payment{data.unattributedPaymentCount === 1 ? "" : "s"} recorded without a linked transaction can&apos;t be placed on an account, so {data.unattributedPaymentCount === 1 ? "it is" : "they are"} left out.
            </span>
          )}
        </p>
      )}

      <KpiStrip points={points} focusIndex={focusIndex} previous={previousDetail} view={view} onView={setView} />

      <div className="grid gap-3 @5xl:grid-cols-[minmax(0,1fr)_20rem]">
        <MainChart points={points} comparePoints={comparePoints} focused={focused} onFocus={focus} view={view} onView={setView} compare={compare} onCompare={setCompare} canCompare={canCompare} recordsNote={recordsNote} />
        <FocusPanel detail={focusedDetail} insights={insights} categoryName={categoryName} />
      </div>

      <ExploreCard tab={tab} onTab={setTab} summaries={summaries}>
        {tab === "categories" && <CategoriesTab points={points} focusedDetail={focusedDetail} categoryName={categoryName} category={category} onCategory={setCategory} onFocus={focus} accountInfo={data.accountInfo} />}
        {tab === "savings" && <SavingsTab points={points} focused={focused} onFocus={focus} />}
        {tab === "balances" && <BalancesTab data={balanceData} />}
        {tab === "daily" && <DailyTab detail={focusedDetail} category={category} categoryName={categoryName} />}
      </ExploreCard>

      <ScrollNav />
    </div>
  );
}

// ---------------------------------------------------------------- Filters

function AccountFilter({ data, value, onChange }: { data: FinancialReportData; value: string[]; onChange: (v: string[]) => void }) {
  const accounts = [...data.accountInfo.values()].sort((a, b) => Number(a.isCard) - Number(b.isCard) || a.name.localeCompare(b.name));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium shadow-e1 transition-colors", value.length ? "border-primary/40 bg-primary/10 text-foreground" : "border-border/70 bg-card text-muted-foreground hover:text-foreground")}
          data-testid="an-account-filter"
        >
          <Filter className="size-3.5" aria-hidden />
          {value.length === 0 ? "All accounts" : value.length === 1 ? (data.accountInfo.get(value[0])?.name ?? "1 account") : `${value.length} accounts`}
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="max-h-72 overflow-y-auto">
          {accounts.map((a) => (
            <button key={a.id} type="button" onClick={() => toggle(a.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted">
              <span className={cn("grid size-4 shrink-0 place-items-center rounded border", value.includes(a.id) ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{value.includes(a.id) && <Check className="size-3" />}</span>
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              {a.isCard && <span className="rounded bg-purple/12 px-1 text-[10px] font-medium text-purple">Card</span>}
            </button>
          ))}
        </div>
        {value.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            Show all accounts
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CategoryFilter({ data, detail, value, onChange }: { data: FinancialReportData; detail: PeriodDetail; value: string | null; onChange: (v: string | null) => void }) {
  const ids = useMemo(() => {
    const set = new Set<string>([...detail.spendByCategory.keys()]);
    for (const t of data.sources.spendTransactions) if (t.type === "expense" && t.deletedAt == null) set.add(t.categoryId);
    return [...set].sort((a, b) => data.categoryName(a).localeCompare(data.categoryName(b)));
  }, [detail.spendByCategory, data]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium shadow-e1 transition-colors", value ? "border-primary/40 bg-primary/10 text-foreground" : "border-border/70 bg-card text-muted-foreground hover:text-foreground")}
          data-testid="an-category-filter"
        >
          {value ? data.categoryName(value) : "All categories"}
          {value ? (
            <X
              className="size-3.5"
              aria-label="Clear category"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">Narrows the spending charts and daily calendar.</p>
        <div className="max-h-72 overflow-y-auto">
          {ids.map((id) => (
            <button key={id} type="button" onClick={() => onChange(id)} className={cn("flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted", value === id && "bg-muted font-medium")}>
              <span className="truncate">{data.categoryName(id)}</span>
              {value === id && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-11 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_20rem]">
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
      <Skeleton className="h-96 rounded-2xl" />
    </div>
  );
}
