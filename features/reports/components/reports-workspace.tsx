"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReportsData } from "@/features/reports/hooks/use-reports-data";

const tabSkeleton = <Skeleton className="h-72 rounded-3xl" />;

const OverviewTab = dynamic(() => import("@/features/reports/components/overview-tab").then((m) => m.OverviewTab), {
  loading: () => tabSkeleton,
});
const CashFlowTab = dynamic(() => import("@/features/reports/components/cash-flow-tab").then((m) => m.CashFlowTab), {
  loading: () => tabSkeleton,
});
const NetWorthTab = dynamic(() => import("@/features/reports/components/net-worth-tab").then((m) => m.NetWorthTab), {
  loading: () => tabSkeleton,
});
const SpendingTab = dynamic(() => import("@/features/reports/components/spending-tab").then((m) => m.SpendingTab), {
  loading: () => tabSkeleton,
});
const CategoriesTab = dynamic(() => import("@/features/reports/components/categories-tab").then((m) => m.CategoriesTab), {
  loading: () => tabSkeleton,
});
const TrendsTab = dynamic(() => import("@/features/reports/components/trends-tab").then((m) => m.TrendsTab), {
  loading: () => tabSkeleton,
});

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "cash-flow", label: "Cash Flow" },
  { value: "net-worth", label: "Net Worth" },
  { value: "spending", label: "Spending" },
  { value: "categories", label: "Categories" },
  { value: "trends", label: "Trends" },
] as const;

/** Reports workspace shell — the analytics home for the app. Statistics, Cash Flow Analytics, Net Worth
 *  Analytics, and Insights all live as tabs here rather than separate top-level routes, per the
 *  "few nav items, rich experiences inside" IA decision.
 *
 *  Real data is fetched once here via `useReportsData` and passed down to every tab, rather than each
 *  tab re-subscribing independently — avoids six parallel Firestore listener sets for one page. */
export function ReportsWorkspace() {
  const [tab, setTab] = useState<(typeof TABS)[number]["value"]>("overview");
  const data = useReportsData();

  if (data.isLoading) {
    return (
      <div className="flex flex-col gap-6 px-1">
        <Skeleton className="h-56 rounded-3xl" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Skeleton className="h-72 rounded-3xl lg:col-span-2" />
          <Skeleton className="h-72 rounded-3xl" />
        </div>
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="gap-6">
      <TabsList className="clay-pressed h-auto w-fit gap-0.5 rounded-2xl bg-transparent p-1">
        {TABS.map((t) => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            className="rounded-xl px-3.5 py-1.5 text-xs font-medium text-muted-foreground data-active:bg-card data-active:text-foreground data-active:shadow-e1"
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="overview">{tab === "overview" && <OverviewTab data={data} />}</TabsContent>
      <TabsContent value="cash-flow">{tab === "cash-flow" && <CashFlowTab data={data} />}</TabsContent>
      <TabsContent value="net-worth">{tab === "net-worth" && <NetWorthTab data={data} />}</TabsContent>
      <TabsContent value="spending">{tab === "spending" && <SpendingTab data={data} />}</TabsContent>
      <TabsContent value="categories">{tab === "categories" && <CategoriesTab data={data} />}</TabsContent>
      <TabsContent value="trends">{tab === "trends" && <TrendsTab data={data} />}</TabsContent>
    </Tabs>
  );
}
