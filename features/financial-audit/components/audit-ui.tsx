"use client";

/**
 * Presentation-only building blocks shared by the Financial Audit page and its definition-checks section: a titled
 * panel, a filter chip, a stat tile and a label/value pair. No data, no actions — just the page's visual language.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function AuditPanel({
  icon: Icon,
  title,
  description,
  headerExtra,
  testId,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  headerExtra?: ReactNode;
  testId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface-primary overflow-hidden rounded-2xl", className)} data-testid={testId}>
      <header className="flex flex-col gap-3 border-b border-border bg-muted/40 px-4 py-3.5 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-primary-accent-text">
            <Icon className="size-4.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
            {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
        </div>
        {headerExtra}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function FilterChip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-[background-color,border-color,box-shadow] duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
        active ? "border-transparent bg-primary text-primary-foreground shadow-e1" : "border-border bg-card text-foreground hover:border-border-strong hover:bg-muted/60",
      )}
    >
      {children}
      {count != null && <span className={cn("text-xs font-normal tabular-nums", active ? "opacity-70" : "text-muted-foreground")}>{count}</span>}
    </button>
  );
}

export type Tone = "neutral" | "danger" | "warning" | "success";

const TONE_TILE: Record<Tone, string> = {
  neutral: "border-border",
  danger: "border-destructive/35 bg-destructive/5",
  warning: "border-warning/50 bg-warning/10",
  success: "border-success/35 bg-success/5",
};
const TONE_ICON: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  danger: "bg-destructive/10 text-destructive",
  warning: "bg-warning/20 text-warning-foreground dark:text-warning",
  success: "bg-success/10 text-success",
};

export function StatTile({ icon: Icon, label, value, tone = "neutral", hint }: { icon: LucideIcon; label: string; value: ReactNode; tone?: Tone; hint?: string }) {
  return (
    <div className={cn("surface-primary flex flex-col gap-3 rounded-2xl p-4", TONE_TILE[tone])}>
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE_ICON[tone])}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 text-xs leading-snug font-medium text-muted-foreground">{label}</span>
      </div>
      <p className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</p>
      {hint && <p className="-mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A small label above a value — used for the facts under a finding. */
export function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn("truncate text-sm tabular-nums", tone === "danger" ? "font-semibold text-destructive" : "text-foreground")}>{children}</dd>
    </div>
  );
}

export function Pill({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        tone === "danger" && "border-destructive/35 bg-destructive/10 text-destructive",
        tone === "warning" && "border-warning/60 bg-warning/15 text-warning-foreground dark:text-warning",
        tone === "success" && "border-success/35 bg-success/10 text-success",
        tone === "neutral" && "border-border-strong bg-secondary text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const RAIL: Record<Tone, string> = {
  neutral: "before:bg-border-strong",
  danger: "before:bg-destructive",
  warning: "before:bg-warning",
  success: "before:bg-success",
};

/** A list card with a coloured rail on its leading edge. */
export function RailItem({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <li
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-4 pl-5 text-sm transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-e1",
        "before:absolute before:inset-y-0 before:left-0 before:w-1",
        RAIL[tone],
      )}
      data-testid={testId}
    >
      {children}
    </li>
  );
}
