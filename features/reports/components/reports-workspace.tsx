"use client";

import { Download } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { downloadCsv } from "@/features/transaction-studio/lib/export-csv";
import { useFinancialReportData, useReportPeriodSelection } from "@/features/reports/hooks/use-financial-report-data";
import { periodReportCsv } from "@/features/reports/lib/report-csv";
import { selectionForTrendPoint, type ReportPeriod } from "@/lib/engines/report-period";
import { formatCurrencyCompact } from "@/lib/format";
import { PeriodBar } from "./period-bar";
import { changePercent, MONEY, percentLabel, signedCurrency } from "./report-ui";
import { CashFlowChart, KpiStrip, MoneyFlowPanel, type FlowView, type KpiKey, type KpiSpec } from "./reports-overview";
import { AccountsTab, DebtsTab, DetailsCard, NetWorthTab, PeopleTab, SpendingTab, type DetailTab } from "./reports-sections";

const NET_WORTH_COUNT = 12;
const TAB_KEY = "flowfi.reports.tab";
const DETAIL_TABS: readonly DetailTab[] = ["spending", "accounts", "debts", "people", "networth"];

function readTab(): DetailTab {
  try {
    const v = sessionStorage.getItem(TAB_KEY) as DetailTab | null;
    if (v && DETAIL_TABS.includes(v)) return v;
  } catch {
    // storage unavailable
  }
  return "spending";
}

/**
 * Reports — what happened financially in a chosen period (Month Cycle, calendar month or custom range). Every figure
 * comes from `useFinancialReportData` (shared engines, shared live listeners); nothing on this page computes money.
 *
 * Composition: sticky title + period bar → six KPI tiles (period figures + today's debt / Net Worth) → cash-flow chart
 * (four views of the same periods) beside "Where the money went" → ONE tabbed details card (Spending, Accounts, Debts &
 * cards, People, Net worth). The overview fits a 1440×900 screen; detail is one click away, never a long scroll.
 */
