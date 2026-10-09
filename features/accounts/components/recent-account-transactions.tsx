"use client";

import Link from "next/link";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Receipt } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { Skeleton } from "@/components/ui/skeleton";
import { useRecentAccountTransactions } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The latest transactions across accounts — a light list (in / out icon, description, account, when, amount);
 *  the row data is unchanged. */
export function RecentAccountTransactions() {
  const { rows, isLoading } = useRecentAccountTransactions();
  const reduceMotion = useReducedMotion();

  return (
    <section aria-label="Recent transactions" className="overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1">
      <div className="flex items-center justify-between gap-3 border-b border-border-strong/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/25 text-foreground dark:text-primary-accent-text">
            <Receipt className="size-4" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h2 className="font-heading text-base leading-tight font-semibold text-foreground">Recent transactions</h2>
            <p className="text-xs text-foreground/65">Across all your accounts</p>
          </div>
        </div>
        <Link
          href="/transactions"
          className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-border-strong/70 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          View all
          <ArrowRight className="size-3.5" strokeWidth={2} />
        </Link>
      </div>

      {isLoading ? (
        <div className="flex flex-col p-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-2.5">
              <Skeleton className="size-9 rounded-full" />
              <Skeleton className="h-4 max-w-48 flex-1" />
              <Skeleton className="ml-auto h-5 w-20" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-6">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground/60">
            <Receipt className="size-4" strokeWidth={2} />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">No transactions yet</p>
            <p className="text-xs text-foreground/70">Money in and out of your accounts will show up here.</p>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col p-2">
          {rows.map((txn, i) => {
            const incoming = txn.amount > 0;
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
            return (
              <motion.li
                key={txn.id}
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i, 10) * 0.035 }}
                className="flex items-center gap-3 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-secondary/60"
              >
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", incoming ? "bg-success/12 text-success" : "bg-expense/10 text-expense")}>
                  <Icon className="size-4" strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{txn.merchant}</p>
                  <p className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/70">
                    <span className="shrink-0 rounded-full bg-secondary px-1.5 py-px text-[10.5px] font-medium text-foreground/80">{txn.category}</span>
                    <span className="truncate">{txn.account}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{txn.timestamp}</span>
                  </p>
                </div>
                <span className={cn("shrink-0 text-[15px] font-bold whitespace-nowrap tabular-nums", incoming ? "text-success" : "text-foreground")}>
                  {incoming ? "+" : "−"}
                  {formatCurrency(Math.abs(txn.amount))}
                </span>
              </motion.li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
