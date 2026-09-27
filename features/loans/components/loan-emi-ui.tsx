"use client";

import { ChevronDown, ChevronRight, Landmark, ShoppingBag, X, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
  emi: { label: "EMI", plural: "EMIs", description: "A purchase or borrowing repaid in installments." },
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
  /** "month" / "week" — shown as "₹X / month". */
  cadence?: string | null;
  overdue?: boolean;
  paid: number;
  total: number;
  /** Small linked-record chips — card, person. */
  links?: { icon: LucideIcon; label: string }[];
  muted?: boolean;
  onClick: () => void;
}

/** "month" / "week" for a schedule frequency, or null when it isn't a regular cadence. */
export function cadenceLabel(frequency: string | null | undefined): string | null {
  return frequency === "monthly" ? "month" : frequency === "weekly" ? "week" : null;
}

/** The remaining-balance figure — the one number every Loan/EMI surface leads with. */
export function AmountDisplay({ amount, size = "md", className }: { amount: number; size?: "md" | "lg"; className?: string }) {
  return (
    <span
      className={cn(
        "truncate font-heading leading-none font-semibold tracking-tight text-foreground tabular-nums",
        size === "md" ? "text-2xl" : "text-3xl sm:text-4xl",
        className,
      )}
    >
      {formatCurrency(amount)}
    </span>
  );
}

/**
 * The Loan/EMI list card. Name → remaining balance carry the card; "₹X / month · Next: date", progress and
 * links are secondary. Neutral surface and icon; lime only on the progress fill.
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
  cadence,
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
          "group flex h-full cursor-pointer flex-col gap-4 border-border px-4 py-4 outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring sm:px-5",
          muted && "opacity-75",
        )}
      >
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/80">
            <Icon className="size-4" strokeWidth={2} />
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
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">{outstandingLabel}</span>
          <AmountDisplay amount={outstanding} />
          {nextDate && nextAmount != null && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="font-semibold text-foreground/85 tabular-nums">
                {formatCurrency(nextAmount)}
                {cadence ? <span className="font-normal text-muted-foreground"> / {cadence}</span> : null}
              </span>
              <span aria-hidden className="text-muted-foreground/60">
                ·
              </span>
              <span className={cn("font-medium", overdue ? "text-expense" : "text-muted-foreground")}>
                {overdue ? dueLabel(nextDate) : `Next: ${formatDueDate(nextDate)}`}
              </span>
            </div>
          )}
        </div>

        {total > 1 && <InstallmentProgress paid={paid} total={total} />}

        {links.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1">
            {links.map(({ icon: LinkIcon, label }) => (
              <span key={label} className="inline-flex max-w-full items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <LinkIcon className="size-3 shrink-0" />
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

/* ───────────────────────── Form system ───────────────────────── */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Optional trailing count (e.g. the Loans | EMIs switch). */
  count?: number;
}

