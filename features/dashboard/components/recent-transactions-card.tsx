import { ArrowDownLeft, ArrowUpRight, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_ROW, DashEmpty, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { HISTORICAL_PAYMENT_LABEL, HISTORICAL_PAYMENT_SHORT, historicalPaymentExplanation } from "@/features/loans/lib/historical-payment";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface RecentTransactionsCardProps {
  recentTransactions: {
    id: string;
    merchant: string;
    category: string;
    date: string;
    amount: number;
    /** An "Already paid earlier" Loan payment — no account was debited. */
    historical?: boolean;
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
            <Skeleton key={i} className="h-8 w-full rounded-[6px]" />
          ))}
        </div>
      ) : recentTransactions.length === 0 ? (
        <DashEmpty title="No transactions yet" description="Your recent activity will show up here." />
      ) : (
        <div className="divide-y divide-border-strong/35 py-0.5">
          {recentTransactions.map((txn) => {
            const incoming = txn.amount > 0;
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
            return (
              <div key={txn.id} className={cn(DASH_ROW, "group")}>
                <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-[7px] transition-transform duration-200 group-hover:scale-105", incoming ? "bg-success/12 text-success" : "bg-expense/10 text-expense")}>
                  <Icon className="size-3.5" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-snug font-semibold text-foreground">{txn.merchant}</p>
                  <p className="truncate text-[11.5px] leading-snug text-muted-foreground">
                    {txn.category} · {txn.date}
                  </p>
                  {txn.historical && (
                    <p className="truncate text-[11.5px] font-medium text-muted-foreground" title={historicalPaymentExplanation(incoming)}>
                      {HISTORICAL_PAYMENT_LABEL} · {HISTORICAL_PAYMENT_SHORT.toLowerCase()}
                    </p>
                  )}
                </div>
                <p className={cn("shrink-0 text-sm font-bold tabular-nums", txn.historical ? "text-muted-foreground" : incoming ? "text-success" : "text-foreground")}>
                  {txn.historical ? "" : incoming ? "+" : "−"}
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
