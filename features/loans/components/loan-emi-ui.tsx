"use client";

import { ChevronDown, ChevronRight, Landmark, ShoppingBag, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { FloatingCard } from "@/components/foundation/floating-card";
import { StaggerItem } from "@/components/foundation/animated-container";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Shared presentation for the Loan & EMI section — one card, one detail hero, one fact grid and one
 * "More options" disclosure, so Loans and EMIs read as the same product. Purely visual: every figure
 * passed in is already derived by `useLoanRows`/`useEmiRows`; nothing here computes money.
 *
 * Terminology (kept identical on Flutter — see `loan_emi_ui.dart`):
 *   Loan — money borrowed from a bank, lender or person.
 *   EMI  — installment-based finance: a product purchase, a Credit Card EMI, store finance.
 */
export const LOAN_ICON: LucideIcon = Landmark;
export const EMI_ICON: LucideIcon = ShoppingBag;

export const KIND_COPY = {
  loan: { label: "Loan", plural: "Loans", description: "Money borrowed from a bank, lender or person." },
  emi: { label: "EMI", plural: "EMIs", description: "Installments for a purchase, Credit Card EMI or store finance." },
} as const;

/** "Mar 5" / "Mar 5, 2027" — absolute, since a due date reads better as a date than "3 days ago". */
export function formatDueDate(date: Date): string {
  const now = new Date();
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** Whole days from today until `date` (negative once past). */
export function daysUntil(date: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(date) - start(new Date())) / 86_400_000);
}

/** "Due today" / "Due in 3 days" / "Overdue by 2 days" / "Due Mar 5". */
export function dueLabel(date: Date): string {
  const days = daysUntil(date);
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days > 1 && days <= 7) return `Due in ${days} days`;
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
  return `Due ${formatDueDate(date)}`;
}

/** Installment progress bar — dark olive on light, lime on dark (via `primary-accent-text`), so the fill
 *  stays readable on both themes instead of a pale lime on a pale track. */
export function InstallmentProgress({ paid, total, className }: { paid: number; total: number; className?: string }) {
  const percent = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted ring-1 ring-border/70"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={paid}
        aria-label={`${paid} of ${total} installments paid`}
      >
        <div className="h-full rounded-full bg-primary-accent-text transition-[width] duration-700 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground/80 tabular-nums">
          {paid} of {total} paid
        </span>
        <span className="text-muted-foreground tabular-nums">{Math.max(total - paid, 0)} left</span>
      </div>
    </div>
  );
}

export interface DebtCardBadge {
  label: string;
  tone: "neutral" | "primary" | "success" | "expense" | "warning";
}

export interface DebtCardProps {
  icon: LucideIcon;
  name: string;
  /** Lender / source line under the name. */
  source: string;
  /** Only non-routine states (Overdue, Closed, Completed, Money I Lent) — "Active" is the default and gets no badge. */
  badges?: DebtCardBadge[];
  outstandingLabel: string;
  outstanding: number;
  nextAmount: number | null;
  nextDate: Date | null;
  overdue?: boolean;
  paid: number;
  total: number;
  /** Small linked-record chips — card, person. */
  links?: { icon: LucideIcon; label: string }[];
  muted?: boolean;
  onClick: () => void;
}

/**
 * The Loan/EMI list card. Visual weight is deliberately uneven: name → outstanding amount carry the card;
 * next installment, progress and links are secondary. Neutral surface and icon; lime only on the progress fill.
 */
export function DebtCard({
  icon: Icon,
  name,
  source,
  badges = [],
  outstandingLabel,
  outstanding,
  nextAmount,
  nextDate,
  overdue = false,
  paid,
  total,
  links = [],
  muted = false,
  onClick,
}: DebtCardProps) {
  return (
    <StaggerItem>
      <FloatingCard
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        elevation={1}
        className={cn(
          "group flex h-full cursor-pointer flex-col gap-4 border-border px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5",
          muted && "opacity-75",
        )}
      >
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground ring-1 ring-border">
            <Icon className="size-[18px]" strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <h3 className="truncate font-heading text-[15px] leading-snug font-semibold text-foreground">{name}</h3>
            <p className="truncate text-xs text-muted-foreground">{source}</p>
          </div>
          {badges.length > 0 ? (
            <div className="flex shrink-0 flex-col items-end gap-1">
              {badges.map((b) => (
                <ClayBadge key={b.label} tone={b.tone} className="px-2 py-0.5 text-[11px] font-semibold">
                  {b.label}
                </ClayBadge>
              ))}
            </div>
          ) : (
            <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          )}
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">{outstandingLabel}</span>
            <span className="truncate font-heading text-2xl leading-none font-semibold tracking-tight text-foreground tabular-nums">
              {formatCurrency(outstanding)}
            </span>
          </div>
          {nextDate && nextAmount != null && (
            <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
              <span className={cn("text-xs font-medium", overdue ? "text-expense" : "text-muted-foreground")}>{dueLabel(nextDate)}</span>
              <span className="font-mono text-sm font-semibold text-foreground tabular-nums">{formatCurrency(nextAmount)}</span>
            </div>
          )}
        </div>

        {total > 1 && <InstallmentProgress paid={paid} total={total} />}

        {links.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-1.5 border-t border-border pt-3">
            {links.map(({ icon: LinkIcon, label }) => (
              <span
                key={label}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-foreground/80"
              >
                <LinkIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
              </span>
            ))}
          </div>
        )}
      </FloatingCard>
    </StaggerItem>
  );
}

