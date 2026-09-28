import { ArrowDownLeft, ArrowUpRight, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DashEmpty, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface RecentTransactionsCardProps {
  recentTransactions: {
    id: string;
    merchant: string;
    category: string;
    date: string;
    amount: number;
  }[];
  isLoading?: boolean;
}

/** `recentTransactions` is the real Transaction list (most recent 5), via `useDashboardData`. */
export function RecentTransactionsCard({ recentTransactions, isLoading }: RecentTransactionsCardProps) {
  return (
    <DashPanel label="Recent transactions">
      <DashPanelHeader icon={Receipt} title="Recent transactions" href="/transactions" />
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-[6px]" />
          ))}
        </div>
      ) : recentTransactions.length === 0 ? (
        <DashEmpty title="No transactions yet" description="Your recent activity will show up here." />
      ) : (
        <div className="divide-y divide-border-strong/40">
          {recentTransactions.map((txn) => {
            const incoming = txn.amount > 0;
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
            return (
              <div key={txn.id} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/50">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", incoming ? "bg-success/12 text-success" : "bg-expense/10 text-expense")}>
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{txn.merchant}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {txn.category} · {txn.date}
                  </p>
                </div>
                <p className={cn("shrink-0 text-[16px] font-bold tabular-nums", incoming ? "text-success" : "text-foreground")}>
                  {incoming ? "+" : "−"}
                  {formatCurrency(Math.abs(txn.amount))}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </DashPanel>
  );
}
