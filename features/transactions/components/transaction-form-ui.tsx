"use client";

/**
 * Transaction-form design system — the shared visual primitives for Add Expense / Add Income / Add Transfer /
 * Edit Transaction (incl. a card-bill payment transfer). One family: flat sections split by solid dividers (no
 * nested cards), a small uppercase section label, one amount surface with a semantic left edge, a compact mode
 * switch, and an explicit From → To account flow. Visual only — every control's state lives in the form.
 *
 * Contrast rule (People Ledger / Loan & EMI): solid `border-border-strong` control edges and `text-foreground/75+`
 * secondary text — never pale opacity-faded borders or grey-on-white that wash out on low-contrast displays.
 * Color is never the only signal: every mode / state also carries an icon and a word.
 */

import type { ReactNode } from "react";
import { ArrowLeftRight, ArrowRight, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TxnFormField } from "@/features/transactions/lib/focus-invalid-field";

export type TxnFormKind = "expense" | "income" | "transfer";

export const TXN_KIND_META: Record<TxnFormKind, { label: string; icon: LucideIcon; hint: string }> = {
  expense: { label: "Expense", icon: TrendingDown, hint: "Money going out" },
  income: { label: "Income", icon: TrendingUp, hint: "Money coming in" },
  transfer: { label: "Transfer", icon: ArrowLeftRight, hint: "Move money between accounts" },
};

/** Per-kind text tone — amount sign, header icon, selected mode label. Literal class names (Tailwind JIT). */
export const TXN_KIND_TEXT: Record<TxnFormKind, string> = {
  expense: "text-expense",
  income: "text-success",
  transfer: "text-primary-accent-text",
};
/** Solid kind color + matched foreground — the header icon tile and the top accent bar. */
export const TXN_KIND_SOLID: Record<TxnFormKind, string> = {
  expense: "bg-expense text-expense-foreground",
  income: "bg-success text-success-foreground",
  transfer: "bg-primary text-primary-foreground",
};
/** Semantic left edge on the amount surface — the kind still reads where tints wash out. */
export const TXN_KIND_EDGE: Record<TxnFormKind, string> = {
  expense: "border-l-expense",
  income: "border-l-success",
  transfer: "border-l-primary-accent-text",
};
/** Selected mode chip: solid semantic border + subtle tint + strong text. */
const TXN_KIND_SELECTED: Record<TxnFormKind, string> = {
  expense: "border-expense bg-expense/10 text-expense",
  income: "border-success bg-success/10 text-success",
  transfer: "border-primary-accent-text bg-primary/15 text-foreground dark:text-primary-accent-text",
};

/** One label-above-control row. `field` tags it as a submit-validation target (see `focusInvalidField`); `error`
 *  marks it invalid with a solid danger ring + short message. */
export function TxnFieldRow({ label, children, field, error }: { label: string; children: ReactNode; field?: TxnFormField; error?: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-field={field} data-invalid={error ? "true" : undefined}>
      <span className={cn("text-xs font-semibold", error ? "text-danger" : "text-foreground/80")}>{label}</span>
      {/* Always-present wrapper: toggling the ring must not remount the control (that would drop its focus). */}
      <div className={cn("min-w-0 rounded-[6px]", error && "ring-2 ring-danger")}>{children}</div>
      {error && (
        <p role="alert" className="text-[11px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** One titled section — flat, split from the previous one by a solid divider, with a small uppercase label. */
export function TxnSection({ icon: Icon, title, aside, children, className }: { icon?: LucideIcon; title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2.5 border-t border-border px-4 py-3 sm:px-5", className)}>
      {(title || aside) && (
        <div className="flex min-h-5 items-center justify-between gap-2">
          {title && (
            <h3 className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.07em] text-foreground/80 uppercase">
              {Icon && <Icon className="size-3.5" strokeWidth={2} aria-hidden />}
              {title}
            </h3>
          )}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** Compact transaction-mode switch — "↓ Expense  ↑ Income" (+ "⇄ Transfer" when offered). Selected: semantic border,
 *  tint and strong text; unselected: neutral but clearly clickable. Locked once editing (kind can't change). */
export function TxnModeSwitch({ value, kinds, locked, onChange }: { value: TxnFormKind; kinds: TxnFormKind[]; locked: boolean; onChange: (k: TxnFormKind) => void }) {
  return (
    <div role="group" aria-label="Transaction type" className={cn("grid gap-1.5", kinds.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
      {kinds.map((k) => {
        const meta = TXN_KIND_META[k];
        const Icon = meta.icon;
        const active = value === k;
        return (
          <button
            key={k}
            type="button"
            aria-pressed={active}
            disabled={locked && !active}
            onClick={() => onChange(k)}
            className={cn(
              "flex h-9 items-center justify-center gap-1.5 rounded-[6px] border px-2 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              active ? cn("font-bold", TXN_KIND_SELECTED[k]) : "border-border-strong bg-card font-semibold text-foreground/80 hover:bg-secondary hover:text-foreground",
              locked && !active && "opacity-45",
            )}
          >
            <Icon className="size-4" strokeWidth={2.25} aria-hidden />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

/** From → To with a small directional marker between — stacks (↓) on phones. */
export function TxnAccountFlow({ from, to }: { from: ReactNode; to: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-end gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-2.5">
      {from}
      <span aria-hidden className="flex justify-center sm:pb-1">
        <span className="flex size-7 items-center justify-center rounded-full border border-border-strong bg-secondary text-foreground">
          <ArrowRight className="size-3.5 rotate-90 sm:rotate-0" strokeWidth={2.25} />
        </span>
      </span>
      {to}
    </div>
  );
}
