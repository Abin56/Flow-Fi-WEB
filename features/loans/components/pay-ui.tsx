"use client";

import { ChevronDown } from "lucide-react";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { cn } from "@/lib/utils";

/**
 * The payment popup's own building blocks (Record Payment, over the Loan & EMI workspace). Presentation only: they hold no
 * payment state and call nothing — every value and handler is passed in by the dialog. One visual language: hairline
 * cards on a quiet surface, 11px caps labels, 36px controls, tabular figures, the workspace's lime for the one primary
 * thing at a time.
 */

/** Compact control — 36px, the workspace's solid border and lime focus edge. */
export const PAY_INPUT =
  "h-9 w-full min-w-0 rounded-[6px] border border-border-strong bg-card px-2.5 text-[13px] text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-tertiary-foreground hover:border-muted-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring disabled:bg-secondary disabled:text-muted-foreground dark:bg-input";

export const PAY_LABEL = "text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase";

/** A titled card: caps label on the left, an optional aside (a total, a status) on the right, then the content. */
export function PayCard({
  title,
  aside,
  children,
  className,
  testId,
  tone = "plain",
}: {
  title?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  /** "people" tints the card so money coming FROM a person reads apart from the payment TO the bank. */
  tone?: "plain" | "people";
}) {
  return (
    <section data-testid={testId} className={cn("overflow-hidden rounded-[10px] border bg-card shadow-e1", tone === "people" ? "border-settle-receivable-text/25" : "border-border", className)}>
      {(title != null || aside != null) && (
        <header className={cn("flex items-center justify-between gap-3 border-b px-3 py-1.5", tone === "people" ? "border-settle-receivable-text/20 bg-settle-receivable-tint/40" : "border-border bg-secondary/50")}>
          <h3 className={PAY_LABEL}>{title}</h3>
          {aside != null && <div className="min-w-0 truncate text-xs text-muted-foreground">{aside}</div>}
        </header>
      )}
      <div className="flex flex-col gap-2.5 p-3">{children}</div>
    </section>
  );
}

/** A label over its control — 11px, never a roomy block. */
export function PayField({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-semibold text-foreground/80">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A non-label wrapper for a row of buttons (a label around buttons would forward clicks to the first). */
export function PayGroup({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-semibold text-foreground/80">{label}</span>
      {children}
    </div>
  );
}

/**
 * One selectable amount — a tile, not a form row: the label and its figure on one line, the hint (one line, full text on hover)
 * beneath. Selected = the workspace's lime edge and wash. Radio semantics kept (`role="radio"`).
 */
export function AmountTile({ active, label, hint, amount, onSelect }: { active: boolean; label: string; hint?: string; amount?: number; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      title={hint ? `${label} — ${hint}` : label}
      className={cn(
        "group relative flex min-w-0 flex-1 basis-[11.5rem] flex-col gap-0.5 rounded-[8px] border px-3 py-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary-accent-text bg-primary/15 shadow-[inset_0_0_0_1px_var(--color-primary-accent-text)]" : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary/60",
      )}
    >
      <span className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors", active ? "border-primary-accent-text bg-primary-accent-text" : "border-border-strong")}>
            {active && <span className="size-1 rounded-full bg-card" />}
          </span>
          <span className="truncate text-[13px] font-semibold text-foreground">{label}</span>
        </span>
        {amount != null && <Money exact amount={amount} className="shrink-0 text-[13px] text-foreground" />}
      </span>
      {hint && <span className="line-clamp-2 pl-5 text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </button>
  );
}

/** A compact ₹ amount input (36px) — same `type="number"` field as the old one, in the popup's scale. */
export function PayAmountInput({ value, onChange, autoFocus, ariaLabel }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; ariaLabel?: string }) {
  return (
    <div className="flex h-10 w-full min-w-0 items-stretch overflow-hidden rounded-[6px] border border-border-strong bg-card transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground focus-within:border-primary-accent-text focus-within:ring-2 focus-within:ring-ring dark:bg-input">
      <span className="flex w-8 shrink-0 items-center justify-center border-r border-border bg-secondary font-heading text-sm font-semibold text-muted-foreground">₹</span>
      <input
        type="number"
        inputMode="decimal"
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className="w-full min-w-0 bg-transparent px-2.5 font-heading text-base font-bold tracking-tight text-foreground tabular-nums outline-none placeholder:font-semibold placeholder:text-tertiary-foreground"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** A segmented pair/trio of choices in one line (36px → 32px), used for EMI funding and the extra-amount treatment. */
export function PaySegmented<T extends string>({ options, value, onChange, ariaLabel, wrapLabels = false }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; ariaLabel: string; wrapLabels?: boolean }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-[8px] border border-border bg-secondary p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "min-w-0 rounded-[6px] px-2.5 text-xs font-semibold outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
              wrapLabels ? "min-h-8 py-1 leading-tight [overflow-wrap:anywhere]" : "h-8 truncate",
              on ? "bg-card text-foreground shadow-e1 ring-1 ring-primary-accent-text" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** One line of the receipt: label left, figure right. */
export function ReceiptLine({ label, children, tone, strong }: { label: React.ReactNode; children: React.ReactNode; tone?: "good" | "bad"; strong?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs", strong && "text-[13px]")}>
      <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{label}</span>
      <span className={cn("ml-auto text-right font-semibold tabular-nums", tone === "good" ? "text-success" : tone === "bad" ? "text-expense" : "text-foreground")}>{children}</span>
    </div>
  );
}

/** "Note, GST, fees" and the like — closed by default, no state to hold. */
export function PayMore({ title, summary, children, testId }: { title: string; summary?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <details data-testid={testId} className="group rounded-[10px] border border-border bg-card shadow-e1">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-foreground outline-none marker:hidden hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {title}
        <span className="flex-1" aria-hidden />
        {summary != null && <span className="max-w-[60%] truncate font-normal text-muted-foreground group-open:hidden">{summary}</span>}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="grid grid-cols-1 gap-2.5 border-t border-border p-3 @md:grid-cols-2">{children}</div>
    </details>
  );
}

/** Step heading inside a merged card: a numbered dot, the label, and what is chosen so far on the right. */
export function PayStepHead({ n, label, value }: { n: number; label: string; value?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground tabular-nums">
        {n}
      </span>
      <span className={PAY_LABEL}>{label}</span>
      {value != null && <span className="ml-auto min-w-0 truncate text-xs font-medium text-foreground/70">{value}</span>}
    </div>
  );
}
