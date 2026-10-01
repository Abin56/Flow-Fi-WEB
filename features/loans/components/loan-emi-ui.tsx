"use client";

import { Check, ChevronDown, ChevronRight, Landmark, Loader2, ShoppingBag, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { OperationProgressView } from "@/components/feedback/operation-progress";
import type { OperationSnapshot } from "@/lib/operation-progress/operation-progress";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ClayBadge } from "@/components/clay/clay-badge";
import { StaggerItem } from "@/components/foundation/animated-container";
import { cn } from "@/lib/utils";
import { handleEnterKey } from "@/components/ui/enter-key";

/**
 * Shared presentation for the Loan & EMI section — one card, one detail hero, one fact grid and one
 * "Optional details" disclosure, so Loans and EMIs read as the same product. Purely visual: every figure
 * passed in is already derived by `useLoanRows`/`useEmiRows`; nothing here computes money.
 *
 * Visibility rules (this section must survive low-contrast monitors):
 *   - Control edges use the solid `border-strong` token, never an opacity-faded border.
 *   - Selected = lime fill + dark olive edge + check/weight change — never a tint or underline alone.
 *   - Radius is deliberately tighter than the app-wide scale (whose `rounded-xl` is 20px): see `LE_RADIUS`.
 *   - Weight hierarchy (high visibility without heaviness): surfaces and sections use the solid `border`
 *     token; only interactive controls (inputs, options, toggles) use `border-strong`; nested elements use
 *     `border` or a fill. Bold is reserved for amounts, titles and the primary action — labels are medium,
 *     metadata regular. Icons are 1.75 stroke; only the selected/primary state gets a filled tile.
 *
 * Terminology (kept identical on Flutter — see `loan_emi_ui.dart`):
 *   Loan — money borrowed from a bank, lender or person.
 *   EMI  — installment-based finance: a product purchase, a Credit Card EMI, store finance.
 */
export const LOAN_ICON: LucideIcon = Landmark;
export const EMI_ICON: LucideIcon = ShoppingBag;

export const KIND_COPY = {
  loan: { label: "Loan", plural: "Loans", description: "A loan you took or gave to someone." },
  emi: { label: "EMI", plural: "EMIs", description: "A purchase or borrowing repaid in installments." },
} as const;

/** Loan & EMI radius hierarchy: inputs < options < cards < panels. Literal classes so Tailwind sees them. */
export const LE_RADIUS = {
  input: "rounded-[6px]",
  control: "rounded-[6px]",
  card: "rounded-[8px]",
  panel: "rounded-[10px]",
} as const;

/** Selected-option treatment shared by every choice control. */
const SELECTED = "border-primary-accent-text bg-primary text-primary-foreground";
const UNSELECTED = "border-border-strong bg-card text-foreground hover:border-muted-foreground hover:bg-secondary";

/** Border/fill/text classes for a selectable option button, selected or not. */
export function choiceClass(active: boolean): string {
  return active ? cn(SELECTED, "font-semibold") : cn(UNSELECTED, "font-medium");
}

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

/* ───────────────────────── Money ───────────────────────── */

// Same options as `formatCurrency` (lib/format.ts) — split into parts only so the ₹ and any decimals can
// be sized separately from the digits. The rendered figure is identical to `formatCurrency(amount)`.
const MONEY_FORMAT = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/**
 * A monetary figure in the Loan & EMI financial style: bold heading face, tabular digits, a slightly
 * smaller solid-grey ₹ so the digits carry the weight. Inherits font size from `className`.
 */
