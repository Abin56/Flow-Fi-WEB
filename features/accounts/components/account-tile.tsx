"use client";

import { ChevronRight, Landmark, MoreVertical, Star, Wallet } from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AccountTile({
  account,
  active,
  onSelect,
}: {
  account: AccountOverviewItem;
  active: boolean;
  onSelect: () => void;
}) {
  const palette = ACCOUNT_COLOR[account.color];
  const Icon = account.mask ? Landmark : Wallet;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "surface-flat flex flex-col gap-4 rounded-2xl border p-5 text-left transition-colors",
        palette.wash,
        active ? "border-primary/50" : "border-border/50 hover:border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn("flex size-10 items-center justify-center rounded-xl", palette.icon)}>
          <Icon className="size-4.5" />
        </span>
        {account.isPrimary ? (
          <span className="flex items-center gap-1 rounded-full bg-success/16 px-2.5 py-1 text-[11px] font-semibold text-success">
            <Star className="size-3 fill-current" />
            Primary
          </span>
        ) : (
          <MoreVertical className="size-4 text-muted-foreground/60" />
        )}
      </div>

      <div>
        <h3 className="truncate text-sm font-semibold text-foreground">{account.name}</h3>
        <p className="truncate text-xs text-muted-foreground">
          {account.typeLabel}
          {account.mask && ` •••• ${account.mask}`}
        </p>
      </div>

      <div>
        <p className="text-xl font-bold tabular-nums text-foreground">{formatCurrency(account.balance)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{account.balanceLabel}</p>
      </div>

      {account.cardStyle === "featured" && account.sparkline ? (
        <div className="relative -mx-1 -mb-1 h-10">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={account.sparkline.map((v) => ({ v }))}>
              <Line type="monotone" dataKey="v" stroke={palette.stroke} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <span className="absolute right-0 bottom-0 flex size-7 items-center justify-center rounded-full bg-card text-foreground/70 shadow-[var(--shadow-card)]">
            <ChevronRight className="size-3.5" />
          </span>
        </div>
      ) : (
        account.cardStyle === "compact" && (
          <span className="flex size-7 items-center justify-center self-end rounded-full bg-card text-foreground/70 shadow-[var(--shadow-card)]">
            <ChevronRight className="size-3.5" />
          </span>
        )
      )}
    </button>
  );
}
