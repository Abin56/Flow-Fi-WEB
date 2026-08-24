"use client";

import { ArrowDownToLine, ArrowUpFromLine, MoreHorizontal, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/finance/empty-state";
import { useRecentPeopleTransactions } from "@/features/people/hooks/use-people-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export function RecentPeopleTransactions() {
  const { rows, isLoading } = useRecentPeopleTransactions();

  return (
    <section className="surface-flat rounded-2xl border border-border/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Recent Transactions</h2>
        <button type="button" className="text-xs font-semibold text-primary hover:underline">
          View All
        </button>
      </div>

      {isLoading ? (
        <div className="mt-3 flex flex-col divide-y divide-border/50">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 py-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-1 h-3 w-24" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-3">
          <EmptyState icon={Receipt} title="No transactions yet" description="Ledger activity across all people will show up here." />
        </div>
      ) : (
        <div className="mt-3 flex flex-col divide-y divide-border/50">
          {rows.map((txn) => {
            const received = txn.type === "received";
            return (
              <div key={txn.id} className="flex flex-wrap items-center gap-3 py-3">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full",
                    received ? "bg-success/16 text-success" : "bg-expense/12 text-expense",
                  )}
                >
                  {received ? <ArrowDownToLine className="size-4" /> : <ArrowUpFromLine className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {received ? `Received from ${txn.personName}` : `Paid to ${txn.personName}`}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{txn.description}</p>
                </div>
                <span className="hidden text-xs text-muted-foreground sm:block">{txn.date}</span>
                <Badge variant="secondary" className="hidden border-0 text-[10px] sm:inline-flex">
                  {txn.category}
                </Badge>
                <p className={cn("w-24 shrink-0 text-right text-sm font-semibold tabular-nums", received ? "text-success" : "text-expense")}>
                  {received ? "+" : "-"}
                  {formatCurrency(txn.amount)}
                </p>
                <button
                  type="button"
                  aria-label="More actions"
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