export function Money({ amount, className }: { amount: number; className?: string }) {
  const parts = MONEY_FORMAT.formatToParts(amount);
  return (
    <span className={cn("inline-flex items-baseline font-heading font-bold tracking-tight whitespace-nowrap tabular-nums", className)}>
      {parts.map((p, i) =>
        p.type === "currency" ? (
          <span key={i} className="mr-[0.08em] text-[0.72em] font-semibold text-muted-foreground">
            {p.value}
          </span>
        ) : p.type === "fraction" || p.type === "decimal" ? (
          <span key={i} className="text-[0.7em]">
            {p.value}
          </span>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </span>
  );
}

/** The remaining-balance figure — the one number every Loan/EMI surface leads with. */
export function AmountDisplay({ amount, size = "md", className }: { amount: number; size?: "md" | "lg"; className?: string }) {
  return (
    <Money
      amount={amount}
      className={cn("leading-none text-foreground", size === "md" ? "text-[26px]" : "text-[32px] sm:text-[38px]", className)}
    />
  );
}

/** Small uppercase label above a figure. */
function FigureLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{children}</span>;
}

/* ───────────────────────── Progress ───────────────────────── */

/** Installment progress bar — dark olive on light, lime on dark (via `primary-accent-text`), on a solid
 *  `border`-grey track so the empty part stays visible on washed-out displays. */
export function InstallmentProgress({ paid, total, className }: { paid: number; total: number; className?: string }) {
  const percent = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div
        className="h-1.5 w-full overflow-hidden rounded-[2px] bg-border"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={paid}
        aria-label={`${paid} of ${total} installments paid`}
      >
        <div className="h-full rounded-[2px] bg-primary-accent-text transition-[width] duration-700 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground tabular-nums">
          {paid} of {total} paid
        </span>
        <span className="text-muted-foreground tabular-nums">{Math.max(total - paid, 0)} left</span>
      </div>
    </div>
  );
}

/* ───────────────────────── Record card ───────────────────────── */

export interface DebtCardBadge {
  label: string;
  tone: "neutral" | "primary" | "success" | "expense" | "warning";
}

export interface DebtCardProps {
  icon: LucideIcon;
  name: string;
  /** Lender / source line under the name. */
  source: string;
  /** Small record-type tag before the source — "Bank Loan", "Credit Card EMI", … */
  tag?: string;
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

/**
 * The Loan/EMI list card. Icon + name + status → outstanding (largest) → "₹X / month · Due …" → progress →
 * linked records. A defined white surface with a solid border; hover lifts the border and shadow slightly.
 */
export function DebtCard({
  icon: Icon,
  name,
  source,
  tag,
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
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        className={cn(
          LE_RADIUS.card,
          "group flex h-full cursor-pointer flex-col gap-3.5 border border-border bg-card px-4 py-4 shadow-e1 outline-none",
          "transition-[border-color,box-shadow,transform] duration-150 ease-out hover:border-border-strong hover:shadow-e2 motion-safe:hover:-translate-y-px",
          "focus-visible:border-primary-accent-text focus-visible:ring-2 focus-visible:ring-ring",
          muted && "bg-secondary",
        )}
      >
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
          <span className={cn(LE_RADIUS.control, "flex size-9 shrink-0 items-center justify-center border border-border bg-secondary text-foreground")}>
            <Icon className="size-[18px]" strokeWidth={1.75} />
          </span>
          {/* min-w keeps the name readable: a status badge that doesn't fit beside it drops below instead of squeezing it to "L…". */}
          <div className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
            <h3 className={cn("truncate font-heading text-[15px] leading-snug font-semibold", muted ? "text-muted-foreground" : "text-foreground")}>{name}</h3>
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {tag && (
                <span className="shrink-0 rounded-[4px] border border-border bg-secondary px-1.5 py-px text-[10.5px] font-medium text-foreground">
                  {tag}
                </span>
              )}
              <span className="truncate">{source}</span>
            </p>
          </div>
          {badges.length > 0 ? (
            <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
              {badges.map((b) => (
                <ClayBadge key={b.label} tone={b.tone} className="rounded-[5px] px-2 py-0.5 text-[11px] font-semibold">
                  {b.label}
                </ClayBadge>
              ))}
            </div>
          ) : (
            <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground" />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <FigureLabel>{outstandingLabel}</FigureLabel>
          <AmountDisplay amount={outstanding} className={cn(muted && "text-muted-foreground")} />
          {nextDate && nextAmount != null && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
              <span className="font-semibold text-foreground">
                <Money amount={nextAmount} />
                {cadence ? <span className="font-normal text-muted-foreground"> / {cadence}</span> : null}
              </span>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <span className={cn("font-medium", overdue ? "font-semibold text-expense" : "text-muted-foreground")}>
                {overdue ? dueLabel(nextDate) : `Due ${formatDueDate(nextDate)}`}
              </span>
            </div>
          )}
        </div>

        {total > 1 && <InstallmentProgress paid={paid} total={total} />}

        {links.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2.5">
            {links.map(({ icon: LinkIcon, label }) => (
              <span key={label} className="inline-flex max-w-full items-center gap-1 text-xs font-medium text-muted-foreground">
                <LinkIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{label}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </StaggerItem>
  );
}

/* ───────────────────────── Detail views ───────────────────────── */

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
        <div className="flex flex-col gap-1.5">
          <FigureLabel>{label}</FigureLabel>
          <AmountDisplay amount={amount} size="lg" />
        </div>
        {badges.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1">
            {badges.map((b) => (
              <ClayBadge key={b.label} tone={b.tone} className="rounded-[5px] font-semibold">
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
  // Pad the last row with blank cells so the grid's divider background never shows through as a grey block.
  const fill2 = (2 - (visible.length % 2)) % 2;
  const fill3 = (3 - (visible.length % 3)) % 3;
  const fillers = Array.from({ length: Math.max(fill2, fill3) }, (_, i) =>
    cn("bg-card", i < fill2 ? "block" : "hidden", i < fill3 ? "sm:block" : "sm:hidden"),
  );
  return (
    <dl className={cn(LE_RADIUS.card, "grid grid-cols-2 gap-px overflow-hidden border border-border bg-border sm:grid-cols-3", className)}>
      {visible.map((f) => (
        <div key={f.label} className="flex min-w-0 flex-col gap-0.5 bg-card px-3.5 py-3">
          <dt className="truncate text-[11px] font-medium text-muted-foreground">{f.label}</dt>
          <dd
            className={cn(
              "truncate text-sm font-medium text-foreground tabular-nums",
              f.strong && "font-heading text-base font-semibold",
              f.tone === "expense" && "text-expense",
            )}
          >
            {f.value}
          </dd>
        </div>
      ))}
      {fillers.map((cls, i) => (
        <div key={`filler-${i}`} aria-hidden className={cls} />
      ))}
    </dl>
  );
}

/** A linked record row (Account / Credit Card / Person) with an optional link out to its own section. */
export function LinkedRow({ icon: Icon, label, value, action }: { icon: LucideIcon; label: string; value: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span className={cn(LE_RADIUS.control, "flex size-8 shrink-0 items-center justify-center border border-border bg-secondary text-muted-foreground")}>
        <Icon className="size-4" strokeWidth={1.75} />
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
  return <div className={cn(LE_RADIUS.card, "flex flex-col divide-y divide-border overflow-hidden border border-border bg-card")}>{children}</div>;
}

/** Small uppercase heading for a detail-view section. */
export function DetailSectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold tracking-[0.06em] text-foreground uppercase">{children}</h3>
      {aside}
    </div>
  );
}

/* ───────────────────────── Form system ───────────────────────── */

/** Mount transition for conditionally revealed fields — a short fade + 4px slide (none under reduced motion). */
export function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out", className)}>{children}</div>;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Optional trailing count. */
  count?: number;
}

/** Radio indicator for a choice option — hollow ring when off, dark ring with a filled centre when on. A shape
 *  cue, so the selected option is recognisable even where fills and greys are indistinguishable. */
export function RadioDot({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors duration-150",
        checked ? "border-primary-foreground bg-primary-foreground" : "border-border-strong bg-card",
        className,
      )}
    >
      {checked && <span className="size-1.5 rounded-full bg-primary" />}
    </span>
  );
}

/**
 * Segmented choice — separate bordered option buttons (not a tinted track), each with a radio indicator.
 * Selected = lime fill + 2px dark edge + filled radio + bold text: four independent signals, so it still
 * reads correctly on displays where grey and white look the same.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  role = "radiogroup",
  size = "md",
  fullWidth = false,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  /** "tablist" when it switches views, "radiogroup" when it's a form choice. */
  role?: "radiogroup" | "tablist";
  size?: "sm" | "md";
  /** Keep each option within the available field width instead of sizing to its label. */
  fullWidth?: boolean;
  className?: string;
}) {
  return (
    <div role={role} aria-label={ariaLabel} className={cn("flex w-full gap-1.5 sm:self-start", fullWidth ? "sm:w-full" : "sm:w-auto", className)}>
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
              LE_RADIUS.input,
              "flex min-w-0 flex-1 items-center justify-center gap-2 border whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              fullWidth ? "sm:flex-1" : "sm:flex-none",
              size === "md" ? "min-h-10 px-3.5 text-sm" : "min-h-9 px-3 text-[13px]",
              choiceClass(active),
            )}
          >
            <RadioDot checked={active} />
            {Icon && <Icon className="size-4 shrink-0" />}
            <span className="truncate">{label}</span>
            {count != null && (
              <span className={cn("rounded-[4px] border px-1.5 text-[11px] tabular-nums", active ? "border-primary-foreground" : "border-border-strong")}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A small view filter — "All 12 · Upcoming 7 · Paid 5" — for switching a list, not making a form choice.
 * One light track with text segments (no icons, no radio dots): the selected segment gets the lime fill,
 * dark edge and semibold weight, so it still reads on low-contrast displays. 32px segments keep it tappable.
 */
export function FilterTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn("inline-flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-[7px] border border-border bg-secondary p-0.5", className)}>
      {options.map(({ value: v, label, count }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(v)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[5px] border px-2.5 text-[13px] whitespace-nowrap transition-[background-color,border-color,color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-primary-accent-text bg-primary font-semibold text-primary-foreground"
                : "border-transparent font-medium text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            {label}
            {count != null && <span className={cn("text-xs tabular-nums", active ? "font-semibold" : "font-normal")}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Wrapping chip choices (filters, types) — square-cornered buttons with the same selected treatment. */
export function ChoiceChips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              LE_RADIUS.input,
              "inline-flex h-8 items-center gap-1 border px-2.5 text-xs transition-[background-color,border-color,color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? cn(SELECTED, "font-semibold") : cn(UNSELECTED, "font-medium"),
            )}
          >
            {active && <Check className="size-3.5" strokeWidth={2.5} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A titled group of form fields. Hierarchy comes from type and the dialog's section dividers, not boxes. */
export function FormSection({
  title,
  description,
  icon: Icon,
  aside,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** Right-aligned summary next to the title (e.g. the installment preview). */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
          <h3 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">{title}</h3>
          {description && <span className="truncate text-xs text-muted-foreground">{description}</span>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Progressive disclosure for genuinely secondary fields. Closed by default for a new record; a bordered
 * button (not a text link) with the contents summarised inline.
 */
export function MoreOptions({
  summary,
  title = "Optional details",
  defaultOpen = false,
  children,
}: {
  summary: string;
  title?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Only a user click scrolls — a form that opens pre-expanded (edit mode) must not jump.
  const scrollOnOpen = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || !scrollOnOpen.current) return;
    scrollOnOpen.current = false;
    // Wait a frame so the revealed fields have laid out inside the dialog's scroll area.
    const id = requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    return () => cancelAnimationFrame(id);
  }, [open]);
  return (
    <section ref={sectionRef} className="flex flex-col gap-4">
      <button
        type="button"
        onClick={() => {
          scrollOnOpen.current = !open;
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        className={cn(
          LE_RADIUS.control,
          "group flex h-11 items-center justify-between gap-3 border px-3.5 text-left transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open ? "border-border-strong bg-secondary" : "border-border-strong bg-card hover:bg-secondary",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium text-foreground">{title}</span>
          <span className="truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} strokeWidth={1.75} />
      </button>
      {open && <Reveal className="flex flex-col gap-4">{children}</Reveal>}
    </section>
  );
}

/** Label + input wrapper with solid, readable label contrast. */
export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-foreground">{label}</span>
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
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Optional contextual block with a checkbox — "Add money to an account", "Has interest?". Off: one bordered
 * row. On: a dark olive/lime edge and its fields revealed below — no pale lime wash.
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
        LE_RADIUS.card,
        "flex flex-col overflow-hidden border bg-card transition-[border-color,box-shadow] duration-150",
        checked ? "border-primary-accent-text" : "border-border hover:border-border-strong hover:bg-secondary",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="group/reveal flex items-center gap-3 px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Icon && (
          <span
            className={cn(
              LE_RADIUS.control,
              "flex size-8 shrink-0 items-center justify-center border transition-colors duration-150",
              checked ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-secondary text-muted-foreground",
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {description && <span className="text-xs text-muted-foreground">{description}</span>}
        </span>
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] transition-colors duration-150",
            checked ? "border-primary-accent-text bg-primary text-primary-foreground" : "border-border-strong bg-card",
          )}
        >
          {checked && <Check className="size-3.5" strokeWidth={2.5} />}
        </span>
      </button>
      {children && checked && <Reveal className="flex flex-col gap-3 border-t border-border px-3.5 pt-3.5 pb-3.5">{children}</Reveal>}
    </div>
  );
}

/** Amount input — a ₹ prefix block and a large bold tabular figure, so the money reads as the key field. */
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
    <div
      className={cn(
        LE_RADIUS.input,
        "flex h-11 w-full min-w-0 items-stretch overflow-hidden border border-border-strong bg-card transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground dark:bg-input",
        "focus-within:border-primary-accent-text focus-within:ring-2 focus-within:ring-ring",
      )}
    >
      <span className="flex w-9 shrink-0 items-center justify-center border-r border-border bg-secondary font-heading text-base font-semibold text-muted-foreground">
        ₹
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        autoFocus={autoFocus}
        className="w-full min-w-0 bg-transparent px-3 font-heading text-xl font-bold tracking-tight text-foreground tabular-nums outline-none placeholder:font-semibold placeholder:text-tertiary-foreground"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Input class for the Loan & EMI forms — solid control border, small radius, clear focus edge. */
export const LOAN_EMI_INPUT =
  "h-10 w-full min-w-0 rounded-[6px] border border-border-strong bg-card px-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-tertiary-foreground hover:border-muted-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring disabled:bg-secondary disabled:text-muted-foreground dark:bg-input";

/**
 * The focused creation/edit dialog for Loans and EMIs: one defined surface — header, a scrolling body whose
 * sections are split by solid dividers, and a footer with the single primary CTA. A centered panel on
 * desktop; a full-height sheet on phones.
 *
 * While `loading`/`success` the surface locks: the body is inert (entered values are kept, not editable),
 * Cancel/close and the primary action are disabled. `operation` (from `useOperation()`) renders the shared
 * percentage progress next to the action; after a failure it stays, with "Try again" re-running `onConfirm`.
 */
export function LoanEmiFormDialog({
  open,
  onOpenChange,
  title,
  description,
  icon: Icon,
  children,
  onConfirm,
  onEnter,
  confirmLabel,
  loading = false,
  confirmDisabled = false,
  success = false,
  operation = null,
  cancelLabel = "Cancel",
  size = "default",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  onConfirm: () => void;
  /** What Enter in a field runs — defaults to `onConfirm`. Set when the primary action navigates away (e.g. a
   *  settle-first gate) so a stray Enter only focuses the next step instead of leaving the dialog. */
  onEnter?: () => void;
  confirmLabel: string;
  loading?: boolean;
  /** Blocks the primary action (e.g. nothing valid to submit yet) without the loading state. */
  confirmDisabled?: boolean;
  /** Brief post-save confirmation: the primary button turns into a check + label before the dialog closes. */
  success?: boolean;
  /** The running — or just failed / succeeded — write, from `useOperation()`. */
  operation?: OperationSnapshot | null;
  cancelLabel?: string;
  /** "compact" — a narrower panel for focused actions such as Record Payment. */
  size?: "default" | "compact";
}) {
  const busy = loading || success;
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        // Enter in any single-line field runs the same primary action as the button (not while busy / invalid).
        onKeyDown={(e) => handleEnterKey(e, onEnter ?? onConfirm, { enabled: !busy && !confirmDisabled })}
        className={cn(
          "flex flex-col gap-0 overflow-hidden border border-border bg-card p-0 shadow-[var(--shadow-e4)] ring-0",
          // Phone: full-height sheet. Desktop: centered panel.
          "top-0 left-0 h-[100dvh] max-h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none",
          "sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[min(90vh,52rem)]",
          size === "compact" ? "sm:max-w-lg" : "sm:max-w-2xl",
          "sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[10px]",
        )}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-5 py-3.5 sm:px-6">
          {Icon && (
            <span className={cn(LE_RADIUS.control, "flex size-9 shrink-0 items-center justify-center bg-primary text-primary-foreground")}>
              <Icon className="size-[18px]" strokeWidth={2} />
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="font-heading text-lg leading-tight font-semibold tracking-tight">{title}</DialogTitle>
            <DialogDescription className={description ? "truncate text-xs text-muted-foreground" : "sr-only"}>{description ?? title}</DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            disabled={busy}
            className={cn(
              LE_RADIUS.control,
              "flex size-8 shrink-0 items-center justify-center border border-transparent text-muted-foreground outline-none transition-colors duration-150 hover:border-border hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            )}
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        <div
          inert={busy}
          aria-busy={busy}
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto bg-card px-5 py-5 text-sm transition-opacity duration-150 sm:px-6 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-5",
            busy && "opacity-70",
          )}
        >
          {children}
        </div>

        {operation && (
          <div className="shrink-0 border-t border-border bg-card px-5 py-3 animate-in fade-in-0 duration-150 sm:px-6">
            {/* A failure's retry is the dialog's current action, so it runs with whatever is entered now. */}
            <OperationProgressView snapshot={operation.retry ? { ...operation, retry: onConfirm } : operation} />
          </div>
        )}

        <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-border bg-secondary px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-3">
          <ClayButton variant="secondary" className="rounded-[6px] border-border-strong font-medium" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </ClayButton>
          <ClayButton
            variant="primary"
            className={cn(
              "min-w-32 flex-1 gap-1.5 rounded-[6px] border-primary-accent-text font-semibold transition-[background-color,opacity] duration-200 sm:flex-none",
              // Success keeps full opacity (it's a confirmation, not a disabled state).
              success && "disabled:opacity-100",
            )}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            aria-busy={loading}
          >
            {success ? (
              <>
                <Check className="size-4 animate-in zoom-in-50 fade-in-0 duration-200" strokeWidth={3} />
                Done
              </>
            ) : loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {confirmLabel}
              </>
            ) : (
              confirmLabel
            )}
          </ClayButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
