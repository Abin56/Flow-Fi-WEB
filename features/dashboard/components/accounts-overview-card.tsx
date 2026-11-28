import Link from "next/link";
import { ChevronRight, Landmark, Wallet } from "lucide-react";
import { BankLogo } from "@/components/finance/bank-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_LABEL, DASH_ROW, DashEmpty, DashFooterLink, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import type { AccountPalette } from "@/features/accounts/lib/account-colors";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const ACCENTS = {
  primary: "bg-primary/20 text-foreground dark:text-primary-accent-text",
  warning: "bg-warning/20 text-warning-foreground dark:text-warning",
  success: "bg-success/12 text-success",
  info: "bg-royal/12 text-royal",
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
      palette?: AccountPalette;
    }[];
  };
  isLoading?: boolean;
}

/**
 * `accountsOverview` comes from real Accounts + `calculateNetWorth` via `useDashboardData`. The monthly change
 * isn't tracked yet (reported as 0), so it's only shown when non-zero. The account list scrolls inside the panel.
 */
export function AccountsOverviewCard({ accountsOverview, isLoading }: AccountsOverviewCardProps) {
  return (
    <DashPanel label="Accounts" className="h-auto">
      <DashPanelHeader icon={Wallet} title="Accounts" compact />
      {isLoading ? (
        <div className="flex flex-col gap-1.5 p-2">
          <Skeleton className="h-6 w-40" />
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full rounded" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2 border-b border-border-strong/35 bg-secondary/25 px-3 py-1.5">
            <p className={DASH_LABEL}>Total balance</p>
            <div className="text-right">
              <p className="text-base leading-5 font-bold tracking-tight text-foreground tabular-nums">{formatCurrency(accountsOverview.totalBalance)}</p>
              {accountsOverview.changeThisMonth !== 0 && (
                <p className={cn("text-xs font-semibold", accountsOverview.changeThisMonth > 0 ? "text-success" : "text-expense")}>
                  {accountsOverview.changeThisMonth > 0 ? "+" : ""}
                  {formatCurrency(accountsOverview.changeThisMonth)} this month
                </p>
              )}
            </div>
          </div>
          {accountsOverview.accounts.length === 0 ? (
            <DashEmpty
              title="No accounts yet"
              description="Add an account to see it here."
              compact
              action={
                <Link href="/accounts" className="text-xs font-semibold text-primary-accent-text hover:underline">
                  Add account
                </Link>
              }
            />
          ) : (
            <div className="max-h-44 divide-y divide-border-strong/35 overflow-y-auto">
              {accountsOverview.accounts.map((account) => {
                const Icon = account.mask ? Landmark : Wallet;
                return (
                  <Link key={account.id} href="/accounts" className={cn(DASH_ROW, "group min-h-9")}>
                    {account.bankId ? (
                      <BankLogo bankId={account.bankId} size={24} shape="square" />
                    ) : (
                      <span
                        className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", account.palette ? account.palette.onGradient : ACCENTS[account.accent])}
                        style={account.palette ? { background: account.palette.gradient } : undefined}
                      >
                        <Icon className="size-3" strokeWidth={1.9} />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs leading-4 font-semibold text-foreground">{account.name}</p>
                      {account.mask && <p className="text-[11px] leading-3.5 text-muted-foreground tabular-nums">•••• {account.mask}</p>}
                    </div>
                    <p className="shrink-0 text-xs font-bold text-foreground tabular-nums">{formatCurrency(account.balance)}</p>
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
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
