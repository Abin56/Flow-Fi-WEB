import { PiggyBank } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DashEmpty, DashFooterLink, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function statusFor(percent: number) {
  if (percent >= 100) return { text: "text-expense", bar: "bg-expense" };
  if (percent >= 80) return { text: "text-warning-foreground dark:text-warning", bar: "bg-warning" };
  return { text: "text-success", bar: "bg-success" };
}

export interface BudgetsOverviewCardProps {
  budgetsOverview: {
    monthlyBudget: number;
    spent: number;
    categories: { id: string; category: string; spent: number; limit: number }[];
  };
  isLoading?: boolean;
}

/** `budgetsOverview` comes from real Budgets via `computeBudgetInsight`/`resolveBudgetPeriod` in `useDashboardData`. */
export function BudgetsOverviewCard({ budgetsOverview, isLoading }: BudgetsOverviewCardProps) {
  const overallPercent = budgetsOverview.monthlyBudget === 0 ? 0 : Math.round((budgetsOverview.spent / budgetsOverview.monthlyBudget) * 100);
  const overall = statusFor(overallPercent);
  const empty = budgetsOverview.monthlyBudget === 0 && budgetsOverview.categories.length === 0;

  return (
    <DashPanel label="Budgets">
      <DashPanelHeader icon={PiggyBank} title="Budgets" />
      {isLoading ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : empty ? (
        <DashEmpty title="No budgets set" description="Create a budget to track your spending." />
      ) : (
        <>
          <div className="border-b border-border-strong/40 px-4 py-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className={DASH_LABEL}>Spent</p>
                <p className="text-[22px] leading-tight font-bold text-foreground tabular-nums">{formatCurrency(budgetsOverview.spent)}</p>
              </div>
              <div className="text-right">
                <p className={DASH_LABEL}>of budget</p>
                <p className="text-sm font-semibold text-foreground tabular-nums">
                  {formatCurrency(budgetsOverview.monthlyBudget)} <span className={cn("font-bold", overall.text)}>· {overallPercent}%</span>
                </p>
              </div>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
              <div className={cn("h-full rounded-full", overall.bar)} style={{ width: `${Math.min(overallPercent, 100)}%` }} />
            </div>
          </div>

          <div className="divide-y divide-border-strong/40">
            {budgetsOverview.categories.map((budget) => {
              const percent = budget.limit === 0 ? 0 : Math.round((budget.spent / budget.limit) * 100);
              const status = statusFor(percent);
              return (
                <div key={budget.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-semibold text-foreground">{budget.category}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      <span className="font-semibold text-foreground">{formatCurrency(budget.spent)}</span> / {formatCurrency(budget.limit)}
                      <span className={cn("ml-1.5 font-bold", status.text)}>{percent}%</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div className={cn("h-full rounded-full", status.bar)} style={{ width: `${Math.min(percent, 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <DashFooterLink href="/budgets">Manage budgets</DashFooterLink>
    </DashPanel>
  );
}
