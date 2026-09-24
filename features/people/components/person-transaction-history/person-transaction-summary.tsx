import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PersonTransactionSummaryProps {
  transactionsCount: number;
  youAreOwed: number;
  youOwe: number;
}

/**
 * Compact 3-up summary strip — reuses exactly the numbers `PersonOverviewPanel` already showed
 * (`youAreOwed`/`youOwe`/`transactionsCount` off `PersonViewRow`), just laid out with more room to
 * breathe than the panel's cramped `w-80` grid. No new calculations.
 */
export function PersonTransactionSummary({ transactionsCount, youAreOwed, youOwe }: PersonTransactionSummaryProps) {
  const net = youAreOwed - youOwe;
  const isOwedToYou = net >= 0;

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="rounded-xl border border-border px-3 py-2.5">
        <p className="text-xs text-muted-foreground">Transactions</p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{transactionsCount}</p>
      </div>
      <div className="rounded-xl border border-border px-3 py-2.5">
        <p className="text-xs text-muted-foreground">{isOwedToYou ? "You are owed" : "You owe"}</p>
        <p className={cn("mt-0.5 text-lg font-semibold tabular-nums", isOwedToYou ? "text-success" : "text-expense")}>
          {isOwedToYou ? "+" : "-"}
          {formatCurrency(Math.abs(net))}
        </p>
      </div>
      <div className="rounded-xl border border-border px-3 py-2.5">
        <p className="text-xs text-muted-foreground">Received / Paid</p>
        <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-foreground">
          <span className="text-success">{formatCurrency(youAreOwed)}</span>
          {" / "}
          <span className="text-expense">{formatCurrency(youOwe)}</span>
        </p>
      </div>
    </div>
  );
}
