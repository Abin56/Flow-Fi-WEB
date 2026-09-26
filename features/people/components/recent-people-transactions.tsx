"use client";

import { ArrowDownToLine, ArrowUpFromLine, Check, Receipt, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/finance/empty-state";
import { useRecentPeopleTransactions, usePeopleActions, type RecentPersonTransactionRow } from "@/features/people/hooks/use-people-data";
import { useExpenses } from "@/hooks/use-expenses";
import { isSplit, type Expense, type ExpenseParticipant } from "@/lib/models/expense";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

/**
 * Finds the split-expense participant a ledger row's Yet-to-Receive/Received toggle should act
 * on — only "gave" entries created by a split (linked to an Expense via `transactionRef`, with a
 * matching person-linked participant) are toggleable here; plain Borrowed/Repaid/Received Back/
 * Adjustment entries have no participant to flip and render without the control.
 */
function toggleTargetFor(
  row: RecentPersonTransactionRow,
  expenses: Expense[],
): { expense: Expense; participant: ExpenseParticipant } | null {
  if (row.transactionRef == null) return null;
  const expense = expenses.find((e) => e.transactionId === row.transactionRef);
  if (expense == null || !isSplit(expense)) return null;
  const participant = expense.participants.find((p) => p.personId === row.personId);
  if (participant == null) return null;
  return { expense, participant };
}

export function RecentPeopleTransactions({ onViewAll }: { onViewAll?: () => void }) {
  const { rows, isLoading } = useRecentPeopleTransactions(20);
  const peopleActions = usePeopleActions();
  const { data: expenses = [] } = useExpenses();

  return (
    <section className="surface-flat rounded-2xl border border-border/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Recent Transactions</h2>
        <button type="button" onClick={onViewAll} className="text-xs font-semibold text-primary-accent-text hover:underline">
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
        <div className="mt-3 flex max-h-105 flex-col divide-y divide-border/50 overflow-y-auto">
          {rows.map((txn) => {
            const received = txn.type === "received";
            const settled = txn.receivedStatus === "received";
            const pendingReceivable = txn.entryType === "gave" && !settled;
            const toggleTarget = toggleTargetFor(txn, expenses as Expense[]);
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
                {toggleTarget != null && (
                  <button
                    type="button"
                    aria-label={settled ? "Mark as yet to receive" : "Mark as received"}
                    title={settled ? "Mark as yet to receive" : "Mark as received"}
                    onClick={async () => {
                      if (peopleActions == null) return;
                      try {
                        await peopleActions.setParticipantReceivedStatus(
                          toggleTarget.expense,
                          toggleTarget.participant,
                          settled ? "yetToReceive" : "received",
                        );
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Couldn't update status");
                      }
                    }}
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted",
                      settled ? "text-warning-foreground" : "text-success",
                    )}
                  >
                    {settled ? <Undo2 className="size-4" /> : <Check className="size-4" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
