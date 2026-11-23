"use client";

import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Copy, Eye, EyeOff, Info, Landmark, ListChecks, Pencil, Receipt, Star, Trash2, Wallet, X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { AccountLinkedFundsSection } from "@/features/people/components/linked-funds";
import type { LinkedFund } from "@/lib/engines/linked-funds";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const DETAIL_ROW = "grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 py-2 text-sm";
const DETAIL_VALUE = "min-w-0 wrap-anywhere text-right font-medium text-foreground";
const DETAIL_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const SECONDARY_ACTION =
  "flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-1 py-1.5 text-xs leading-tight font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const BALANCE_VALUE = "min-w-0 wrap-anywhere font-heading text-[clamp(1.875rem,7vw,2.25rem)] leading-none font-bold tracking-tight tabular-nums";
const UPCOMING_FEATURES = ["Statement", "Insights", "Balance alert", "Reconcile", "Hide"];

function DetailRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={DETAIL_ROW}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-1">
        <span className={DETAIL_VALUE}>{value}</span>
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
                // Clipboard unavailable.
              }
            }}
            className={DETAIL_BUTTON}
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </dd>
    </div>
  );
}

export function AccountOverviewPanel({
  account,
  onClose,
  onEdit,
  onDelete,
  onManageTransactions,
  onViewTransactions,
  onExplainBalance,
  linkedFunds,
}: {
  account: AccountOverviewItem;
  onClose: () => void;
  /** Opens the balance breakdown for this account. */
  onExplainBalance?: () => void;
  /** Opens the central Transactions workspace filtered to this account. */
  onViewTransactions?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Opens "delete selected / all transactions" — the account itself is kept. */
  onManageTransactions?: () => void;
  /** People money held in this account for a card bill / EMI still to be paid — informational, never subtracted. */
  linkedFunds?: { funds: LinkedFund[]; total: number };
}) {
  const [revealed, setRevealed] = useState(false);
  const palette = account.palette;
  const lightText = palette.onGradient === "text-white";
  const Icon = account.mask ? Landmark : Wallet;
  const reduceMotion = useReducedMotion();
  const balance = formatCurrency(account.balance);

  return (
    <motion.aside
      key={account.id}
      aria-label="Account overview"
      initial={reduceMotion ? false : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="flex h-fit w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-2xl border border-border-strong/60 bg-card shadow-e1 lg:sticky lg:top-0 lg:w-[22rem]"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <h2 className="font-heading text-base font-semibold tracking-tight text-foreground">Account overview</h2>
        <button
          type="button"
          aria-label="Close account overview"
          onClick={onClose}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary/65 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X className="size-4" />
        </button>
      </div>

      <div
        className={cn("relative isolate mx-4 overflow-hidden rounded-xl p-4", palette.onGradient)}
        style={{ background: palette.gradient }}
      >
        <div aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10", lightText ? "bg-black/42" : "bg-white/45")} />
        <div aria-hidden className="pointer-events-none absolute -right-16 -bottom-24 -z-10 size-64 rounded-full border border-current/15" />
        <div aria-hidden className="pointer-events-none absolute -right-8 -bottom-28 -z-10 size-64 rounded-full border border-current/10" />
        <div className="flex items-start gap-3">
          {account.bankId ? (
            <BankLogo bankId={account.bankId} shape="square" size={40} className="ring-1 ring-current/20" />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-current/10 ring-1 ring-current/20">
              <Icon className="size-5" />
            </span>
          )}
          <div className="min-w-0">
            <p className="wrap-anywhere font-heading text-[15px] leading-snug font-semibold">{account.name}</p>
            <p className="mt-0.5 text-xs leading-snug">
              {account.typeLabel}
              {account.mask && <span className="ml-1.5 inline-block font-mono tracking-wider">•••• {account.mask}</span>}
            </p>
            {account.isPrimary && (
              <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-current/10 px-1.5 py-0.5 text-[10px] leading-none font-semibold">
                <Star className="size-3 fill-current" aria-hidden />
                Primary
              </span>
            )}
          </div>
        </div>

        <div className="mt-3.5 border-t border-current/20 pt-3">
          <p className="text-xs font-medium">{account.balanceLabel}</p>
          {onExplainBalance ? (
            <button
              type="button"
              onClick={onExplainBalance}
              aria-label={`Explain ${account.name} balance`}
              title="See how this is calculated"
              className="group/explain mt-1 flex w-fit max-w-full items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
            >
              <span className={BALANCE_VALUE}>{balance}</span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-current/10 transition-colors group-hover/explain:bg-current/20">
                <Info className="size-4" />
              </span>
            </button>
          ) : (
            <p className={cn(BALANCE_VALUE, "mt-1")}>{balance}</p>
          )}
          {account.sparkline && (
            <div className="mt-2 h-9">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={account.sparkline.map((v) => ({ v }))}>
                  <Line type="monotone" dataKey="v" stroke="currentColor" strokeOpacity={0.8} strokeWidth={2} dot={false} isAnimationActive={!reduceMotion} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 px-4 pt-3 empty:hidden">
        {onViewTransactions && (
          <button
            type="button"
            onClick={onViewTransactions}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-xl bg-primary px-3 text-left text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Receipt className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">Transactions</span>
            <ArrowRight className="size-4 shrink-0" aria-hidden />
          </button>
        )}
        {(onEdit || onManageTransactions || onDelete) && (
          <div className="flex gap-0.5 rounded-xl bg-secondary/55 p-1">
            {onEdit && (
              <button type="button" onClick={onEdit} className={SECONDARY_ACTION}>
                <Pencil className="size-3.5 shrink-0" aria-hidden />
                Edit
              </button>
            )}
            {onManageTransactions && (
              <button type="button" onClick={onManageTransactions} className={cn(SECONDARY_ACTION, "flex-[2.25]")}>
                <ListChecks className="size-3.5 shrink-0" aria-hidden />
                <span>Manage transactions</span>
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={onDelete} className={cn(SECONDARY_ACTION, "text-expense hover:bg-expense/10 hover:text-expense")}>
                <Trash2 className="size-3.5 shrink-0" aria-hidden />
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 pt-4 pb-4">
        {linkedFunds && <AccountLinkedFundsSection balance={account.balance} funds={linkedFunds.funds} total={linkedFunds.total} />}

        <section>
          <h3 className="font-heading text-sm font-semibold text-foreground">Account details</h3>
          <dl className="mt-1.5 divide-y divide-border-strong/35">
            <DetailRow label="Account holder" value={account.accountHolder} />
            {account.accountNumberMasked && (
              <div className={DETAIL_ROW}>
                <dt className="text-muted-foreground">Account number</dt>
                <dd className="flex min-w-0 items-center justify-end gap-1">
                  <span className={cn(DETAIL_VALUE, "tabular-nums")}>{revealed ? account.accountNumberMasked : `•••• ${account.mask}`}</span>
                  <button
                    type="button"
                    aria-label={revealed ? "Hide account number" : "Reveal account number"}
                    onClick={() => setRevealed((v) => !v)}
                    className={DETAIL_BUTTON}
                  >
                    {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </dd>
              </div>
            )}
            {account.ifsc && <DetailRow label="IFSC code" value={account.ifsc} copyable />}
            <DetailRow label="Account type" value={account.typeLabel} />
            {account.branch && <DetailRow label="Branch" value={account.branch} />}
            {account.upiId && <DetailRow label="UPI ID" value={account.upiId} copyable />}
            {account.linkedSince && <DetailRow label="Linked since" value={account.linkedSince} />}
          </dl>
        </section>

        <div className="border-t border-border-strong/35 pt-2">
          <Link
            href="/transactions"
            className="group flex min-h-10 items-center gap-2.5 rounded-lg px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Receipt className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">All transactions</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
          </Link>
          <div className="mt-2 rounded-xl bg-secondary/55 px-3 py-2.5">
            <h3 className="text-xs font-semibold text-foreground">Coming soon</h3>
            <ul className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs leading-relaxed text-muted-foreground">
              {UPCOMING_FEATURES.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}
