"use client";

import { ChevronRight, Landmark, Star, Wallet } from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function AccountMark({ account, size }: { account: AccountOverviewItem; size: number }) {
  const palette = ACCOUNT_COLOR[account.color];
  const Icon = account.mask ? Landmark : Wallet;
  return account.bankId ? (
    <BankLogo bankId={account.bankId} size={size} shape="square" className="shrink-0 shadow-sm" />
  ) : (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-[8px] shadow-sm", palette.onGradient)}
      style={{ background: palette.gradient, width: size, height: size }}
    >
      <Icon className="size-4" />
    </span>
  );
}

function PrimaryBadge() {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border border-success/30 bg-success/12 px-1.5 text-[10.5px] font-semibold text-success">
      <Star className="size-3 fill-current" aria-hidden />
      Primary
    </span>
  );
}

/**
 * One account. `variant="grid"` is a compact card with the account's colour as a top strip;
 * `variant="list"` is a ledger-style row (identity left, balance right). Selecting opens the overview.
 */
export function AccountTile({
  account,
  active,
  onSelect,
  variant = "grid",
}: {
  account: AccountOverviewItem;
  active: boolean;
  onSelect: () => void;
  variant?: "grid" | "list";
}) {
  const palette = ACCOUNT_COLOR[account.color];
  const subtitle = `${account.typeLabel}${account.mask ? ` •••• ${account.mask}` : ""}`;

  if (variant === "list") {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "group relative flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60",
          active && "bg-primary/10 hover:bg-primary/15",
        )}
      >
        <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full" style={{ background: palette.gradient }} aria-hidden />
        <AccountMark account={account} size={36} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{account.name}</span>
            {account.isPrimary && <PrimaryBadge />}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="text-[17px] leading-tight font-bold text-foreground tabular-nums">{formatCurrency(account.balance)}</span>
          <span className="text-[11px] text-muted-foreground">{account.balanceLabel}</span>
        </span>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5", active && "text-foreground")} strokeWidth={1.75} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "group @container relative flex flex-col gap-3 overflow-hidden rounded-[10px] border bg-card p-4 pt-5 text-left shadow-e1 outline-none transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-e2 focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary-accent-text ring-1 ring-primary-accent-text/40" : "border-border-strong/60 hover:border-border-strong",
      )}
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: palette.gradient }} aria-hidden />

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <AccountMark account={account} size={36} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{account.name}</h3>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {account.isPrimary && <PrimaryBadge />}
      </div>

      <div className="flex items-end justify-between gap-2 border-t border-border-strong/40 pt-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{account.balanceLabel}</p>
          <p className="mt-0.5 text-[18px] leading-tight font-bold tracking-tight text-foreground tabular-nums @[11rem]:text-[22px]">{formatCurrency(account.balance)}</p>
        </div>
        {account.cardStyle === "featured" && account.sparkline ? (
          <div className="h-9 w-24 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={account.sparkline.map((v) => ({ v }))}>
                <Line type="monotone" dataKey="v" stroke={palette.stroke} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <span className="hidden size-7 shrink-0 items-center justify-center rounded-full border border-border-strong/60 text-muted-foreground @[11rem]:flex transition-colors group-hover:border-border-strong group-hover:text-foreground">
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </span>
        )}
      </div>
    </button>
  );
}
