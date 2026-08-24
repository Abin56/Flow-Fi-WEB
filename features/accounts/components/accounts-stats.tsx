import { ArrowDown, ArrowUp, Bell, Coins, Landmark, Wallet } from "lucide-react";
import { useAccountsStats } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AccountsStats() {
  const { stats: accountStats } = useAccountsStats();

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="surface-flat rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Total Balance</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-expense/12 text-expense">
            <Wallet className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(accountStats.totalBalance)}</p>
        <ChangeLine percent={accountStats.totalBalanceChangePercent} />
      </div>

      <div className="surface-flat rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Total in Banks</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-success/16 text-success">
            <Landmark className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(accountStats.totalInBanks)}</p>
        <ChangeLine percent={accountStats.totalInBanksChangePercent} />
      </div>

      <div className="rounded-2xl border border-border/50 bg-warning/8 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Cash on Hand</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-warning/25 text-warning-foreground">
            <Coins className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(accountStats.cashOnHand)}</p>
        <ChangeLine percent={accountStats.cashOnHandChangePercent} />
      </div>

      <div className="surface-flat rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between">
          <p className="text-xs font-medium text-muted-foreground">Upcoming in 7 days</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-purple/14 text-purple">
            <Bell className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(accountStats.upcoming7Days)}</p>
        <p className="mt-1 text-xs font-medium text-purple">{accountStats.upcomingReminders} reminders</p>
      </div>
    </div>
  );
}

function ChangeLine({ percent }: { percent: number }) {
  const up = percent >= 0;
  return (
    <p className={cn("mt-1 flex items-center gap-1 text-xs font-medium", up ? "text-success" : "text-expense")}>
      {up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
      {Math.abs(percent)}% vs last month
    </p>
  );
}
