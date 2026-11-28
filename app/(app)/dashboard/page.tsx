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
import { DashboardPanelGate } from "@/features/dashboard/components/dashboard-panel-gate";
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
  const states = data.panelStates;
  const { preferences, update } = useUserPreferences();
  const router = useRouter();

  return (
    <Stagger className="flex min-w-0 flex-col gap-4 px-1 pb-6">
      <StaggerItem>
        <DashboardHeader />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <DashboardPanelGate label="Net worth" state={states.netWorth}>
            <NetWorthHero
              netWorth={data.netWorth}
              isLoading={states.netWorth === "loading"}
              hideAmount={preferences.hideNetWorth}
              onToggleHideAmount={() => update("hideNetWorth", !preferences.hideNetWorth)}
            />
          </DashboardPanelGate>
          <DashboardPanelGate label="Cash flow" state={states.cashFlow}>
            <CashFlowCard cashFlow={data.cashFlow} isLoading={states.cashFlow === "loading"} />
          </DashboardPanelGate>
        </div>
      </StaggerItem>

      <StaggerItem className="flex flex-col gap-2.5">
        {/* A day before the next cycle: collections postponed into it. Renders nothing otherwise. */}
        <UpcomingCycleAlert onOpen={(personId, key) => router.push(`/people?person=${encodeURIComponent(personId)}&obligation=${encodeURIComponent(key)}&settle=1`)} />
        <DashboardPanelGate label="Needs your attention" state={states.attention}>
          <AttentionRow items={data.needsAttention} isLoading={states.attention === "loading"} />
        </DashboardPanelGate>
        {/* Purpose money people gave me — one quiet line, nothing when there is none */}
        <MoneyToUseSignal />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
          <DashboardPanelGate label="Recent transactions" state={states.recent} compact>
            <RecentTransactionsCard recentTransactions={data.recentTransactions} isLoading={states.recent === "loading"} />
          </DashboardPanelGate>
          <DashboardPanelGate label="Upcoming payments" state={states.upcoming} compact>
            <UpcomingPaymentsCard payments={data.upcomingPayments} isLoading={states.upcoming === "loading"} />
          </DashboardPanelGate>
          <div className="md:col-span-2 xl:col-span-1">
            <DashboardPanelGate label="Accounts" state={states.accounts} compact>
              <AccountsOverviewCard accountsOverview={data.accountsOverview} isLoading={states.accounts === "loading"} />
            </DashboardPanelGate>
          </div>
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DashboardPanelGate label="Expenses by category" state={states.expenses}>
            <ExpensesByCategoryCard expensesByCategory={data.expensesByCategory} isLoading={states.expenses === "loading"} />
          </DashboardPanelGate>
          <DashboardPanelGate label="Credit card utilization" state={states.credit}>
            <CreditUtilizationCard utilization={data.utilization} isLoading={states.credit === "loading"} />
          </DashboardPanelGate>
        </div>
      </StaggerItem>
    </Stagger>
  );
}
