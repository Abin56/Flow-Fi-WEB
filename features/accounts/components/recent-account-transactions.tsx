import Link from "next/link";
import { ArrowDownLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useRecentAccountTransactions } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const TH =
  "border-r border-b border-r-border-strong/40 border-b-border-strong bg-secondary px-3 py-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase last:border-r-0";
const TD = "border-r border-b border-r-border-strong/30 border-b-border-strong/40 px-3 py-2.5 align-middle last:border-r-0";

/** The latest transactions across accounts — same ledger look as Transactions; the row data is unchanged. */
export function RecentAccountTransactions() {
  const { rows, isLoading } = useRecentAccountTransactions();

  return (
    <section aria-label="Recent transactions" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 border-b border-border-strong/50 pb-3">
        <h2 className="font-heading text-base font-semibold text-foreground">Recent transactions</h2>
        <Link
          href="/transactions"
          className="flex h-8 items-center gap-1 rounded-[6px] px-2 text-sm font-semibold text-primary-accent-text transition-colors hover:bg-primary/15"
        >
          View all
          <ArrowRight className="size-3.5" strokeWidth={2} />
        </Link>
      </div>

      <div className="@container overflow-hidden rounded-[10px] border border-border-strong/70 bg-card shadow-e1">
        {isLoading ? (
          <div className="flex flex-col">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="size-8 rounded-[8px]" />
                <Skeleton className="h-4 max-w-48 flex-1" />
                <Skeleton className="ml-auto h-5 w-20" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className={TH}>Description</th>
                <th className={cn(TH, "hidden w-28 @2xl:table-cell")}>Type</th>
                <th className={cn(TH, "hidden w-44 @4xl:table-cell")}>Account</th>
                <th className={cn(TH, "hidden w-32 @4xl:table-cell")}>When</th>
                <th className={cn(TH, "w-28 text-right @md:w-36")}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((txn) => {
                const incoming = txn.amount > 0;
                const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
                return (
                  <tr key={txn.id} className="transition-colors hover:bg-secondary/50 [&:last-child>td]:border-b-0">
                    <td className={cn(TD, "max-w-0")}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", incoming ? "bg-success/12 text-success" : "bg-expense/10 text-expense")}>
                          <Icon className="size-4" strokeWidth={1.75} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-foreground">{txn.merchant}</p>
                          <p className="truncate text-xs text-muted-foreground @4xl:hidden">
                            {txn.account} · {txn.timestamp}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className={cn(TD, "hidden text-xs font-medium text-foreground/85 @2xl:table-cell")}>{txn.category}</td>
                    <td className={cn(TD, "hidden truncate text-xs text-foreground/85 @4xl:table-cell")}>{txn.account}</td>
                    <td className={cn(TD, "hidden text-xs text-muted-foreground @4xl:table-cell")}>{txn.timestamp}</td>
                    <td className={cn(TD, "text-right")}>
                      <span className={cn("text-[17px] font-bold tracking-tight whitespace-nowrap tabular-nums", incoming ? "text-success" : "text-foreground")}>
                        {incoming ? "+" : "−"}
                        {formatCurrency(Math.abs(txn.amount))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
