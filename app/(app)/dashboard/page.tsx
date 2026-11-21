"use client";

import { useRouter } from "next/navigation";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { AccountsOverviewCard } from "@/features/dashboard/components/accounts-overview-card";
import { AttentionRow } from "@/features/dashboard/components/attention-row";
import { MoneyToUseSignal } from "@/features/people/components/purpose-money-signals";
import { UpcomingCycleAlert } from "@/features/people/components/upcoming-cycle-alert";
import { CashFlowCard } from "@/features/dashboard/components/cash-flow-card";
import { CreditUtilizationCard } from "@/features/dashboard/components/credit-utilization-card";
import { DashboardHeader } from "@/features/dashboard/components/dashboard-header";
import { ExpensesByCategoryCard } from "@/features/dashboard/components/expenses-by-category-card";
import { NetWorthHero } from "@/features/dashboard/components/net-worth-hero";
import { RecentTransactionsCard } from "@/features/dashboard/components/recent-transactions-card";
import { UpcomingPaymentsCard } from "@/features/dashboard/components/upcoming-payments-card";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";
import { useUserPreferences } from "@/features/settings/hooks/use-user-preferences";

/**
 * Dashboard, ordered by information priority and packed so the first screen carries the essentials:
 *  1. Greeting + shortcuts toolbar (every workspace one click away, no scrolling to find it).
 *  2. Headline — net worth (own vs owe side by side) beside this month's cash flow.
 *  3. Attention — a slim strip; one alert costs one row.
 *  4. Day-to-day — recent transactions, upcoming payments and accounts in one row (lists scroll in place).
 *  5. Composition — spending by category beside credit utilization.
 * Every figure is live (`useDashboardData`); nothing here reads mock data or recomputes a total.
 */
export default function DashboardPage() {
  const data = useDashboardData();
  const { preferences, update } = useUserPreferences();
  const router = useRouter();

  return (
    <Stagger className="flex min-w-0 flex-col gap-4 px-1 pb-6">
      <StaggerItem>
        <DashboardHeader />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <NetWorthHero
            netWorth={data.netWorth}
            isLoading={data.isLoading}
            hideAmount={preferences.hideNetWorth}
            onToggleHideAmount={() => update("hideNetWorth", !preferences.hideNetWorth)}
          />
          <CashFlowCard cashFlow={data.cashFlow} isLoading={data.isLoading} />
        </div>
      </StaggerItem>

      <StaggerItem className="flex flex-col gap-2.5">
        {/* A day before the next cycle: collections postponed into it. Renders nothing otherwise. */}
        <UpcomingCycleAlert onOpen={(personId, key) => router.push(`/people?person=${encodeURIComponent(personId)}&obligation=${encodeURIComponent(key)}&settle=1`)} />
        <AttentionRow items={data.needsAttention} isLoading={data.isLoading} />
        {/* Purpose money people gave me — one quiet line, nothing when there is none */}
        <MoneyToUseSignal />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <RecentTransactionsCard recentTransactions={data.recentTransactions} isLoading={data.isLoading} />
          <UpcomingPaymentsCard payments={data.upcomingPayments} isLoading={data.isLoading} />
          <div className="md:col-span-2 xl:col-span-1">
            <AccountsOverviewCard accountsOverview={data.accountsOverview} isLoading={data.isLoading} />
          </div>
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ExpensesByCategoryCard expensesByCategory={data.expensesByCategory} isLoading={data.isLoading} />
          <CreditUtilizationCard utilization={data.utilization} isLoading={data.isLoading} />
        </div>
      </StaggerItem>
    </Stagger>
  );
}
