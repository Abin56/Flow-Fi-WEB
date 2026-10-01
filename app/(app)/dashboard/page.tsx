"use client";

import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { AccountsOverviewCard } from "@/features/dashboard/components/accounts-overview-card";
import { AttentionRow } from "@/features/dashboard/components/attention-row";
import { MoneyToUseSignal } from "@/features/people/components/purpose-money-signals";
import { CashFlowCard } from "@/features/dashboard/components/cash-flow-card";
import { CreditUtilizationCard } from "@/features/dashboard/components/credit-utilization-card";
import { DashboardHeader } from "@/features/dashboard/components/dashboard-header";
import { ExpensesByCategoryCard } from "@/features/dashboard/components/expenses-by-category-card";
import { NetWorthHero } from "@/features/dashboard/components/net-worth-hero";
import { QuickActionsGrid } from "@/features/dashboard/components/quick-actions-grid";
import { RecentTransactionsCard } from "@/features/dashboard/components/recent-transactions-card";
import { UpcomingPaymentsCard } from "@/features/dashboard/components/upcoming-payments-card";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";
import { useUserPreferences } from "@/features/settings/hooks/use-user-preferences";

/**
 * Dashboard, ordered by information priority:
 *  1. Headline — net worth beside this month's cash flow.
 *  2. Attention — anything overdue / at risk, right under the headline.
 *  3. Activity — recent transactions beside upcoming payments.
 *  4. Composition — accounts beside spending by category.
 *  5. Credit utilization + shortcuts.
 * Every figure is live (`useDashboardData`); nothing here reads mock data.
 */
export default function DashboardPage() {
  const data = useDashboardData();
  const { preferences, update } = useUserPreferences();

  return (
    <Stagger className="flex min-w-0 flex-col gap-5 px-1 pb-8">
      <StaggerItem>
        <DashboardHeader />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <NetWorthHero
            netWorth={data.netWorth}
            isLoading={data.isLoading}
            hideAmount={preferences.hideNetWorth}
            onToggleHideAmount={() => update("hideNetWorth", !preferences.hideNetWorth)}
          />
          <CashFlowCard cashFlow={data.cashFlow} isLoading={data.isLoading} />
        </div>
      </StaggerItem>

      <StaggerItem>
        <AttentionRow items={data.needsAttention} isLoading={data.isLoading} />
        {/* Purpose money people gave me — one quiet line, nothing when there is none */}
        <MoneyToUseSignal className="mt-3" />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RecentTransactionsCard recentTransactions={data.recentTransactions} isLoading={data.isLoading} />
          <UpcomingPaymentsCard payments={data.upcomingPayments} isLoading={data.isLoading} />
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <AccountsOverviewCard accountsOverview={data.accountsOverview} isLoading={data.isLoading} />
          <ExpensesByCategoryCard expensesByCategory={data.expensesByCategory} isLoading={data.isLoading} />
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <CreditUtilizationCard utilization={data.utilization} isLoading={data.isLoading} />
          </div>
          <QuickActionsGrid />
        </div>
      </StaggerItem>
    </Stagger>
  );
}