/**
 * Segmented control — one neutral track, the selected segment lifted onto a card surface with a small lime
 * indicator. Used for every either/or choice in Loan & EMI (Loans | EMIs, I borrowed | I lent, For me | …).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  role = "radiogroup",
  size = "md",
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  /** "tablist" when it switches views, "radiogroup" when it's a form choice. */
  role?: "radiogroup" | "tablist";
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={cn("flex w-full gap-1 rounded-xl bg-muted p-1 ring-1 ring-border/60 sm:w-auto sm:self-start", className)}
    >
      {options.map(({ value: v, label, icon: Icon, count }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role={role === "tablist" ? "tab" : "radio"}
            aria-selected={role === "tablist" ? active : undefined}
            aria-checked={role === "radiogroup" ? active : undefined}
            onClick={() => onChange(v)}
            className={cn(
              "relative flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none",
              size === "md" ? "min-h-10 px-4 text-sm" : "min-h-9 px-3.5 text-[13px]",
              active ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className={cn("size-4 shrink-0", active && "text-primary-accent-text")} />}
            <span className="truncate">{label}</span>
            {count != null && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[11px] tabular-nums",
                  active ? "bg-primary/25 text-primary-accent-text" : "bg-card/70",
                )}
              >
                {count}
              </span>
            )}
            {active && <span aria-hidden className="absolute inset-x-4 bottom-0.5 h-0.5 rounded-full bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}

/** A titled group of form fields. Hierarchy comes from spacing and type, not boxes. */
export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-0.5">
        <h3 className="font-heading text-[15px] font-semibold text-foreground">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The Loan / EMI pick used by the Add chooser. */
export function KindChoice({ kind, onSelect }: { kind: "loan" | "emi"; onSelect: () => void }) {
  const Icon = kind === "loan" ? LOAN_ICON : EMI_ICON;
  const copy = KIND_COPY[kind];
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 transition-colors",
          kind === "loan" ? "bg-muted text-foreground ring-border" : "bg-primary/15 text-primary-accent-text ring-primary/25",
        )}
      >
        <Icon className="size-[18px]" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-heading text-sm font-semibold text-foreground">{copy.label}</span>
        <span className="text-xs leading-snug text-muted-foreground">{copy.description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}

/**
 * Progressive disclosure for genuinely secondary fields. Closed by default for a new record; the summary line
 * says what's inside before it's opened.
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
    <div className="flex flex-col border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-foreground">More options</span>
          <span className="truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="flex flex-col gap-5 pt-3">{children}</div>}
    </div>
  );
}

/** Label + input wrapper with consistent, readable label contrast. */
export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Non-`<label>` wrapper for chip rows (a `<label>` around several buttons would forward clicks to the first). */
export function FieldGroup({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Optional contextual card with a switch — "Add money to an account", "Paid with a credit card", "Has interest?".
 * Off: one quiet row. On: the card lifts to a subtle surface and reveals its fields.
 */
export function RevealToggle({
  checked,
  onChange,
  title,
  description,
  icon: Icon,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description?: string;
  icon?: LucideIcon;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl ring-1 transition-colors",
        checked ? "bg-muted/50 ring-border" : "ring-border/60 hover:ring-border",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="group/reveal flex items-center gap-3 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Icon && (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
              checked ? "bg-card text-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {description && <span className="text-xs text-muted-foreground">{description}</span>}
        </span>
        <AnimatedCheckbox checked={checked} />
      </button>
      {children && (
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
            checked ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
          inert={!checked}
        >
          <div className="overflow-hidden">
            <div className="flex flex-col gap-3 px-4 pt-1 pb-4">{children}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Rounded checkbox that pops and draws its tick when checked. Purely visual — the parent button owns state. */
function AnimatedCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center rounded-lg border-2 transition-all duration-200 ease-out motion-reduce:transition-none",
        checked ? "scale-100 border-primary bg-primary shadow-[0_0_0_4px] shadow-primary/20" : "border-foreground/25 bg-card group-hover/reveal:border-foreground/45",
        "group-active/reveal:scale-90",
      )}
    >
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5 text-primary-foreground">
        <path
          d="M3.5 8.5l3 3 6-7"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
          style={{ strokeDasharray: 1, strokeDashoffset: checked ? 0 : 1, transitionDelay: checked ? "80ms" : "0ms" }}
        />
      </svg>
    </span>
  );
}

/** Big amount input — the one field every Loan/EMI needs. Neutral surface; the figure carries the weight. */
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
      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 font-heading text-lg font-semibold text-muted-foreground">
        ₹
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        autoFocus={autoFocus}
        className="h-12 w-full rounded-lg border border-border bg-background pr-3 pl-9 font-heading text-xl font-semibold tabular-nums outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:ring-2 focus:ring-primary/30"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Rounded input class for the Loan & EMI forms. */
export const LOAN_EMI_INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-foreground/40 focus:ring-2 focus:ring-primary/30 disabled:opacity-70";

/**
 * The focused creation/edit dialog for Loans and EMIs: sticky header, scrolling body, sticky footer with the
 * primary CTA. A centered card on desktop; a full-height sheet on phones.
 */
export function LoanEmiFormDialog({
  open,
  onOpenChange,
  title,
  description,
  icon: Icon,
  children,
  onConfirm,
  confirmLabel,
  loading = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  onConfirm: () => void;
  confirmLabel: string;
  loading?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 ring-1 ring-border",
          // Phone: full-height sheet. Desktop: centered card.
          "top-0 left-0 h-[100dvh] max-h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none",
          "sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[min(88vh,52rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
        )}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4 sm:px-6">
          {Icon && (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
              <Icon className="size-[18px]" />
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <DialogTitle className="font-heading text-lg font-semibold">{title}</DialogTitle>
            <DialogDescription className={description ? "text-xs" : "sr-only"}>{description ?? title}</DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            disabled={loading}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-5 py-5 text-sm sm:px-6 sm:py-6">{children}</div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-5 pt-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:px-6">
          <ClayButton variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </ClayButton>
          <ClayButton variant="primary" className="min-w-32 flex-1 sm:flex-none" onClick={onConfirm} disabled={loading}>
            {confirmLabel}
          </ClayButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
