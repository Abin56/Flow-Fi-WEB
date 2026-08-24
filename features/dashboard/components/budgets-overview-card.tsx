import { PiggyBank } from "lucide-react";
import { EmptyState } from "@/components/finance/empty-state";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function statusFor(percent: number) {
  if (percent >= 100) return { badge: "bg-expense/12 text-expense", bar: "[&>div]:bg-expense" };
  if (percent >= 80) return { badge: "bg-warning/25 text-warning-foreground", bar: "[&>div]:bg-warning" };
  return { badge: "bg-success/16 text-success", bar: "[&>div]:bg-success" };
}

export interface BudgetsOverviewCardProps {
  budgetsOverview: {
    monthlyBudget: number;
    spent: number;
    categories: { id: string; category: string; spent: number; limit: number }[];
  };
  isLoading?: boolean;
}

/**
 * `budgetsOverview` comes from real Budgets, joined to Category names, via `computeBudgetInsight`/
 * `resolveBudgetPeriod` (lib/engines/budget-insight.ts) in `useDashboardData`. No overall monthly budget or no
 * category budgets both render as empty/zero states, same as the pre-existing empty-array handling below.
 */
export function BudgetsOverviewCard({ budgetsOverview, isLoading }: BudgetsOverviewCardProps) {
  const overallPercent =
    budgetsOverview.monthlyBudget === 0 ? 0 : Math.round((budgetsOverview.spent / budgetsOverview.monthlyBudget) * 100);

  if (isLoading) {
    return (
      <section className="surface-flat flex h-full flex-col gap-4 rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </section>
    );
  }

  if (budgetsOverview.monthlyBudget === 0 && budgetsOverview.categories.length === 0) {
    return (
      <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
        <h2 className="text-sm font-semibold text-foreground">Budgets Overview</h2>
        <EmptyState icon={PiggyBank} title="No budgets set" description="Create a budget to track your spending." className="flex-1" />
      </section>
    );
  }

  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <h2 className="text-sm font-semibold text-foreground">Budgets Overview</h2>

      <div className="mt-3 flex items-baseline justify-between text-xs">
        <div>
          <p className="text-muted-foreground">Monthly Budget</p>
          <p className="mt-0.5 text-base font-semibold text-foreground">{formatCurrency(budgetsOverview.monthlyBudget)}</p>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground">Spent</p>
          <p className="mt-0.5 text-base font-semibold text-foreground">
            {formatCurrency(budgetsOverview.spent)} <span className="text-xs font-normal text-muted-foreground">({overallPercent}%)</span>
          </p>
        </div>
      </div>
      <Progress value={overallPercent} className="mt-2 h-2 [&>div]:bg-expense" />

      <div className="mt-4 flex flex-1 flex-col gap-3">
        {budgetsOverview.categories.map((budget) => {
          const percent = budget.limit === 0 ? 0 : Math.round((budget.spent / budget.limit) * 100);
          const status = statusFor(percent);
          return (
            <div key={budget.id}>
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                <span className="font-medium text-foreground">{budget.category}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">
                    {formatCurrency(budget.spent)} / {formatCurrency(budget.limit)}
                  </span>
                  <Badge className={cn("border-0 px-1.5 text-[10px]", status.badge)}>{percent}%</Badge>
                </div>
              </div>
              <Progress value={Math.min(percent, 100)} className={cn("mt-1.5 h-1.5", status.bar)} />
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="mt-4 rounded-xl bg-muted/70 py-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
      >
        Manage Budgets
      </button>
    </section>
  );
}
