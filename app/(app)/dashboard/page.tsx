"use client";

import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { AccountsOverviewCard } from "@/features/dashboard/components/accounts-overview-card";
import { AiInsightCard } from "@/features/dashboard/components/ai-insight-card";
import { AttentionRow } from "@/features/dashboard/components/attention-row";
import { BudgetsOverviewCard } from "@/features/dashboard/components/budgets-overview-card";
import { CashFlowCard } from "@/features/dashboard/components/cash-flow-card";
import { CreditUtilizationCard } from "@/features/dashboard/components/credit-utilization-card";
import { DashboardHeader } from "@/features/dashboard/components/dashboard-header";
import { ExpensesByCategoryCard } from "@/features/dashboard/components/expenses-by-category-card";
import { NetWorthHero } from "@/features/dashboard/components/net-worth-hero";
import { QuickActionsGrid } from "@/features/dashboard/components/quick-actions-grid";
import { RecentTransactionsCard } from "@/features/dashboard/components/recent-transactions-card";
import { UpcomingBillsCard } from "@/features/dashboard/components/upcoming-bills-card";
import { UpcomingPaymentsCard } from "@/features/dashboard/components/upcoming-payments-card";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";

export default function DashboardPage() {
  const data = useDashboardData();

  return (
    <Stagger className="flex flex-col gap-6 pb-6">
      <StaggerItem>
        <DashboardHeader />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-10">
          <div className="md:col-span-2 lg:col-span-4">
            <NetWorthHero netWorth={data.netWorth} isLoading={data.isLoading} />
          </div>
          <div className="lg:col-span-3">
            <CashFlowCard cashFlow={data.cashFlow} isLoading={data.isLoading} />
          </div>
          <div className="lg:col-span-3">
            <AiInsightCard />
          </div>
        </div>
      </StaggerItem>

      <StaggerItem>
        <AttentionRow items={data.needsAttention} isLoading={data.isLoading} />
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <AccountsOverviewCard accountsOverview={data.accountsOverview} isLoading={data.isLoading} />
          <ExpensesByCategoryCard expensesByCategory={data.expensesByCategory} isLoading={data.isLoading} />
          <BudgetsOverviewCard budgetsOverview={data.budgetsOverview} isLoading={data.isLoading} />
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <RecentTransactionsCard recentTransactions={data.recentTransactions} isLoading={data.isLoading} />
          <UpcomingPaymentsCard payments={data.upcomingPayments} isLoading={data.isLoading} />
          <QuickActionsGrid />
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <CreditUtilizationCard utilization={data.utilization} isLoading={data.isLoading} />
          <UpcomingBillsCard upcomingBills={data.upcomingBills} isLoading={data.isLoading} />
        </div>
      </StaggerItem>
    </Stagger>
  );
}