export function ReportsWorkspace() {
  const data = useFinancialReportData();
  const [selection, setSelection] = useReportPeriodSelection("reports");
  const [view, setView] = useState<FlowView>("flow");
  const [windowSize, setWindowSize] = useState<"6" | "12">("6");
  const [showTable, setShowTable] = useState(false);
  const [tab, setTabState] = useState<DetailTab>(() => (typeof window === "undefined" ? "spending" : readTab()));
  const setTab = (t: DetailTab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      // ignore
    }
  };
  const { resolve, previousOf, trendOf, figuresFor, detailFor, netWorthAtEnds, hasRecordsIn, firstRecordDate } = data;
  // Periods that end before the first record are "no records", never ₹0 — trends start at the first period with records.
  const withRecords = useCallback(
    (ps: ReportPeriod[]) => {
      const kept = ps.filter((p) => hasRecordsIn(p));
      return kept.length ? kept : ps.slice(-1);
    },
    [hasRecordsIn],
  );

  const period = useMemo(() => resolve(selection), [resolve, selection]);
  const previousPeriod = useMemo(() => previousOf(period), [previousOf, period]);
  const detail = useMemo(() => detailFor(period), [detailFor, period]);
  // A previous period with no records has nothing to compare with — deltas read "No earlier data", never "+100%".
  const prevHasRecords = hasRecordsIn(previousPeriod);
  const previous = useMemo(() => (prevHasRecords ? figuresFor(previousPeriod) : null), [figuresFor, previousPeriod, prevHasRecords]);
  const delta = (cur: number, prev: number | undefined) => (previous && prev !== undefined ? changePercent(cur, prev) : null);

  const requested = useMemo(() => trendOf(period, Number(windowSize)), [trendOf, period, windowSize]);
  const trend = useMemo(() => withRecords(requested).map((p) => ({ period: p, figures: figuresFor(p) })), [requested, figuresFor, withRecords]);
  const focusIndex = Math.max(0, trend.findIndex((t) => t.period.start.getTime() === period.start.getTime()));
  const netWorthPoints = useMemo(() => {
    const periods = withRecords(trendOf(period, NET_WORTH_COUNT));
    const values = netWorthAtEnds(periods);
    return periods.map((p, i) => ({ period: p, netWorth: values[i] }));
  }, [trendOf, netWorthAtEnds, period, withRecords]);
  const [nwPrev, nwEnd] = useMemo(() => netWorthAtEnds([previousPeriod, period]), [netWorthAtEnds, previousPeriod, period]);

  const unit = period.kind === "cycle" && !period.monthGranular ? "cycles" : "months";
  const recordsNote =
    trend.length < requested.length && firstRecordDate
      ? `Records start ${firstRecordDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · ${trend.length} of ${requested.length} ${unit}`
      : null;

  const exportCsv = () => {
    const csv = periodReportCsv({
      detail,
      accountName: (id) => data.accountInfo.get(id)?.name ?? "—",
      categoryName: data.categoryName,
    });
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    downloadCsv(`flowfi-report-${iso(period.start)}-to-${iso(period.end)}.csv`, csv);
  };

  const { position, categoryName, accountInfo } = data;
  const summaries: Record<DetailTab, string> = useMemo(() => {
    const top = [...detail.spendByCategory].sort((a, b) => b[1].amount - a[1].amount)[0];
    const cashLines = detail.accounts.filter((l) => !accountInfo.get(l.accountId)?.isCard);
    const cashChange = cashLines.reduce((s, l) => s + l.closing - l.opening, 0);
    const nwFirst = netWorthPoints[0]?.netWorth ?? 0;
    const nwLast = netWorthPoints[netWorthPoints.length - 1]?.netWorth ?? 0;
    return {
      spending: top ? `Top: ${categoryName(top[0])} ${formatCurrencyCompact(top[1].amount)}` : "No spending",
      accounts: `${signedCurrency(cashChange)} in bank & cash`,
      debts: `${formatCurrencyCompact(detail.debt.emiPaid + detail.debt.loanRepaid + detail.debt.cardBillPayments)} paid · ${formatCurrencyCompact(position.totalLiabilities)} owed`,
      people: `${formatCurrencyCompact(position.peopleReceivable)} owed to me · ${formatCurrencyCompact(position.peoplePayable)} I owe`,
      networth: `${signedCurrency(nwLast - nwFirst)} over ${netWorthPoints.length} ${unit}`,
    };
  }, [detail, accountInfo, categoryName, netWorthPoints, position, unit]);

  const pickKpi = (k: KpiKey) => {
    const go = (t: DetailTab) => {
      setTab(t);
      requestAnimationFrame(() => document.getElementById("rep-details")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    if (k === "income" || k === "outflow") setView("flow");
    else if (k === "net") setView("net");
    else if (k === "myspend") go("spending");
    else if (k === "debt") go("debts");
    else go("networth");
  };
  const activeKpi: KpiKey | null = view === "net" ? "net" : null;

  if (data.isLoading) return <ReportsSkeleton />;

  const nwValue = period.isCurrent || period.end.getTime() > data.now.getTime() ? position.netWorth : nwEnd;
  const spark = (read: (f: (typeof trend)[number]["figures"]) => number) => trend.map((t) => read(t.figures));
  const kpis: KpiSpec[] = [
    {
      key: "income",
      label: "Income",
      tone: MONEY.in,
      value: detail.income,
      delta: delta(detail.income, previous?.income),
      spark: spark((f) => f.income),
      hint: "Money earned: salary and other income. Transfers, loan money received, card refunds and People settlements are not counted.",
      note: "Earned",
    },
    {
      key: "outflow",
      label: "Total outflow",
      tone: MONEY.out,
      value: detail.outflow,
      delta: delta(detail.outflow, previous?.outflow),
      upIsGood: false,
      spark: spark((f) => f.outflow),
      hint: "Everything spent, counted the Month Cycle way: card purchases when made, EMI installments when paid. Includes others' share of split bills you paid.",
      note: "Month Cycle basis",
    },
    {
      key: "net",
      label: "Net cash flow",
      tone: MONEY.net,
      value: detail.net,
      format: signedCurrency,
      delta: delta(detail.net, previous?.net),
      spark: spark((f) => f.net),
      hint: "Income − Total outflow.",
      note: detail.savingsRate != null ? `Saved ${percentLabel(detail.savingsRate, 0)} of income` : "No income yet",
      emphasis: true,
    },
    {
      key: "myspend",
      label: "My spend",
      tone: MONEY.spend,
      value: detail.mySpend,
      delta: delta(detail.mySpend, previous?.mySpend),
      upIsGood: false,
      spark: spark((f) => f.mySpend),
      hint: "Only your own share: your part of split bills, with no transfers, card bill payments or loan principal.",
      note: "My share only",
    },
    {
      key: "debt",
      label: "Outstanding debt",
      tone: "var(--purple)",
      value: position.totalLiabilities,
      hint: "Remaining principal on loans, EMIs and cards, plus money you owe people. Future interest isn't counted. Always today's figure.",
      note: "As of today",
      parts: position.liabilities.map((l, i) => ({ label: l.name, value: l.value, color: ["var(--chart-2)", "var(--purple)", "var(--chart-4)", "var(--chart-1)", "var(--muted-foreground)"][i % 5] })),
    },
    {
      key: "networth",
      label: "Net worth",
      tone: "var(--primary)",
      value: nwValue,
      delta: prevHasRecords ? changePercent(nwEnd, nwPrev) : null,
      spark: netWorthPoints.map((p) => p.netWorth),
      hint: "What you own minus what you owe, including loans and People balances.",
      note: period.isCurrent ? "Today" : "At period end",
    },
  ];

  const partial = period.isCurrent && period.daysElapsed < period.days;

  return (
    <div className="@container flex flex-col gap-3 pb-8" data-testid="reports-page">
      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-b-2xl bg-background/95 px-1 py-1.5 backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-background before:content-['']" data-testid="rep-controls">
        <h1 className="mr-1 font-heading text-xl font-semibold tracking-tight text-foreground">Reports</h1>
        <PeriodBar selection={selection} onChange={setSelection} period={period} startDay={data.startDay} now={data.now} resolve={resolve} />
        <div className="flex flex-wrap items-center gap-2 @6xl:ml-auto">
          <span className="text-[11px] text-muted-foreground" data-testid="rep-compare-note">
            Compared with {previousPeriod.label}
            {partial ? " (full period)" : ""}
          </span>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border/70 bg-card px-2.5 text-xs font-semibold text-foreground shadow-e1 transition-colors hover:bg-muted"
            data-testid="rep-export"
          >
            <Download className="size-3.5" aria-hidden />
            Export CSV
          </button>
        </div>
      </div>

      <KpiStrip items={kpis} focusIndex={focusIndex} active={activeKpi} onPick={pickKpi} />

      <div className="grid gap-3 @5xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        <CashFlowChart
          points={trend}
          selected={period}
          onSelect={(p) => setSelection(selectionForTrendPoint(p, data.startDay, data.now))}
          view={view}
          onView={setView}
          windowSize={windowSize}
          onWindow={setWindowSize}
          showTable={showTable}
          onShowTable={setShowTable}
          recordsNote={recordsNote}
        />
        <MoneyFlowPanel detail={detail} position={position} />
      </div>

      <DetailsCard tab={tab} onTab={setTab} summaries={summaries}>
        {tab === "spending" && <SpendingTab detail={detail} previous={previous} categoryName={categoryName} accountInfo={accountInfo} />}
        {tab === "accounts" && <AccountsTab detail={detail} accountInfo={accountInfo} />}
        {tab === "debts" && <DebtsTab detail={detail} position={position} accountInfo={accountInfo} />}
        {tab === "people" && <PeopleTab detail={detail} position={position} />}
        {tab === "networth" && <NetWorthTab points={netWorthPoints} position={position} selected={period} />}
      </DetailsCard>

      <ScrollNav />
    </div>
  );
}

function ReportsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-11 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[5.75rem] rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[1.75fr_1fr]">
        <Skeleton className="h-[19rem] rounded-2xl" />
        <Skeleton className="h-[19rem] rounded-2xl" />
      </div>
      <Skeleton className="h-80 rounded-2xl" />
    </div>
  );
}
