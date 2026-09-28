import Link from "next/link";
import { ChevronRight, Landmark, Wallet } from "lucide-react";
import { BankLogo } from "@/components/finance/bank-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DashEmpty, DashFooterLink, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const ACCENTS = {
  primary: "bg-primary/20 text-foreground dark:text-primary-accent-text",
  warning: "bg-warning/20 text-warning-foreground dark:text-warning",
  success: "bg-success/12 text-success",
  info: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
} as const;

export interface AccountsOverviewCardProps {
  accountsOverview: {
    totalBalance: number;
    changeThisMonth: number;
    accounts: {
      id: string;
      name: string;
      bankId: string | null;
      mask: string | null;
      balance: number;
      accent: keyof typeof ACCENTS;
    }[];
  };
  isLoading?: boolean;
}

/**
 * `accountsOverview` comes from real Accounts + `calculateNetWorth` via `useDashboardData`. The monthly change
 * isn't tracked yet (reported as 0), so it's only shown when non-zero.
 */
export function AccountsOverviewCard({ accountsOverview, isLoading }: AccountsOverviewCardProps) {
  return (
    <DashPanel label="Accounts">
      <DashPanelHeader icon={Wallet} title="Accounts" />
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-8 w-40" />
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-[6px]" />
          ))}
        </div>
      ) : (
        <>
          <div className="border-b border-border-strong/40 px-4 py-3">
            <p className={DASH_LABEL}>Total balance</p>
            <p className="text-[26px] leading-tight font-bold tracking-tight text-foreground tabular-nums">{formatCurrency(accountsOverview.totalBalance)}</p>
            {accountsOverview.changeThisMonth !== 0 && (
              <p className={cn("text-xs font-semibold", accountsOverview.changeThisMonth > 0 ? "text-success" : "text-expense")}>
                {accountsOverview.changeThisMonth > 0 ? "+" : ""}
                {formatCurrency(accountsOverview.changeThisMonth)} this month
              </p>
            )}
          </div>
          {accountsOverview.accounts.length === 0 ? (
            <DashEmpty
              title="No accounts yet"
              description="Add an account to see it here."
              action={
                <Link href="/accounts" className="text-xs font-semibold text-primary-accent-text hover:underline">
                  Add account
                </Link>
              }
            />
          ) : (
            <div className="divide-y divide-border-strong/40">
              {accountsOverview.accounts.map((account) => {
                const Icon = account.mask ? Landmark : Wallet;
                return (
                  <Link key={account.id} href="/accounts" className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/50">
                    {account.bankId ? (
                      <BankLogo bankId={account.bankId} size={32} shape="square" />
                    ) : (
                      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", ACCENTS[account.accent])}>
                        <Icon className="size-4" strokeWidth={1.75} />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{account.name}</p>
                      {account.mask && <p className="text-xs text-muted-foreground tabular-nums">•••• {account.mask}</p>}
                    </div>
                    <p className="shrink-0 text-[15px] font-bold text-foreground tabular-nums">{formatCurrency(account.balance)}</p>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                );
              })}
            </div>
          )}
          <DashFooterLink href="/accounts">All accounts</DashFooterLink>
        </>
      )}
    </DashPanel>
  );
}
