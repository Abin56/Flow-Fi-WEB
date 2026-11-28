"use client";

import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Copy, CreditCard, Eye, EyeOff, Info, Landmark, ListChecks, Pencil, Receipt, Star, Trash2, Wallet, X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useState, type CSSProperties } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { BankLogo } from "@/components/finance/bank-logo";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";
import { AccountLinkedFundsSection } from "@/features/people/components/linked-funds";
import type { LinkedFund } from "@/lib/engines/linked-funds";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { durations, easings } from "@/lib/motion/tokens";
import visuals from "./accounts-visuals.module.css";

const DETAIL_ROW = "grid min-h-8 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2 py-1 text-[13px]";
const DETAIL_VALUE = "min-w-0 wrap-anywhere text-right font-medium text-foreground";
const DETAIL_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const SECONDARY_ACTION =
  "flex min-h-8 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs leading-tight font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const BALANCE_VALUE = "min-w-0 wrap-anywhere text-2xl leading-none font-bold tracking-tight tabular-nums";
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
  creditCard = false,
  onClose,
  onEdit,
  onDelete,
  onManageTransactions,
  onViewTransactions,
  onExplainBalance,
  linkedFunds,
}: {
  account: AccountOverviewItem;
  creditCard?: boolean;
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
  const Icon = creditCard ? CreditCard : account.mask ? Landmark : Wallet;
  const reduceMotion = useReducedMotion();
  const balance = formatCurrency(account.balance);

  return (
    <motion.aside
      aria-label="Account overview"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: durations.base, ease: easings.out }}
      className="@container flex h-fit w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border-strong/65 bg-card shadow-e1 lg:sticky lg:top-0 lg:w-[19rem]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <h2 className="font-heading text-sm font-semibold text-foreground">Account overview</h2>
        <button
          type="button"
          aria-label="Close account overview"
          onClick={onClose}
          className={DETAIL_BUTTON}
        >
          <X className="size-4" />
        </button>
      </div>

      <motion.div
        key={account.id}
        initial={reduceMotion ? false : { opacity: 0.55, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: durations.base, ease: easings.out }}
        className={cn("mx-3 rounded-lg border border-border px-2.5 py-2.5", visuals.overviewIdentity)}
        style={{ "--account-accent": palette.stroke } as CSSProperties}
      >
        <div className="flex items-start gap-2">
          {account.bankId ? (
            <BankLogo bankId={account.bankId} shape="square" size={30} className="shrink-0 ring-1 ring-border/70" />
          ) : (
            <span className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-md", visuals.mark)}>
              <Icon className="size-4" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <p className="wrap-anywhere font-heading text-sm leading-snug font-semibold">{account.name}</p>
            <p className="text-xs leading-snug text-muted-foreground">
              {account.typeLabel}
              {account.mask && <span className="ml-1.5 inline-block font-mono tracking-wider">•••• {account.mask}</span>}
            </p>
            {account.isPrimary && (
              <span className="mt-1 inline-flex items-center gap-1 rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] leading-none font-semibold text-muted-foreground">
                <Star className="size-3 fill-current" aria-hidden />
                Primary
              </span>
            )}
          </div>
        </div>

        <div className="mt-2 border-t border-border pt-1.5">
          <p className="text-xs font-medium text-muted-foreground">{account.balanceLabel}</p>
          {onExplainBalance ? (
            <button
              type="button"
              onClick={onExplainBalance}
              aria-label={`Explain ${account.name} balance`}
              title="See how this is calculated"
              className="group/explain mt-0.5 flex w-fit max-w-full items-center gap-1.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className={BALANCE_VALUE}>{balance}</span>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground group-hover/explain:bg-secondary group-hover/explain:text-foreground motion-safe:transition-colors">
                <Info className="size-3.5" aria-hidden />
              </span>
            </button>
          ) : (
            <p className={cn(BALANCE_VALUE, "mt-0.5")}>{balance}</p>
          )}
          {account.sparkline && (
            <div className="mt-1.5 h-7">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={account.sparkline.map((v) => ({ v }))}>
                  <Line type="monotone" dataKey="v" stroke={palette.stroke} strokeOpacity={0.8} strokeWidth={2} dot={false} isAnimationActive={!reduceMotion} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </motion.div>

      <div className="flex flex-col gap-1.5 px-3 pt-2 empty:hidden">
        {onViewTransactions && (
          <button
            type="button"
            onClick={onViewTransactions}
            className="group flex min-h-9 w-full items-center gap-2 rounded-md border border-primary-accent-text/25 bg-primary/12 px-2.5 text-left text-sm font-semibold text-primary-accent-text hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-safe:transition-colors"
          >
            <Receipt className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">Transactions</span>
            <ArrowRight className="size-4 shrink-0 motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" aria-hidden />
          </button>
        )}
        {(onEdit || onManageTransactions || onDelete) && (
          <div className="flex gap-0.5 rounded-lg bg-secondary/55 p-0.5">
            {onEdit && (
              <button type="button" onClick={onEdit} className={cn(SECONDARY_ACTION, "shrink-0")}>
                <Pencil className="size-3.5 shrink-0" aria-hidden />
                Edit
              </button>
            )}
            {onManageTransactions && (
              <button type="button" onClick={onManageTransactions} className={cn(SECONDARY_ACTION, "flex-1 px-1 @[18rem]:whitespace-nowrap")}>
                <ListChecks className="size-3 shrink-0" aria-hidden />
                <span>Manage transactions</span>
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={onDelete} className={cn(SECONDARY_ACTION, "shrink-0 text-expense hover:bg-expense/10 hover:text-expense")}>
                <Trash2 className="size-3.5 shrink-0" aria-hidden />
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 p-3">
        {linkedFunds && <AccountLinkedFundsSection balance={account.balance} funds={linkedFunds.funds} total={linkedFunds.total} />}

        <section>
          <h3 className="font-heading text-sm font-semibold text-foreground">Account details</h3>
          <dl className="mt-0.5 divide-y divide-border-strong/35">
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

        <div className="border-t border-border-strong/35 pt-1">
          <Link
            href="/transactions"
            className="group flex min-h-8 items-center gap-2 rounded-md px-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Receipt className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">All transactions</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
          </Link>
          <div className="mt-1 border-t border-border pt-2">
            <h3 className="text-[11px] font-semibold text-muted-foreground">Coming soon</h3>
            <ul className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              {UPCOMING_FEATURES.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}
