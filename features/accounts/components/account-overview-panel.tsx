"use client";

import {
  Bell,
  Check,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Landmark,
  Pencil,
  Receipt,
  RefreshCcw,
  Settings,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { formatCurrency } from "@/lib/format";
import { accountQuickActions, accountShortcuts } from "@/lib/mock/accounts-overview-data";

const QUICK_ACTION_ICON = { statement: Download, manage: Settings, rename: Pencil, hide: EyeOff } as const;
const SHORTCUT_ICON = { transactions: Receipt, insights: TrendingUp, alert: Bell, reconcile: RefreshCcw } as const;

function DetailRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-foreground">{value}</span>
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
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

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
    <aside className="surface-flat flex h-fit w-full shrink-0 flex-col rounded-2xl border border-border/50 p-5 lg:w-80">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Account Overview</h2>
        <button
          type="button"
          aria-label="Close account overview"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="relative mt-4 overflow-hidden rounded-2xl p-4 text-white" style={{ background: palette.gradient }}>
        <div className="flex items-center gap-2.5">
          {account.bankId ? (
            <BankLogo bankId={account.bankId} size={36} shape="square" />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-xl bg-white/15">
              <Icon className="size-4.5" />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{account.name}</p>
            <p className="truncate text-xs text-white/75">
              {account.typeLabel}
              {account.mask && ` •••• ${account.mask}`}
            </p>
          </div>
        </div>
        <p className="mt-4 text-2xl font-bold tabular-nums">{formatCurrency(account.balance)}</p>
        <p className="text-xs text-white/75">{account.balanceLabel}</p>

        {account.sparkline && (
          <div className="mt-3 h-8">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={account.sparkline.map((v) => ({ v }))}>
                <Line type="monotone" dataKey="v" stroke="white" strokeOpacity={0.85} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="mt-2">
        <p className="mt-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Account Details</p>
        <div className="divide-y divide-border/50">
          <DetailRow label="Account Holder" value={account.accountHolder} />
          {account.accountNumberMasked && (
            <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="text-muted-foreground">Account Number</span>
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">
                  {revealed ? account.accountNumberMasked : `•••• •••• •••• ${account.mask}`}
                </span>
                <button
                  type="button"
                  aria-label={revealed ? "Hide account number" : "Reveal account number"}
                  onClick={() => setRevealed((v) => !v)}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
            </div>
          )}
          {account.ifsc && <DetailRow label="IFSC Code" value={account.ifsc} copyable />}
          <DetailRow label="Account Type" value={account.typeLabel} />
          {account.branch && <DetailRow label="Branch" value={account.branch} />}
          {account.upiId && <DetailRow label="UPI ID" value={account.upiId} copyable />}
          {account.linkedSince && <DetailRow label="Linked Since" value={account.linkedSince} />}
        </div>
      </div>

      <div className="mt-3">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Quick Actions</p>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {accountQuickActions.map((action) => {
            const ActionIcon = QUICK_ACTION_ICON[action.id];
            const onClick = action.id === "manage" || action.id === "rename" ? onEdit : undefined;
            return (
              <button
                key={action.id}
                type="button"
                onClick={onClick}
                disabled={!onClick}
                className="flex flex-col items-center gap-1.5 rounded-xl py-2 text-center transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex size-8 items-center justify-center rounded-full bg-primary/12 text-primary">
                  <ActionIcon className="size-4" />
                </span>
                <span className="text-[11px] font-medium text-foreground">{action.label}</span>
              </button>
            );
          })}
        </div>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold text-expense transition-colors hover:bg-expense/8"
          >
            Delete Account
          </button>
        )}
      </div>

      <div className="mt-3">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Shortcuts</p>
        <div className="mt-1 flex flex-col">
          {accountShortcuts.map((shortcut) => {
            const ShortcutIcon = SHORTCUT_ICON[shortcut.id];
            return (
              <button
                key={shortcut.id}
                type="button"
                className="flex items-center gap-3 rounded-xl px-1 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <ShortcutIcon className="size-3.5" />
                </span>
                <span className="flex-1 font-medium text-foreground">{shortcut.label}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
