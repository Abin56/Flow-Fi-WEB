"use client";

import Link from "next/link";
import { Bell, Check, ChevronRight, Copy, Download, EyeOff, Eye, Landmark, Pencil, Receipt, RefreshCcw, Trash2, TrendingUp, Wallet, X } from "lucide-react";
import { useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const SOON = "rounded-[4px] bg-secondary px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";

function DetailRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-semibold text-foreground">{value}</span>
        {copyable && (
          <button
            type="button"
            aria-label={`Copy ${label}`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                // clipboard unavailable — no-op
              }
            }}
            className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The selected account — identity card in the account's colour, its details, then actions. Edit and
 * Delete are the working ones; Statement / Hide and the insight shortcuts aren't built yet and say so.
 */
export function AccountOverviewPanel({
  account,
  onClose,
  onEdit,
  onDelete,
}: {
  account: AccountOverviewItem;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const palette = ACCOUNT_COLOR[account.color];
  const Icon = account.mask ? Landmark : Wallet;

  return (
    <aside className="flex h-fit w-full shrink-0 flex-col overflow-hidden rounded-[10px] border border-border-strong/60 bg-card shadow-e1 lg:sticky lg:top-0 lg:w-[22rem]">
      <div className="flex items-center justify-between border-b border-border-strong/50 px-4 py-3">
        <h2 className="font-heading text-[15px] font-semibold text-foreground">Account overview</h2>
        <button
          type="button"
          aria-label="Close account overview"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="p-4">
        {/* Identity card — the account's own colour */}
        <div className={cn("relative overflow-hidden rounded-[10px] p-4", palette.onGradient)} style={{ background: palette.gradient }}>
          <div className="flex items-center gap-2.5">
            {account.bankId ? (
              <BankLogo bankId={account.bankId} size={36} shape="square" />
            ) : (
              <span className="flex size-9 items-center justify-center rounded-[8px] bg-white/15">
                <Icon className="size-4.5" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{account.name}</p>
              <p className="truncate text-xs opacity-80">
                {account.typeLabel}
                {account.mask && ` •••• ${account.mask}`}
              </p>
            </div>
          </div>
          <p className="mt-4 text-[11px] font-semibold tracking-[0.06em] uppercase opacity-80">{account.balanceLabel}</p>
          <p className="text-[28px] leading-tight font-bold tracking-tight tabular-nums">{formatCurrency(account.balance)}</p>
          {account.sparkline && (
            <div className="mt-2 h-8">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={account.sparkline.map((v) => ({ v }))}>
                  <Line type="monotone" dataKey="v" stroke="white" strokeOpacity={0.85} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Working actions */}
        {(onEdit || onDelete) && (
          <div className="mt-3 flex gap-2">
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Pencil className="size-3.5" strokeWidth={2} />
                Edit account
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="flex h-9 items-center justify-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-sm font-medium text-foreground/80 transition-colors hover:border-expense/40 hover:bg-expense/10 hover:text-expense"
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
                Delete
              </button>
            )}
          </div>
        )}

        <p className={cn(LABEL, "mt-5")}>Account details</p>
        <div className="mt-1 divide-y divide-border-strong/40">
          <DetailRow label="Account holder" value={account.accountHolder} />
          {account.accountNumberMasked && (
            <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="text-muted-foreground">Account number</span>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-foreground tabular-nums">{revealed ? account.accountNumberMasked : `•••• ${account.mask}`}</span>
                <button
                  type="button"
                  aria-label={revealed ? "Hide account number" : "Reveal account number"}
                  onClick={() => setRevealed((v) => !v)}
                  className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
            </div>
          )}
          {account.ifsc && <DetailRow label="IFSC code" value={account.ifsc} copyable />}
          <DetailRow label="Account type" value={account.typeLabel} />
          {account.branch && <DetailRow label="Branch" value={account.branch} />}
          {account.upiId && <DetailRow label="UPI ID" value={account.upiId} copyable />}
          {account.linkedSince && <DetailRow label="Linked since" value={account.linkedSince} />}
        </div>

        <p className={cn(LABEL, "mt-5")}>More</p>
        <div className="mt-1 flex flex-col">
          <Link href="/transactions" className="flex items-center gap-3 rounded-[6px] px-1 py-2 text-sm transition-colors hover:bg-secondary">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-primary/20 text-foreground dark:text-primary-accent-text">
              <Receipt className="size-3.5" />
            </span>
            <span className="flex-1 font-medium text-foreground">View transactions</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
          {(
            [
              { icon: Download, label: "Download statement" },
              { icon: TrendingUp, label: "Account insights" },
              { icon: Bell, label: "Balance alert" },
              { icon: RefreshCcw, label: "Reconcile" },
              { icon: EyeOff, label: "Hide account" },
            ] as const
          ).map((item) => (
            <div key={item.label} className="flex items-center gap-3 px-1 py-2 text-sm text-muted-foreground" title="Coming soon">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-secondary">
                <item.icon className="size-3.5" />
              </span>
              <span className="flex-1">{item.label}</span>
              <span className={SOON}>Soon</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
