"use client";

import { AccountMark } from "@/components/finance/account-label";
import { previewFunds, type FundingAccount } from "@/lib/engines/payment-funding";
import { formatCurrency, formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";

const money = (v: number) => (Math.abs(v - Math.round(v)) < 0.005 ? formatCurrency(Math.round(v)) : formatCurrencyPrecise(v));

export type PaymentSourceAccount = FundingAccount & { name: string; bankId?: string | null; accountNumberLast4?: string | null };

/**
 * The paying account's effect, shown before the payment is saved: its recorded balance, the payment and the
 * balance after — the same `previewFunds` numbers the write layer re-checks. Compact, theme tokens only.
 *
 * `amount` is what leaves the account (include a fee charged to it). With no amount yet it shows the balance only.
 * Renders nothing without an account — the caller keeps the picker empty until the user chooses (never a silent default).
 */
export function PaymentSourceSummary({
  account,
  amount,
  paymentLabel = "Payment",
  className,
}: {
  account: PaymentSourceAccount | null | undefined;
  amount: number | null;
  paymentLabel?: string;
  className?: string;
}) {
  if (!account) return null;
  const hasAmount = amount != null && Number.isFinite(amount) && amount > 0;
  const preview = previewFunds(account, hasAmount ? amount : 0);
  const insufficient = hasAmount && preview.status === "insufficient";
  return (
    <div
      data-testid="payment-source-summary"
      className={cn("flex flex-col gap-1 rounded-[8px] border px-3 py-2 text-xs", insufficient ? "border-expense/50 bg-expense/5" : "border-border bg-secondary", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
          <AccountMark account={account} size={16} />
          <span className="truncate">{account.name}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">
          Balance <span className="font-semibold text-foreground tabular-nums">{money(preview.before)}</span>
        </span>
      </div>
      {hasAmount && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{paymentLabel}</span>
            <span className="font-semibold text-foreground tabular-nums">− {money(preview.amount)}</span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-1">
            <span className="font-medium text-foreground">After payment</span>
            <span className={cn("font-semibold tabular-nums", insufficient ? "text-expense" : "text-foreground")} data-testid="payment-source-after">
              {money(preview.after)}
            </span>
          </div>
        </>
      )}
      {insufficient && (
        <p role="alert" className="font-semibold text-expense" data-testid="payment-source-insufficient">
          Not enough balance — short by {money(preview.shortfall)}. Choose another account or lower the amount.
        </p>
      )}
      {!insufficient && hasAmount && preview.belowMinimum && <p className="text-muted-foreground">This leaves the account under its minimum balance.</p>}
    </div>
  );
}

/** True when the payment can't be funded from `account` — what disables the confirm action (the write re-checks it). */
export function isUnderfunded(account: FundingAccount | null | undefined, amount: number | null): boolean {
  return account != null && amount != null && amount > 0 && previewFunds(account, amount).status === "insufficient";
}
