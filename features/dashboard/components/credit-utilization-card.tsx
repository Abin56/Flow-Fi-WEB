import { CreditCard } from "lucide-react";
import { EmptyState } from "@/components/finance/empty-state";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function barClassFor(percent: number) {
  if (percent >= 90) return "[&>div]:bg-expense";
  if (percent >= 70) return "[&>div]:bg-warning";
  return "[&>div]:bg-success";
}

export interface CreditUtilizationCardProps {
  utilization: {
    totalOutstanding: number;
    totalCreditLimit: number;
    percent: number;
    cards: { id: string; name: string; outstanding: number; creditLimit: number; percent: number }[];
  };
  isLoading?: boolean;
}

/**
 * `utilization` comes from active `CreditCardProfile`s, `Statement`s, and `Emi`s via
 * `lib/engines/credit-utilization.ts` (`creditCardStanding`/`sharedCreditLimitStanding`/
 * `creditUtilizationPercent`), composed in `useDashboardData`.
 */
export function CreditUtilizationCard({ utilization, isLoading }: CreditUtilizationCardProps) {
  if (isLoading) {
    return (
      <section className="surface-flat flex h-full flex-col gap-4 rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </section>
    );
  }

  if (utilization.cards.length === 0) {
    return (
      <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
        <h2 className="text-sm font-semibold text-foreground">Credit Card Utilization</h2>
        <EmptyState icon={CreditCard} title="No credit cards yet" description="Add a credit card to track utilization." className="flex-1" />
      </section>
    );
  }

  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <h2 className="text-sm font-semibold text-foreground">Credit Card Utilization</h2>

      <div className="mt-3 flex items-baseline justify-between text-xs">
        <div>
          <p className="text-muted-foreground">Total Outstanding</p>
          <p className="mt-0.5 text-base font-semibold text-foreground">{formatCurrency(utilization.totalOutstanding)}</p>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground">Total Limit</p>
          <p className="mt-0.5 text-base font-semibold text-foreground">
            {formatCurrency(utilization.totalCreditLimit)}{" "}
            <span className="text-xs font-normal text-muted-foreground">({Math.round(utilization.percent)}%)</span>
          </p>
        </div>
      </div>
      <Progress value={Math.min(utilization.percent, 100)} className={cn("mt-2 h-2", barClassFor(utilization.percent))} />

      <div className="mt-4 flex flex-1 flex-col gap-3">
        {utilization.cards.map((card) => (
          <div key={card.id}>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
              <span className="font-medium text-foreground">{card.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {formatCurrency(card.outstanding)} / {formatCurrency(card.creditLimit)}
              </span>
            </div>
            <Progress value={Math.min(card.percent, 100)} className={cn("mt-1.5 h-1.5", barClassFor(card.percent))} />
          </div>
        ))}
      </div>
    </section>
  );
}
