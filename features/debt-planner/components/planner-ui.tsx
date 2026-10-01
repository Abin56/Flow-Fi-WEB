"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { LE_RADIUS, Money } from "@/features/loans/components/loan-emi-ui";
import { cn } from "@/lib/utils";

/**
 * Debt Planner presentation primitives. Structure comes from sections, alignment and rules first; a full
 * bordered surface (`Panel`) is kept for interactive workspaces, comparisons and warnings only. Purely
 * visual: every number passed in comes from the planner engine via the hooks.
 *
 * Contrast (tuned for low-contrast FHD panels): separators use `border-border` (~#BEBEBA) or stronger,
 * secondary text is `text-foreground/75` or stronger, never a faint grey; state colour is always paired
 * with a word and an icon.
 */

export { Money };

export function Panel({ children, className, as: Tag = "section", ...rest }: { children: React.ReactNode; className?: string; as?: "section" | "div"; "aria-labelledby"?: string }) {
  return (
    <Tag className={cn(LE_RADIUS.panel, "border border-border bg-card", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function PanelHeader({ id, title, subtitle, aside, className }: { id?: string; title: string; subtitle?: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5", className)}>
      <div className="min-w-0">
        <h2 id={id} className="font-heading text-[15px] leading-tight font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-foreground/75">{subtitle}</p>}
      </div>
      {aside}
    </div>
  );
}

/**
 * An unboxed page section: an uppercase eyebrow title on a firm rule, then content. Used wherever a
 * container would only add another rectangle.
 */
export function Section({
  id,
  title,
  hint,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  hint?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b border-border-strong pb-2">
        <div className="min-w-0">
          <h2 id={id} className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">
            {title}
          </h2>
          {hint && <p className="mt-0.5 text-xs text-foreground/75">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("text-[11px] font-semibold tracking-[0.06em] text-foreground/75 uppercase", className)}>{children}</span>;
}

export type Tone = "neutral" | "expense" | "warning" | "success" | "primary";

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-foreground",
  expense: "text-expense",
  warning: "text-foreground",
  success: "text-success",
  primary: "text-foreground",
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-border-strong bg-secondary text-foreground",
  expense: "border-expense/60 bg-expense/10 text-expense",
  warning: "border-warning bg-warning/20 text-foreground",
  success: "border-success/60 bg-success/12 text-success",
  primary: "border-primary-accent-text bg-primary text-primary-foreground",
};

/** A key figure: label, then the figure, then an optional note. */
export function Stat({ label, amount, value, note, tone = "neutral", icon: Icon, className, size = "md" }: {
  label: string;
  amount?: number;
  value?: React.ReactNode;
  note?: React.ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  className?: string;
  size?: "md" | "sm";
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <Label className="inline-flex items-center gap-1.5">
        {Icon && <Icon className={cn("size-3.5", tone === "neutral" ? "text-foreground/75" : TONE_TEXT[tone])} strokeWidth={2} />}
        {label}
      </Label>
      <div className={cn("leading-tight font-bold tabular-nums", size === "md" ? "text-[20px]" : "text-[16px]", TONE_TEXT[tone])}>
        {amount != null ? <Money amount={amount} /> : value}
      </div>
      {note && <div className="text-xs text-foreground/75">{note}</div>}
    </div>
  );
}

export function Chip({ tone = "neutral", icon: Icon, children, className }: { tone?: Tone; icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-[5px] border px-2 text-[11.5px] font-semibold whitespace-nowrap", TONE_CHIP[tone], className)}>
      {Icon && <Icon className="size-3.5" strokeWidth={2.25} />}
      {children}
    </span>
  );
}

/** A compact in-place disclosure — the trigger is a real button with a visible chevron. */
export function Explain({ label = "How is this calculated?", children, className, defaultOpen = false }: { label?: React.ReactNode; children: React.ReactNode; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-[4px] text-xs font-semibold text-foreground underline decoration-border-strong underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} strokeWidth={2.25} />
      </button>
      {open && (
        <div id={id} className="mt-2 animate-in duration-200 fade-in-0 slide-in-from-top-1">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A full-width collapsible block (Data quality, How this is calculated): a header row with title, a
 * summary on the right, and a chevron. Collapsed by default — these are diagnostics, not the plan.
 */
export function Disclosure({ title, summary, icon: Icon, children, defaultOpen = false }: { title: string; summary?: React.ReactNode; icon?: LucideIcon; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="border-b border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 py-3 text-left outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Icon && <Icon className="size-4 shrink-0 text-foreground/80" strokeWidth={2} />}
        <span className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">{title}</span>
        <span className="ml-auto text-xs font-medium text-foreground/80">{summary}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-foreground/80 transition-transform duration-200", open && "rotate-180")} strokeWidth={2.25} />
      </button>
      {open && (
        <div id={id} className="pb-4 animate-in duration-200 fade-in-0 slide-in-from-top-1">
          {children}
        </div>
      )}
    </div>
  );
}

/** A two-column figure list with an optional total line — the body of every explanation. */
export function Breakdown({ rows, total, className }: { rows: { label: React.ReactNode; amount: number; note?: React.ReactNode; tone?: Tone }[]; total?: { label: string; amount: number }; className?: string }) {
  return (
    <dl className={cn("text-[13px]", className)}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 border-b border-border/70 py-1.5 last:border-b-0">
          <dt className="min-w-0 text-foreground">
            {r.label}
            {r.note && <span className="ml-1.5 text-xs text-foreground/75">{r.note}</span>}
          </dt>
          <dd className={cn("shrink-0 font-semibold tabular-nums", r.tone ? TONE_TEXT[r.tone] : "text-foreground")}>
            <Money amount={r.amount} />
          </dd>
        </div>
      ))}
      {total && (
        <div className="flex items-baseline justify-between gap-3 border-t-2 border-border-strong pt-1.5">
          <dt className="font-semibold text-foreground">{total.label}</dt>
          <dd className="font-bold text-foreground tabular-nums">
            <Money amount={total.amount} />
          </dd>
        </div>
      )}
    </dl>
  );
}

/** "₹ [ 5000 ]" — a planning amount. Never saved anywhere but this browser. */
export function PlanAmountInput({ value, onChange, label, className, id, size = "md" }: { value: string; onChange: (v: string) => void; label: string; className?: string; id?: string; size?: "md" | "lg" }) {
  return (
    <div className={cn("relative", className)}>
      <span className={cn("pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-semibold text-foreground/75", size === "lg" ? "text-[18px]" : "text-[15px]")}>₹</span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="100"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          LE_RADIUS.input,
          "w-full border border-border-strong bg-card pr-3 font-bold text-foreground tabular-nums outline-none transition-colors [appearance:textfield] hover:border-muted-foreground focus:border-primary-accent-text focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          size === "lg" ? "h-12 pl-8 text-[22px]" : "h-10 pl-8 text-lg",
        )}
      />
    </div>
  );
}

/** A compact preset button (budget presets, scenario picks). */
export function PresetButton({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 rounded-[5px] border px-2.5 text-xs font-semibold tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary-accent-text bg-primary text-primary-foreground" : "border-border-strong bg-card text-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}