/** Detail-view hero: the outstanding balance first and largest, with progress right under it. */
export function DetailHero({
  label,
  amount,
  paid,
  total,
  badges = [],
}: {
  label: string;
  amount: number;
  paid: number;
  total: number;
  badges?: DebtCardBadge[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
          <span className="font-heading text-3xl leading-none font-semibold tracking-tight text-foreground tabular-nums sm:text-4xl">
            {formatCurrency(amount)}
          </span>
        </div>
        {badges.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1">
            {badges.map((b) => (
              <ClayBadge key={b.label} tone={b.tone} className="font-semibold">
                {b.label}
              </ClayBadge>
            ))}
          </div>
        )}
      </div>
      {total > 0 && <InstallmentProgress paid={paid} total={total} />}
    </div>
  );
}

export interface Fact {
  label: string;
  value: React.ReactNode;
  /** Emphasize (e.g. the next payment). */
  strong?: boolean;
  tone?: "expense";
}

/** Compact label/value grid used on both detail views. */
export function FactGrid({ facts, className }: { facts: (Fact | null | false)[]; className?: string }) {
  const visible = facts.filter(Boolean) as Fact[];
  return (
    <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3", className)}>
      {visible.map((f) => (
        <div key={f.label} className="flex min-w-0 flex-col gap-0.5 bg-card px-3.5 py-3">
          <dt className="truncate text-[11px] font-medium text-muted-foreground">{f.label}</dt>
          <dd
            className={cn(
              "truncate text-sm font-medium text-foreground tabular-nums",
              f.strong && "font-semibold",
              f.tone === "expense" && "text-expense",
            )}
          >
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A linked record row (Account / Credit Card / Person) with an optional link out to its own section. */
export function LinkedRow({ icon: Icon, label, value, action }: { icon: LucideIcon; label: string; value: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground ring-1 ring-border">
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <span className="truncate text-sm font-medium text-foreground">{value}</span>
      </div>
      {action}
    </div>
  );
}

export function LinkedList({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{children}</div>;
}

/** Small uppercase heading for a detail-view section. */
export function DetailSectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
      {aside}
    </div>
  );
}

/**
 * Progressive disclosure for secondary form fields. Closed by default for a new record so a first-time user
 * sees only what's needed; the summary line tells them what's inside before they open it.
 */
export function MoreOptions({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-between gap-3 px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-foreground">More options</span>
          <span className="text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="flex flex-col gap-5 border-t border-border p-4">{children}</div>}
    </div>
  );
}

/** Label + input wrapper with consistent, readable label contrast. */
export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-semibold text-foreground/85">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Non-`<label>` wrapper for chip rows (a `<label>` around several buttons would forward clicks to the first). */
export function FieldGroup({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-foreground/85">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** Switch-like toggle row that reveals its children when on — e.g. "On a credit card?" */
export function RevealToggle({
  checked,
  onChange,
  title,
  description,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col border border-border transition-colors", checked && "bg-muted/30")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex items-center justify-between gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {description && <span className="text-xs text-muted-foreground">{description}</span>}
        </span>
        <span
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
            checked ? "border-primary bg-primary" : "border-border bg-muted",
          )}
        >
          <span
            className={cn(
              "absolute size-3.5 rounded-full shadow-sm transition-transform",
              checked ? "translate-x-[18px] bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground",
            )}
          />
        </span>
      </button>
      {checked && children && <div className="flex flex-col gap-3 border-t border-border px-4 py-4">{children}</div>}
    </div>
  );
}

/** Big amount input — the one field every Loan/EMI needs. Neutral surface; the ₹ sign carries the accent. */
export function AmountInput({
  value,
  onChange,
  min,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: number;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base font-semibold text-foreground/70">₹</span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        autoFocus={autoFocus}
        className="h-12 w-full rounded-none border border-border bg-background pl-8 pr-3 font-heading text-lg font-semibold tabular-nums outline-none transition-colors focus:border-primary"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
