"use client";

/** Small presentational pieces shared by the Savings workspace — no data, no money logic. */

import { CheckCircle2, CircleDashed, CircleDot, CircleSlash, MinusCircle, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PlanCycleStatus } from "@/lib/engines/savings-plan";

export const FIELD = "h-10 w-full rounded-xl border border-border/70 bg-background/60 px-3 text-sm outline-none transition-colors focus:border-primary/70 focus:ring-2 focus:ring-primary/20";

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-muted-foreground">
      <span>{children}</span>
      {hint && <span className="text-[11px] font-normal">{hint}</span>}
    </span>
  );
}

/** ₹ amount box — digits with up to 2 decimals only. */
export function AmountInput({
  value,
  onChange,
  ariaLabel,
  testId,
  autoFocus,
  className,
  placeholder = "0",
  disabled,
  size = "md",
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  testId?: string;
  autoFocus?: boolean;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: "md" | "lg" | "sm";
}) {
  return (
    <div className={cn("relative", className)}>
      <span className={cn("pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-semibold text-primary-accent-text", size === "lg" ? "text-lg" : "text-sm")}>₹</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel}
        data-testid={testId}
        disabled={disabled}
        className={cn(
          FIELD,
          "border-primary/25 bg-primary/5 pl-7 font-mono font-semibold tabular-nums disabled:opacity-60",
          size === "lg" && "h-12 pl-8 text-xl",
          size === "sm" && "h-9 text-sm",
        )}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/,/g, "");
          if (v === "" || /^\d*\.?\d{0,2}$/.test(v)) onChange(v);
        }}
        autoFocus={autoFocus}
      />
    </div>
  );
}

/** Two or more radio cards ("Set aside" vs "Move money"). */
export function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; title: string; hint: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid gap-2", options.length === 2 ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-3", className)}>
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
              "group flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2 text-left transition-all",
              on ? "border-primary bg-primary/12 shadow-[0_0_0_1px_var(--primary)]" : "border-border/60 bg-muted/20 hover:border-border hover:bg-muted/40",
            )}
          >
            {o.icon && <span className={cn("mt-0.5 shrink-0", on ? "text-primary-accent-text" : "text-muted-foreground")}>{o.icon}</span>}
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{o.title}</span>
              <span className="block text-[11px] leading-snug text-muted-foreground">{o.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const PLAN_STATUS: Record<PlanCycleStatus, { label: string; cls: string; dot: string; icon: typeof CheckCircle2 }> = {
  done: { label: "Done", cls: "bg-success/15 text-success", dot: "bg-success", icon: CheckCircle2 },
  partial: { label: "Partly saved", cls: "bg-warning/25 text-warning-foreground dark:text-warning", dot: "bg-warning", icon: CircleDot },
  due: { label: "To save", cls: "bg-primary/18 text-primary-accent-text", dot: "bg-primary", icon: CircleDashed },
  missed: { label: "Missed", cls: "bg-expense/12 text-expense", dot: "bg-expense", icon: XCircle },
  skipped: { label: "Skipped", cls: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50", icon: MinusCircle },
  none: { label: "No plan", cls: "bg-muted text-muted-foreground", dot: "bg-border", icon: CircleSlash },
};

export function PlanStatusPill({ status, className }: { status: PlanCycleStatus; className?: string }) {
  const s = PLAN_STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", s.cls, className)} data-plan-status={status}>
      <Icon className="size-3" />
      {s.label}
    </span>
  );
}

/** Thin bar with an optional second (ghost) segment — e.g. saved vs this month's plan. */
export function Meter({ value, ghost, color, className, label }: { value: number; ghost?: number; color: string; className?: string; label: string }) {
  const v = Math.min(1, Math.max(0, value));
  const g = Math.min(1, Math.max(v, ghost ?? 0));
  return (
    <div className={cn("relative h-2 overflow-hidden rounded-full bg-muted", className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      {ghost != null && g > v && <div className="absolute inset-y-0 left-0 rounded-full opacity-30" style={{ width: `${g * 100}%`, background: color }} />}
      <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out" style={{ width: `${v * 100}%`, background: color }} />
    </div>
  );
}

export function InlineNote({ tone = "muted", children, icon, testId, role }: { tone?: "muted" | "warn" | "error" | "good"; children: ReactNode; icon?: ReactNode; testId?: string; role?: string }) {
  return (
    <div
      role={role}
      data-testid={testId}
      className={cn(
        "flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-snug",
        tone === "muted" && "bg-muted/45 text-muted-foreground",
        tone === "warn" && "bg-warning/18 text-warning-foreground dark:text-warning",
        tone === "error" && "bg-expense/10 font-medium text-expense",
        tone === "good" && "bg-success/12 text-success",
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
