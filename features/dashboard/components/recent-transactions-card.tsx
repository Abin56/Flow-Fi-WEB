import { ArrowDownToLine, Coffee, Film, Receipt, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/finance/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const CATEGORY_STYLE: Record<string, { icon: typeof Coffee; className: string }> = {
  "Food & Dining": { icon: Coffee, className: "bg-warning/25 text-warning-foreground" },
  Income: { icon: ArrowDownToLine, className: "bg-success/16 text-success" },
  Shopping: { icon: ShoppingBag, className: "bg-expense/12 text-expense" },
  Entertainment: { icon: Film, className: "bg-purple/14 text-purple" },
};

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
  if (isLoading) {
    return (
      <section className="surface-flat flex h-full flex-col gap-3 rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-40" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-xl" />
        ))}
      </section>
    );
  }

  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Recent Transactions</h2>
        <Link href="/transactions" className="text-xs font-semibold text-primary hover:underline">
          View All
        </Link>
      </div>

      {recentTransactions.length === 0 ? (
        <EmptyState icon={Receipt} title="No transactions yet" description="Your recent activity will show up here." className="flex-1" />
      ) : (
      <div className="mt-3 flex flex-1 flex-col gap-1">
        {recentTransactions.map((txn) => {
          const style = CATEGORY_STYLE[txn.category] ?? { icon: ShoppingBag, className: "bg-muted text-muted-foreground" };
          const Icon = style.icon;
          return (
            <div key={txn.id} className="flex items-center gap-3 rounded-xl px-1 py-2 transition-colors hover:bg-muted/50">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", style.className)}>
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{txn.merchant}</p>
                <p className="text-xs text-muted-foreground">{txn.category}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn("text-sm font-semibold tabular-nums", txn.amount > 0 ? "text-success" : "text-foreground")}>
                  {txn.amount > 0 ? "+" : "-"}
                  {formatCurrency(Math.abs(txn.amount))}
                </p>
                <p className="text-xs text-muted-foreground">{txn.date}</p>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
