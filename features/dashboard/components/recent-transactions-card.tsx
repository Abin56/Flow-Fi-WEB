import { ArrowDownLeft, ArrowUpRight, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DashEmpty, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
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
    <DashPanel label="Recent transactions" className="@container h-auto">
      <DashPanelHeader icon={Receipt} title="Recent transactions" href="/transactions" compact />
      {isLoading ? (
        <div className="divide-y divide-border-strong/35">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex min-h-8 items-center gap-2 px-2">
              <Skeleton className="size-5 rounded" />
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="ml-auto h-2.5 w-12" />
            </div>
          ))}
        </div>
      ) : recentTransactions.length === 0 ? (
        <DashEmpty title="No transactions yet" description="Your recent activity will show up here." compact />
      ) : (
        <ul className="grid grid-cols-[2rem_minmax(0,1fr)_max-content_minmax(4.5rem,max-content)] divide-y divide-border-strong/35 @min-[22rem]:grid-cols-[2rem_minmax(0,1.2fr)_minmax(0,1fr)_max-content_minmax(4.5rem,max-content)]">
          {recentTransactions.map((txn) => {
            const incoming = txn.amount > 0;
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={txn.id} className="col-span-full grid min-h-8 grid-cols-subgrid items-center transition-colors hover:bg-secondary/55">
                <span className={cn("flex size-5 items-center justify-center justify-self-center rounded", incoming ? "bg-success/12 text-success" : "bg-expense/10 text-expense")}>
                  <Icon className="size-3" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 py-1 pr-2 @min-[22rem]:contents">
                  <p className="truncate text-xs leading-4 font-semibold text-foreground @min-[22rem]:pr-2" title={txn.merchant}>{txn.merchant}</p>
                  <p className="truncate text-[11px] leading-3.5 text-muted-foreground @min-[22rem]:self-stretch @min-[22rem]:content-center @min-[22rem]:border-l @min-[22rem]:border-border-strong/35 @min-[22rem]:px-2" title={txn.category}>
                    {txn.category}
                  </p>
                </div>
                <p className="self-stretch content-center border-l border-border-strong/35 px-2 text-right text-[11px] leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
                  {txn.date}
                </p>
                <p className={cn("self-stretch content-center border-l border-border-strong/35 px-2 text-right text-xs leading-4 font-bold whitespace-nowrap tabular-nums", txn.historical ? "text-muted-foreground" : incoming ? "text-success" : "text-foreground")}>
                  {txn.historical ? "" : incoming ? "+" : "−"}
                  {formatCurrency(Math.abs(txn.amount))}
                </p>
                {txn.historical && (
                  <p className="col-start-2 col-end-[-1] pr-2 pb-1 text-[11px] leading-3.5 font-medium text-muted-foreground" title={historicalPaymentExplanation(incoming)}>
                    {HISTORICAL_PAYMENT_LABEL} · {HISTORICAL_PAYMENT_SHORT.toLowerCase()}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DashPanel>
  );
}
