import Link from "next/link";
import { CreditCard } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DashEmpty, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function toneFor(percent: number) {
  if (percent >= 90) return { bar: "bg-expense", text: "text-expense" };
  if (percent >= 70) return { bar: "bg-warning", text: "text-warning-foreground dark:text-warning" };
  return { bar: "bg-success", text: "text-success" };
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

/** `utilization` comes from `lib/engines/credit-utilization.ts`, composed in `useDashboardData`. */
export function CreditUtilizationCard({ utilization, isLoading }: CreditUtilizationCardProps) {
  const overall = toneFor(utilization.percent);
  return (
    <DashPanel label="Credit card utilization">
      <DashPanelHeader icon={CreditCard} title="Credit card utilization" href="/credit-cards" />
      {isLoading ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : utilization.cards.length === 0 ? (
        <DashEmpty
          title="No credit cards yet"
          description="Add a credit card to track utilization."
          action={
            <Link href="/credit-cards" className="text-xs font-semibold text-primary-accent-text hover:underline">
              Add credit card
            </Link>
          }
        />
      ) : (
        <div className="grid flex-1 grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)] md:divide-x md:divide-border-strong/40">
          <div className="flex flex-col gap-2 border-b border-border-strong/40 px-4 py-3 md:border-b-0">
            <p className={DASH_LABEL}>Outstanding</p>
            <p className="text-[26px] leading-tight font-bold tracking-tight text-foreground tabular-nums">{formatCurrency(utilization.totalOutstanding)}</p>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div className={cn("h-full rounded-full", overall.bar)} style={{ width: `${Math.min(utilization.percent, 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              <span className={cn("font-bold", overall.text)}>{Math.round(utilization.percent)}% used</span> of {formatCurrency(utilization.totalCreditLimit)}
            </p>
          </div>
          <div className="divide-y divide-border-strong/40">
            {utilization.cards.map((card) => {
              const tone = toneFor(card.percent);
              return (
                <div key={card.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-semibold text-foreground">{card.name}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      <span className="font-semibold text-foreground">{formatCurrency(card.outstanding)}</span> / {formatCurrency(card.creditLimit)}
                      <span className={cn("ml-1.5 font-bold", tone.text)}>{Math.round(card.percent)}%</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${Math.min(card.percent, 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DashPanel>
  );
}
