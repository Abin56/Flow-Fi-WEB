"use client";

import { ArrowLeft, Check, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared presentation for the Person workspace modes (Add, Settle, Split, Share, Edit) — one header,
 * one choice card, one segmented control, one field style, one sticky action bar — so every mode reads
 * as part of the same surface. One size scale: 36px controls, 11px labels, 6px radius, 1px borders.
 * Visual only; follows the Loan & EMI radius/border rules (`loan-emi-ui.tsx`).
 */

export const WS_FIELD =
  "h-9 w-full rounded-[6px] border border-border-strong bg-card px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-muted-foreground focus:border-primary-accent-text focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-expense";

export const WS_SELECT_TRIGGER =
  "h-9 w-full rounded-[6px] border-border-strong bg-card px-3 text-sm shadow-none hover:border-muted-foreground focus-visible:border-primary-accent-text aria-invalid:border-expense dark:bg-card";

export const WS_PRIMARY =
  "flex h-9 items-center justify-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export const WS_SECONDARY =
  "flex h-9 items-center justify-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export const WS_GHOST =
  "flex h-9 items-center justify-center gap-1.5 rounded-[6px] px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/**
 * "× Close" — the one way out of a People workflow (Add, Settle, Split, Share), always top-right. A
 * neutral bordered button: clearly a control, never the lime of a financial action.
 */
export function WsCloseButton({ onClick, label = "Close", className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <X className="size-4 text-muted-foreground" strokeWidth={1.75} />
      Close
    </button>
  );
}

/** Content-area padding shared by every mode, so switching modes never shifts the edges. */
export const WS_PAD = "px-4 sm:px-7";

/** Small uppercase section label. */
export function WsLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase", className)}>{children}</p>;
}

/**
 * "← Tripthee" + mode title + one line of context. With `onClose` (a popup), the back link gives way to
 * the standard "× Close" at the top-right, beside the title.
 */
export function ModeHeader({
  backLabel,
  onBack,
  onClose,
  title,
  subtitle,
}: {
  backLabel: string;
  onBack: () => void;
  onClose?: () => void;
  title: string;
  subtitle?: React.ReactNode;
}) {
  if (onClose) {
    return (
      <div className={cn(WS_PAD, "flex items-start justify-between gap-4 border-b border-border-strong/60 pt-4 pb-3.5 sm:pt-5")}>
        <div className="min-w-0">
          <h2 className="font-heading text-lg leading-tight font-semibold tracking-tight text-foreground sm:text-xl">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>}
        </div>
        <WsCloseButton onClick={onClose} />
      </div>
    );
  }
  return (
    <div className={cn(WS_PAD, "pt-4 sm:pt-5")}>
      <button
        type="button"
        onClick={onBack}
        className="-ml-1.5 flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        {backLabel}
      </button>
      <h2 className="mt-1.5 font-heading text-lg leading-tight font-semibold tracking-tight text-foreground sm:text-xl">{title}</h2>
      {subtitle && <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

/** A selectable finance option — lime edge + check when chosen, never tint alone. */
export function ChoiceCard({
  selected,
  onSelect,
  icon: Icon,
  iconClassName,
  title,
  description,
  aside,
  role = "radio",
}: {
  selected: boolean;
  onSelect: () => void;
  icon?: LucideIcon;
  iconClassName?: string;
  title: string;
  description?: string;
  aside?: React.ReactNode;
  role?: "radio" | "button";
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "radio" ? selected : undefined}
      onClick={onSelect}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-[6px] border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary-accent-text bg-primary/10 shadow-[inset_0_0_0_1px_var(--color-primary-accent-text)]"
          : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary/60",
      )}
    >
      {Icon && (
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-secondary text-muted-foreground", iconClassName)}>
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-sm text-foreground", selected ? "font-semibold" : "font-medium")}>{title}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </span>
      {aside}
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-primary-accent-text bg-primary text-primary-foreground" : "border-border-strong",
        )}
      >
        {selected && <Check className="size-2.5" strokeWidth={3} />}
      </span>
    </button>
  );
}

/**
 * Compact segmented selector — equal-width options in one 40px strip. The chosen option gets a card
 * surface, a lime inset edge, bold text and a check, so it reads on low-contrast screens without colour.
 */
export function WsSegmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: LucideIcon; meta?: React.ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("grid auto-cols-fr grid-flow-col gap-1 rounded-[8px] border border-border-strong bg-secondary/60 p-[3px]", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = active ? Check : o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-[6px] px-2 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:text-[13px]",
              active
                ? "bg-card font-semibold text-foreground shadow-[inset_0_0_0_1.5px_var(--color-primary-accent-text)]"
                : "font-medium text-muted-foreground hover:bg-card/60 hover:text-foreground",
            )}
          >
            {Icon && (
              <Icon
                className={cn("size-3.5 shrink-0", active ? "text-primary-accent-text" : "hidden sm:block")}
                strokeWidth={active ? 2.5 : 1.75}
                aria-hidden
              />
            )}
            <span className="truncate">{o.label}</span>
            {o.meta != null && <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{o.meta}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled field with an optional inline error right under it. */
export function WsField({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string | null;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? <span className="text-xs font-medium text-expense">{error}</span> : hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** The "₹ 0" amount entry — the primary value of a money form. */
export function MoneyInput({
  value,
  onChange,
  invalid,
  autoFocus,
  label,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  autoFocus?: boolean;
  label: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-1 border-b-2 pb-1 transition-colors focus-within:border-primary-accent-text",
        invalid ? "border-expense" : "border-border-strong",
      )}
    >
      <span className="font-heading text-xl font-semibold text-muted-foreground">₹</span>
      <input
        ref={inputRef}
        type="number"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 bg-transparent font-heading text-[28px] leading-tight font-bold tracking-tight text-foreground tabular-nums outline-none placeholder:text-muted-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  );
}

/** Sticky bottom action bar — stays reachable however long the mode's content is. */
export function ModeFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        WS_PAD,
        "sticky bottom-0 z-10 mt-6 flex items-center justify-end gap-2 border-t border-border bg-card py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      {children}
    </div>
  );
}
