import { ArrowLeftRight, Coffee, ShoppingBag, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useRecentAccountTransactions } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const CATEGORY_STYLE: Record<string, { icon: typeof Coffee; className: string }> = {
  "Food & Dining": { icon: Coffee, className: "bg-warning/25 text-warning-foreground" },
  Income: { icon: TrendingUp, className: "bg-success/16 text-success" },
  Shopping: { icon: ShoppingBag, className: "bg-expense/12 text-expense" },
  Transfer: { icon: ArrowLeftRight, className: "bg-purple/14 text-purple" },
};

export function RecentAccountTransactions() {
  const { rows: recentAccountTransactions, isLoading } = useRecentAccountTransactions();

  return (
    <section className="surface-flat rounded-2xl border border-border/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Recent Transactions</h2>
        <button type="button" className="text-xs font-semibold text-primary hover:underline">
          View All
        </button>
      </div>

      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading transactions…</p>
      ) : recentAccountTransactions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No transactions yet.</p>
      ) : (
      <div className="mt-3 flex flex-col divide-y divide-border/50">
        {recentAccountTransactions.map((txn) => {
          const style = CATEGORY_STYLE[txn.category] ?? { icon: ShoppingBag, className: "bg-muted text-muted-foreground" };
          const Icon = style.icon;
          return (
            <div key={txn.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", style.className)}>
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{txn.merchant}</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <Badge variant="secondary" className="border-0 text-[10px]">
                    {txn.category}
                  </Badge>
                  <span className="truncate text-xs text-muted-foreground">{txn.account}</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn("text-sm font-semibold tabular-nums", txn.amount > 0 ? "text-success" : "text-foreground")}>
                  {txn.amount > 0 ? "+" : "-"}
                  {formatCurrency(Math.abs(txn.amount))}
                </p>
                <p className="text-xs text-muted-foreground">{txn.timestamp}</p>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
