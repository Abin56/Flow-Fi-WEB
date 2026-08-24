import { ChevronRight, Landmark, Wallet } from "lucide-react";
import { EmptyState } from "@/components/finance/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const ACCENTS = {
  primary: "bg-primary/12 text-primary",
  warning: "bg-warning/25 text-warning-foreground",
  success: "bg-success/16 text-success",
  info: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
} as const;

export interface AccountsOverviewCardProps {
  accountsOverview: {
    totalBalance: number;
    changeThisMonth: number;
    accounts: {
      id: string;
      name: string;
      mask: string | null;
      balance: number;
      accent: keyof typeof ACCENTS;
    }[];
  };
  isLoading?: boolean;
}

/** `accountsOverview` comes from real Accounts + `calculateNetWorth` (lib/engines/net-worth.ts) via `useDashboardData`. */
export function AccountsOverviewCard({ accountsOverview, isLoading }: AccountsOverviewCardProps) {
  if (isLoading) {
    return (
      <section className="surface-flat flex h-full flex-col gap-4 rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-7 w-40" />
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-xl" />
        ))}
      </section>
    );
  }

  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <h2 className="text-sm font-semibold text-foreground">Accounts Overview</h2>

      <div className="mt-3">
        <p className="text-xs text-muted-foreground">Total Balance</p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(accountsOverview.totalBalance)}</p>
        <p className="mt-1 text-xs font-medium text-success">
          +{formatCurrency(accountsOverview.changeThisMonth)} this month
        </p>
      </div>

      {accountsOverview.accounts.length === 0 ? (
        <EmptyState icon={Wallet} title="No accounts yet" description="Add an account to see it here." className="flex-1" />
      ) : (
        <div className="mt-4 flex flex-1 flex-col gap-1">
          {accountsOverview.accounts.map((account) => {
            const Icon = account.mask ? Landmark : Wallet;
            return (
              <div key={account.id} className="flex items-center gap-3 rounded-xl px-1 py-2 transition-colors hover:bg-muted/50">
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", ACCENTS[account.accent])}>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{account.name}</p>
                  {account.mask && <p className="text-xs text-muted-foreground">•••• {account.mask}</p>}
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{formatCurrency(account.balance)}</p>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className="mt-4 rounded-xl bg-muted/70 py-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
      >
        View All Accounts
      </button>
    </section>
  );
}
