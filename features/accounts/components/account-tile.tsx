"use client";

import { ChevronRight, CreditCard, Landmark, Receipt, Star, Wallet } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { StaggerItem } from "@/components/foundation/animated-container";
import { transactionsHrefForAccount } from "@/features/transactions/lib/account-filter-param";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import visuals from "./accounts-visuals.module.css";

function AccountMark({ account, creditCard }: { account: AccountOverviewItem; creditCard: boolean }) {
  const Icon = creditCard ? CreditCard : account.mask ? Landmark : Wallet;
  return account.bankId ? (
    <BankLogo bankId={account.bankId} size={32} className="shrink-0 ring-1 ring-border/70" />
  ) : (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground", visuals.mark)}>
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

function PrimaryBadge() {
  return (
    <span className="inline-flex h-4 shrink-0 items-center gap-1 rounded-sm bg-secondary px-1 text-[10px] font-semibold text-muted-foreground">
      <Star className="size-3 fill-current" aria-hidden />
      Primary
    </span>
  );
}

const TILE_ACTION = "inline-flex min-h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors";

/**
 * One account. `variant="grid"` uses the account's saved colour as an accent;
 * `variant="list"` is a ledger-style row (identity left, balance right). Selecting opens the overview.
 */
export function AccountTile({
  account,
  active,
  onSelect,
  onExplain,
  onNavigateToTransactions,
  creditCard = false,
  variant = "grid",
}: {
  account: AccountOverviewItem;
  active: boolean;
  onSelect: () => void;
  /** Opens the balance breakdown for this account (a sibling control — a button can't nest in the tile button). */
  onExplain?: () => void;
  onNavigateToTransactions?: () => void;
  creditCard?: boolean;
  variant?: "grid" | "list";
}) {
  const palette = account.palette;
  const accent = { "--account-accent": palette.stroke } as CSSProperties;
  const typeLabel = creditCard ? "Credit card" : account.typeLabel;
  const nameIncludesType = account.name.trimEnd().toLowerCase().endsWith(typeLabel.toLowerCase());
  const subtitle = [nameIncludesType ? "" : typeLabel, account.mask && `•••• ${account.mask}`].filter(Boolean).join(" ");
  const balance = creditCard ? Math.max(0, -account.balance) : account.balance;
  const balanceLabel = creditCard ? "Outstanding" : account.balanceLabel;
  const balanceColor = creditCard && balance > 0 ? "text-expense" : "text-foreground";
  const actionLabel = variant === "list" ? "@[25rem]:sr-only @[31rem]:not-sr-only" : undefined;
  const actions = (
    <>
      <Link
        href={transactionsHrefForAccount(account.id)}
        prefetch={false}
        onNavigate={onNavigateToTransactions}
        aria-label={`View ${account.name} transactions`}
        title="View transactions"
        className={cn(TILE_ACTION, "text-foreground")}
      >
        <Receipt className="size-3.5 shrink-0" aria-hidden />
        <span className={actionLabel}>Transactions</span>
      </Link>
      {onExplain && (
        <button
          type="button"
          onClick={onExplain}
          aria-label={`View ${account.name} balance breakdown`}
          title="View balance breakdown"
          className={TILE_ACTION}
        >
          <span>Breakdown</span>
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        </button>
      )}
    </>
  );

  if (variant === "list") {
    return (
      <div className={cn("flex flex-col motion-safe:transition-colors @[25rem]:flex-row @[25rem]:items-center", active && "bg-primary/8")} style={accent}>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          className="group relative flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-safe:transition-colors"
        >
          <span className={cn("absolute inset-y-2 left-0 w-0.5 rounded-r-full motion-safe:transition-opacity", active ? "opacity-100" : "opacity-45")} style={{ backgroundColor: palette.stroke }} aria-hidden />
          <AccountMark account={account} creditCard={creditCard} />
          <span className="min-w-0 flex-1">
            <span className="block wrap-anywhere text-sm leading-snug font-semibold text-foreground">{account.name}</span>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 empty:hidden">
              {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
              {account.isPrimary && <PrimaryBadge />}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <span className={cn("text-base leading-tight font-bold tabular-nums", balanceColor)}>{formatCurrency(balance)}</span>
            <span className="text-[11px] text-muted-foreground">{balanceLabel}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" aria-hidden />
        </button>
        <div className="flex shrink-0 items-center gap-1 px-3 pb-1 @[25rem]:border-l @[25rem]:border-border @[25rem]:px-2 @[25rem]:pb-0">
          {actions}
        </div>
      </div>
    );
  }

  return (
    <StaggerItem className="h-full min-w-0">
      <div
        className={cn(
          "flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-e1 hover:shadow-e2",
          visuals.tile,
          active ? "border-primary-accent-text/65 ring-1 ring-primary-accent-text/15" : "border-border-strong/60 hover:border-border-strong",
        )}
        style={accent}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          className="group relative flex min-w-0 flex-1 flex-col gap-2.5 px-3.5 pt-3 pb-2.5 text-left outline-none hover:bg-secondary/35 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-safe:transition-colors"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AccountMark account={account} creditCard={creditCard} />
            <div className="min-w-0 flex-1">
              <h3 className="wrap-anywhere text-sm leading-snug font-semibold">{account.name}</h3>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 empty:hidden">
                {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
                {account.isPrimary && <PrimaryBadge />}
              </div>
            </div>
          </div>

          {/* Balance */}
          <div className="flex flex-1 items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">{balanceLabel}</p>
              <p className={cn("wrap-anywhere text-xl leading-tight font-bold tracking-tight tabular-nums", balanceColor)}>{formatCurrency(balance)}</p>
            </div>
            {account.sparkline ? (
              <div className="h-7 w-14 shrink-0 opacity-90">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={account.sparkline.map((v) => ({ v }))}>
                    <Line type="monotone" dataKey="v" stroke={palette.stroke} strokeWidth={2.25} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <ChevronRight className="mb-0.5 size-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" aria-hidden />
            )}
          </div>
        </button>
        <div className="flex flex-wrap items-center justify-between gap-x-1 border-t border-border px-2">
          {actions}
        </div>
      </div>
    </StaggerItem>
  );
}
