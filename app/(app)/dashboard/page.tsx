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
import { UpcomingPaymentsCard } from "@/features/dashboard/components/upcoming-payments-card";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";

/**
 * Dashboard composition, ordered by information priority (1. total money, 2/3. income+expense,
 * 4. upcoming bills, 5. recent activity, 6. financial health) rather than by card inventory:
 *
 *  1. Hero row    — Total Balance + Financial Health (NetWorthHero), Cash Flow (income/expense),
 *                   AI Insight. The three things a returning user checks first, side by side.
 *  2. Attention   — anything overdue/at-risk (bills, budgets) surfaces immediately under the hero,
 *                   before any supporting detail.
 *  3. Activity    — Recent Transactions + Upcoming Payments as a matched two-column pair (this is
 *                   the "recent activity" + "upcoming bills" priority, kept side by side since
 *                   they're the two things most read together). UpcomingBillsCard was dropped here:
 *                   it duplicated a strict subset of UpcomingPaymentsCard's bills+statements feed
 *                   (see use-dashboard-data.ts), so showing both was noise, not signal.
 *  4. Composition — Accounts / Expenses by Category / Budgets: supporting breakdown once the
 *                   headline numbers and activity are already understood.
 *  5. Secondary   — Credit Utilization + Quick Actions close the page; Quick Actions' buttons are
 *                   all "coming soon" placeholders today, so it no longer competes for top-of-page
 *                   space with real, live data.
 */
export default function DashboardPage() {
  const data = useDashboardData();

  return (
    <Stagger className="flex flex-col gap-8 pb-8">
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RecentTransactionsCard recentTransactions={data.recentTransactions} isLoading={data.isLoading} />
          <UpcomingPaymentsCard payments={data.upcomingPayments} isLoading={data.isLoading} />
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Overview</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <AccountsOverviewCard accountsOverview={data.accountsOverview} isLoading={data.isLoading} />
            <ExpensesByCategoryCard expensesByCategory={data.expensesByCategory} isLoading={data.isLoading} />
            <BudgetsOverviewCard budgetsOverview={data.budgetsOverview} isLoading={data.isLoading} />
          </div>
        </div>
      </StaggerItem>

      <StaggerItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <CreditUtilizationCard utilization={data.utilization} isLoading={data.isLoading} />
          </div>
          <QuickActionsGrid />
        </div>
      </StaggerItem>
    </Stagger>
  );
}
