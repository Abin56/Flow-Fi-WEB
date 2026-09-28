import { Bell, Coins, Landmark, Wallet } from "lucide-react";
import { useAccountsStats } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

/**
 * One summary panel (Loan & EMI style): Total balance leads; In banks and Cash on hand support it.
 * The change-vs-last-month and upcoming figures aren't computed yet (`useAccountsStats` reports 0 for
 * them), so they're shown as not tracked rather than as a real "0%" / "₹0".
 */
export function AccountsStats({ accountCount }: { accountCount?: number }) {
  const { stats } = useAccountsStats();

  return (
    <section aria-label="Summary" className="flex flex-col overflow-hidden rounded-[10px] border border-border-strong/60 bg-card shadow-e1 lg:flex-row lg:items-stretch">
      <div className="flex flex-col gap-1.5 bg-gradient-to-br from-primary/15 to-transparent px-5 py-4 sm:px-6 lg:min-w-80 lg:border-r lg:border-border-strong/50 dark:from-primary/10">
        <span className={cn(LABEL, "inline-flex items-center gap-1.5")}>
          <Wallet className="size-3.5 text-foreground" strokeWidth={1.75} />
          Total balance
        </span>
        <p className="text-[32px] leading-none font-bold tracking-tight text-foreground tabular-nums sm:text-[36px]">{formatCurrency(stats.totalBalance)}</p>
        {accountCount != null && (
          <p className="text-xs text-muted-foreground">
            Across <span className="font-semibold text-foreground">{accountCount}</span> {accountCount === 1 ? "account" : "accounts"}
          </p>
        )}
      </div>

      <div className="grid flex-1 grid-cols-1 border-t border-border-strong/50 sm:grid-cols-3 sm:divide-x sm:divide-border-strong/50 lg:border-t-0">
        <Figure icon={Landmark} tone="bg-success/12 text-success" label="In banks" value={formatCurrency(stats.totalInBanks)} />
        <Figure icon={Coins} tone="bg-warning/20 text-warning-foreground dark:text-warning" label="Cash on hand" value={formatCurrency(stats.cashOnHand)} />
        <Figure icon={Bell} tone="bg-purple/12 text-purple" label="Upcoming · 7 days" value={null} />
      </div>
    </section>
  );
}

function Figure({ icon: Icon, tone, label, value }: { icon: typeof Bell; tone: string; label: string; value: string | null }) {
  return (
    <div className="flex items-center gap-3 border-b border-border-strong/40 px-5 py-3.5 last:border-b-0 sm:border-b-0">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-[8px]", tone)}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className={LABEL}>{label}</p>
        {value != null ? (
          <p className="mt-0.5 text-lg leading-tight font-bold text-foreground tabular-nums">{value}</p>
        ) : (
          <p className="mt-0.5 text-sm font-medium text-muted-foreground">Not tracked yet</p>
        )}
      </div>
    </div>
  );
}
