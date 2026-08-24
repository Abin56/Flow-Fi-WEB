"use client";

import { ArrowDownToLine, ArrowUpFromLine, Handshake, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePeopleStats } from "@/features/people/hooks/use-people-data";
import { formatCurrency } from "@/lib/format";

export function PeopleStats() {
  const { stats, isLoading } = usePeopleStats();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="surface-flat rounded-2xl border border-border/50 p-5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-3 h-7 w-32" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="surface-flat rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Total You Are Owed</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-success/16 text-success">
            <ArrowDownToLine className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(stats.totalYouAreOwed)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Across {stats.owedByPeopleCount} people</p>
      </div>

      <div className="surface-flat rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Total You Owe</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-expense/12 text-expense">
            <ArrowUpFromLine className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(stats.totalYouOwe)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Across {stats.owingPeopleCount} people</p>
      </div>

      <div className="surface-flat rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Net Balance</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-purple/14 text-purple">
            <Users className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(stats.netBalance)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{stats.netBalance >= 0 ? "You are in credit" : "You are in debt"}</p>
      </div>

      <div className="surface-flat rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Settled This Month</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-warning/25 text-warning-foreground">
            <Handshake className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(stats.settledThisMonth)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Across {stats.settledTransactionsCount} transactions</p>
      </div>
    </div>
  );
}
