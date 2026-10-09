"use client";

import { ChevronRight, Landmark, Star, Wallet } from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { motion, useReducedMotion } from "framer-motion";
import { StaggerItem } from "@/components/foundation/animated-container";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function AccountMark({ account, size }: { account: AccountOverviewItem; size: number }) {
  const palette = ACCOUNT_COLOR[account.color];
  const Icon = account.mask ? Landmark : Wallet;
  return account.bankId ? (
    <BankLogo bankId={account.bankId} size={size} className="shrink-0 shadow-sm" />
  ) : (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-full shadow-sm", palette.onGradient)}
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
  const reduceMotion = useReducedMotion();
  const Icon = account.mask ? Landmark : Wallet;

  if (variant === "list") {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "group relative flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60",
          active && "bg-gradient-to-r from-primary/25 via-primary/10 to-transparent hover:from-primary/30",
        )}
      >
        <span className={cn("absolute inset-y-2 left-0 rounded-r-full transition-all", active ? "w-1" : "w-[3px] opacity-70")} style={{ background: palette.gradient }} aria-hidden />
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
          <span className="text-[11px] text-foreground/60">{account.balanceLabel}</span>
        </span>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5", active && "text-foreground")} strokeWidth={1.75} />
      </button>
    );
  }

  return (
    <StaggerItem className="h-full">
      <motion.button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        whileHover={reduceMotion ? undefined : { y: -3 }}
        whileTap={reduceMotion ? undefined : { scale: 0.985 }}
        transition={{ type: "spring", stiffness: 320, damping: 24 }}
        className={cn(
          "group @container relative flex h-full w-full flex-col overflow-hidden rounded-[14px] border bg-card text-left shadow-e1 outline-none transition-[border-color,box-shadow] duration-200 hover:shadow-[0_14px_32px_-14px_rgba(0,0,0,0.35)] focus-visible:ring-2 focus-visible:ring-ring",
          active ? "border-primary-accent-text ring-2 ring-primary-accent-text/35" : "border-border-strong/60 hover:border-border-strong",
        )}
      >
        {/* Colour band — the account's own colour, with its logo and name on it */}
        <div className={cn("relative flex items-center gap-2.5 overflow-hidden px-4 pt-4 pb-3.5", palette.onGradient)} style={{ background: palette.gradient }}>
          <span aria-hidden className="pointer-events-none absolute -top-12 -right-8 size-32 rounded-full bg-white/15 blur-2xl" />
          <span aria-hidden className="pointer-events-none absolute -bottom-16 -left-10 size-32 rounded-full border border-white/10" />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent opacity-0 group-hover:animate-[cc-shine_0.9s_ease-out] motion-reduce:hidden"
          />
          {account.bankId ? (
            <BankLogo bankId={account.bankId} size={34} className="relative shrink-0 shadow-sm ring-2 ring-white/40" />
          ) : (
            <span className="relative flex size-[34px] shrink-0 items-center justify-center rounded-full bg-white/20 ring-1 ring-white/30">
              <Icon className="size-4" />
            </span>
          )}
          <div className="relative min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">{account.name}</h3>
            <p className="truncate text-xs opacity-85">{subtitle}</p>
          </div>
          {account.isPrimary && (
            <span className="relative inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-white/25 px-2 text-[10.5px] font-semibold backdrop-blur-sm">
              <Star className="size-3 fill-current" aria-hidden />
              Primary
            </span>
          )}
        </div>

        {/* Balance */}
        <div className="flex flex-1 items-end justify-between gap-3 px-4 pt-3 pb-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.06em] text-foreground/65 uppercase">{account.balanceLabel}</p>
            <p className="mt-0.5 text-[20px] leading-tight font-bold tracking-tight text-foreground tabular-nums @[13rem]:text-[24px]">{formatCurrency(account.balance)}</p>
          </div>
          {account.sparkline ? (
            <div className="h-10 w-24 shrink-0 opacity-90">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={account.sparkline.map((v) => ({ v }))}>
                  <Line type="monotone" dataKey="v" stroke={palette.stroke} strokeWidth={2.25} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong/60 text-foreground/60 transition-colors group-hover:border-border-strong group-hover:bg-secondary group-hover:text-foreground">
              <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
            </span>
          )}
        </div>
      </motion.button>
    </StaggerItem>
  );
}
