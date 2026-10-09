"use client";

import { CreditCard, Landmark, Wallet } from "lucide-react";
import { BankLogo } from "@/components/finance/bank-logo";
import { cn } from "@/lib/utils";

/** The bits of an account (or anything account-like) needed to show it with its bank's logo. */
export interface AccountLabelSource {
  name: string;
  bankId?: string | null;
  type?: string | null;
}

/**
 * An account's bank logo — or, with no bank set, an icon for its type (cash/wallet, card, bank).
 * Presentation only: shared by every account picker and list so they all look the same.
 */
export function AccountMark({ account, size = 18, className }: { account: AccountLabelSource; size?: number; className?: string }) {
  if (account.bankId) return <BankLogo bankId={account.bankId} size={size} className={className} />;
  const Icon = account.type === "card" ? CreditCard : account.type === "bank" ? Landmark : Wallet;
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", className)}
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: size * 0.58, height: size * 0.58 }} strokeWidth={2} />
    </span>
  );
}

/** Logo + name on one line — drop-in for a bare `{account.name}` in a select item, row or chip. */
export function AccountLabel({
  account,
  size = 18,
  suffix,
  className,
}: {
  account: AccountLabelSource;
  size?: number;
  /** Extra text after the name, e.g. "•••• 7960". */
  suffix?: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <AccountMark account={account} size={size} />
      <span className="truncate">{account.name}</span>
      {suffix != null && <span className="shrink-0 text-muted-foreground">{suffix}</span>}
    </span>
  );
}
