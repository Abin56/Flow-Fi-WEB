"use client";

import Link from "next/link";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useRecentAccountTransactions } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const DETAIL_COLUMN = "hidden border-l border-border/70 px-2.5 @[35rem]:table-cell";

/** The latest transactions across accounts, in a compact ledger. */
export function RecentAccountTransactions() {
  const { rows, isLoading } = useRecentAccountTransactions();

  return (
    <section aria-label="Recent transactions" className="@container overflow-hidden rounded-xl border border-border-strong/60 bg-card shadow-e1">
      <div className="flex items-center justify-between gap-2 border-b border-border-strong/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/20 text-foreground dark:text-primary-accent-text">
            <Receipt className="size-3.5" strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="font-heading text-sm leading-tight font-semibold text-foreground">Recent transactions</h2>
            <p className="text-xs text-muted-foreground">Across all your accounts</p>
          </div>
        </div>
        <Link
          href="/transactions"
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
        >
          View all
          <ArrowRight className="size-3.5" strokeWidth={2} />
        </Link>
      </div>

      {isLoading ? (
        <div className="flex flex-col">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-4 max-w-48 flex-1" />
              <Skeleton className="ml-auto h-5 w-20" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground/60">
            <Receipt className="size-4" strokeWidth={2} />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">No transactions yet</p>
            <p className="text-xs text-foreground/70">Money in and out of your accounts will show up here.</p>
          </div>
        </div>
      ) : (
        <table aria-label="Recent transactions" className="w-full table-fixed text-left text-xs">
          <thead className="border-b border-border bg-secondary/65 text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-1.5 font-semibold">Description</th>
              <th scope="col" className={cn(DETAIL_COLUMN, "w-[23%] font-semibold")}>Account</th>
              <th scope="col" className={cn(DETAIL_COLUMN, "w-[14%] font-semibold")}>Type</th>
              <th scope="col" className={cn(DETAIL_COLUMN, "w-32 font-semibold")}>Date</th>
              <th scope="col" className="w-[7.5rem] border-l border-border/70 px-2 text-right font-semibold @[35rem]:w-28 @[35rem]:px-3">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map((txn) => {
              const incoming = txn.amount > 0;
              const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
              const details = `${txn.account} · ${txn.category}`;
              return (
                <tr key={txn.id} className="even:bg-secondary/25 hover:bg-secondary/55">
                  <td className="px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Icon className={cn("size-3.5 shrink-0", incoming ? "text-success" : "text-expense")} strokeWidth={2} aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground" title={txn.merchant}>{txn.merchant}</p>
                        <p className="truncate text-[11px] text-muted-foreground @[35rem]:hidden" title={details}>{details}</p>
                      </div>
                    </div>
                  </td>
                  <td className={cn(DETAIL_COLUMN, "truncate text-muted-foreground")} title={txn.account}>{txn.account}</td>
                  <td className={cn(DETAIL_COLUMN, "truncate text-muted-foreground")} title={txn.category}>{txn.category}</td>
                  <td className={cn(DETAIL_COLUMN, "truncate text-muted-foreground tabular-nums")} title={txn.timestamp}>{txn.timestamp}</td>
                  <td className="border-l border-border/70 px-2 text-right tabular-nums @[35rem]:px-3">
                    <p className={cn("wrap-anywhere font-semibold", incoming ? "text-success" : "text-foreground")}>
                      {incoming ? "+" : "−"}
                      {formatCurrency(Math.abs(txn.amount))}
                    </p>
                    <p className="text-[11px] leading-tight text-muted-foreground @[35rem]:hidden">{txn.timestamp}</p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
