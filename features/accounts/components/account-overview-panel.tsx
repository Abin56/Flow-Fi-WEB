"use client";

import Link from "next/link";
import { Bell, Check, ChevronRight, Copy, Download, EyeOff, Eye, Landmark, Pencil, Receipt, RefreshCcw, Star, Trash2, TrendingUp, Wallet, X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { AccountLinkedFundsSection } from "@/features/people/components/linked-funds";
import type { LinkedFund } from "@/lib/engines/linked-funds";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const SOON = "rounded-[4px] bg-secondary px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";

function DetailRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <span className="text-foreground/70">{label}</span>
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
  onViewTransactions,
  linkedFunds,
}: {
  account: AccountOverviewItem;
  onClose: () => void;
  /** Opens the central Transactions workspace filtered to this account. */
  onViewTransactions?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** People money held in this account for a card bill / EMI still to be paid — informational, never subtracted. */
  linkedFunds?: { funds: LinkedFund[]; total: number };
}) {
  const [revealed, setRevealed] = useState(false);
  const palette = ACCOUNT_COLOR[account.color];
  const Icon = account.mask ? Landmark : Wallet;
  const reduceMotion = useReducedMotion();

  return (
    <motion.aside
      key={account.id}
      initial={reduceMotion ? false : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="flex h-fit w-full shrink-0 flex-col overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1 lg:sticky lg:top-0 lg:w-[22rem]"
    >
      {/* Hero — the account's own colour */}
      <div className={cn("relative overflow-hidden px-4 pt-3.5 pb-4", palette.onGradient)} style={{ background: palette.gradient }}>
        <span aria-hidden className="pointer-events-none absolute -top-16 -right-12 size-44 rounded-full bg-white/15 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -bottom-20 -left-12 size-44 rounded-full border border-white/10" />
        <div className="relative flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold tracking-[0.08em] uppercase opacity-85">Account overview</span>
          <button
            type="button"
            aria-label="Close account overview"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-full bg-white/15 transition-colors hover:bg-white/25"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative mt-3 flex items-center gap-3">
          {account.bankId ? (
            <BankLogo bankId={account.bankId} size={42} className="shadow-md ring-2 ring-white/40" />
          ) : (
            <span className="flex size-[42px] items-center justify-center rounded-full bg-white/20 ring-1 ring-white/30">
              <Icon className="size-5" />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-heading text-base leading-tight font-semibold">{account.name}</p>
            <p className="truncate text-xs opacity-85">
              {account.typeLabel}
              {account.mask && <span className="ml-1 font-mono tracking-[0.12em]">•••• {account.mask}</span>}
            </p>
          </div>
          {account.isPrimary && (
            <span className="ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-white/25 px-2 text-[10.5px] font-semibold">
              <Star className="size-3 fill-current" aria-hidden />
              Primary
            </span>
          )}
        </div>

        <p className="relative mt-4 text-[11px] font-semibold tracking-[0.06em] uppercase opacity-85">{account.balanceLabel}</p>
        <p className="relative text-[30px] leading-tight font-bold tracking-tight tabular-nums">{formatCurrency(account.balance)}</p>
        {account.sparkline && (
          <div className="relative mt-2 h-10">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={account.sparkline.map((v) => ({ v }))}>
                <Line type="monotone" dataKey="v" stroke="white" strokeOpacity={0.9} strokeWidth={2.25} dot={false} isAnimationActive={!reduceMotion} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-2 border-b border-border-strong/40 p-3">
        {onViewTransactions && (
          <button type="button" onClick={onViewTransactions} className={QUICK}>
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/25 text-foreground dark:text-primary-accent-text">
              <Receipt className="size-4" strokeWidth={2} />
            </span>
            Transactions
          </button>
        )}
        {onEdit && (
          <button type="button" onClick={onEdit} className={QUICK}>
            <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-foreground">
              <Pencil className="size-4" strokeWidth={2} />
            </span>
            Edit
          </button>
        )}
        {onDelete && (
          <button type="button" onClick={onDelete} className={cn(QUICK, "hover:border-expense/40 hover:bg-expense/8 hover:text-expense")}>
            <span className="flex size-8 items-center justify-center rounded-full bg-expense/10 text-expense">
              <Trash2 className="size-4" strokeWidth={2} />
            </span>
            Delete
          </button>
        )}
      </div>

      <div className="flex flex-col gap-4 p-4">
        {linkedFunds && <AccountLinkedFundsSection balance={account.balance} funds={linkedFunds.funds} total={linkedFunds.total} />}

        <div>
          <p className={LABEL}>Account details</p>
          <div className="mt-1.5 divide-y divide-border-strong/40 rounded-[10px] border border-border-strong/50 px-3">
            <DetailRow label="Account holder" value={account.accountHolder} />
            {account.accountNumberMasked && (
              <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="text-foreground/70">Account number</span>
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
        </div>

        <div>
          <p className={LABEL}>More</p>
          <div className="mt-1.5 flex flex-col">
            <Link href="/transactions" className="flex items-center gap-3 rounded-[8px] px-1.5 py-2 text-sm transition-colors hover:bg-secondary">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-primary/20 text-foreground dark:text-primary-accent-text">
                <Receipt className="size-3.5" />
              </span>
              <span className="flex-1 font-medium text-foreground">All transactions</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </div>
          {/* Not built yet — shown together, quietly, rather than as five dead rows. */}
          <div className="mt-2 flex flex-wrap gap-1.5" title="Coming soon">
            {(
              [
                { icon: Download, label: "Statement" },
                { icon: TrendingUp, label: "Insights" },
                { icon: Bell, label: "Balance alert" },
                { icon: RefreshCcw, label: "Reconcile" },
                { icon: EyeOff, label: "Hide" },
              ] as const
            ).map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-strong/70 px-2 py-1 text-[11px] font-medium text-foreground/60">
                <item.icon className="size-3" />
                {item.label}
              </span>
            ))}
            <span className={cn(SOON, "self-center")}>Soon</span>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}

const QUICK =
  "flex flex-col items-center justify-center gap-1.5 rounded-[10px] border border-border-strong/60 bg-card px-2 py-2.5 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring";
