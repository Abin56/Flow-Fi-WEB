"use client";

import { ArrowDownToLine, ArrowUpFromLine, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/finance/empty-state";
import { useRecentPeopleTransactions } from "@/features/people/hooks/use-people-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

interface AllPeopleTransactionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "View All" popup for the People page's Recent Transactions list — same row layout, unbounded. */
export function AllPeopleTransactionsDialog({ open, onOpenChange }: AllPeopleTransactionsDialogProps) {
  const { rows, isLoading } = useRecentPeopleTransactions(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>All Transactions</DialogTitle>
          <DialogDescription>Every ledger entry across all people, most recent first.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex flex-col divide-y divide-border/50">
              {Array.from({ length: 5 }, (_, i) => (
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
            <EmptyState icon={Receipt} title="No transactions yet" description="Ledger activity across all people will show up here." />
          ) : (
            <div className="flex flex-col divide-y divide-border/50">
              {rows.map((txn) => {
                const received = txn.type === "received";
                const settled = txn.receivedStatus === "received";
                const pendingReceivable = txn.entryType === "gave" && !settled;
                return (
                  <div key={txn.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-full",
                        pendingReceivable ? "bg-warning/16 text-warning-foreground" : received ? "bg-success/16 text-success" : "bg-expense/12 text-expense",
                      )}
                    >
                      {received ? <ArrowDownToLine className="size-4" /> : <ArrowUpFromLine className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {pendingReceivable
                          ? `Yet to receive from ${txn.personName}`
                          : received
                            ? `Received from ${txn.personName}`
                            : `Paid to ${txn.personName}`}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{txn.description}</p>
                    </div>
                    <span className="hidden text-xs text-muted-foreground sm:block">{txn.date}</span>
                    <Badge variant="secondary" className="hidden border-0 text-[10px] sm:inline-flex">
                      {txn.category}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={cn("hidden border-0 text-[10px] sm:inline-flex", settled ? "bg-success/16 text-success" : "bg-warning/25 text-warning-foreground")}
                    >
                      {settled ? "Received" : "Pending"}
                    </Badge>
                    <p className={cn("w-24 shrink-0 text-right text-sm font-semibold tabular-nums", received ? "text-success" : "text-expense")}>
                      {received ? "+" : "-"}
                      {formatCurrency(txn.amount)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
