"use client";

/**
 * The compact workspace header shared by Smart Capture and Reconciliation: icon, title, the three-step indicator
 * (Capture → Review & Import) and a slot for the screen's own controls. One line on desktop — the
 * explanation lives next to the controls that need it, not in a banner.
 */

import Link from "next/link";
import { Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkflowStepId = "capture" | "review" | "reconcile";

/**
 * Two steps: Capture, then Review & Import (OCR checks, duplicates and the final import on one screen). "review" stays
 * a valid id — Smart Capture's old standalone review is no longer part of the flow, so it isn't shown as a step.
 */
export const WORKFLOW_STEPS: { id: WorkflowStepId; label: string }[] = [
  { id: "capture", label: "Capture" },
  { id: "reconcile", label: "Review & Import" },
];

export interface StepLink {
  /** Navigates to the step; omitted = not reachable from here. */
  onSelect?: () => void;
  href?: string;
  /** Shown as a step button that can't be used yet (e.g. "Check duplicates" before every row is ready). */
  disabled?: boolean;
}

export function WorkspaceHeader({
  icon: Icon,
  title,
  current,
  steps = {},
  children,
}: {
  icon: LucideIcon;
  title: string;
  current: WorkflowStepId;
  steps?: Partial<Record<WorkflowStepId, StepLink>>;
  /** Right-aligned controls (source actions, account, discard…). */
  children?: React.ReactNode;
}) {
  const currentIndex = WORKFLOW_STEPS.findIndex((s) => s.id === current);
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-surface-hero px-3 py-2 text-hero-foreground shadow-e1 sm:px-4" data-testid="workspace-header">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary-accent-text">
          <Icon className="size-4" />
        </span>
        <h1 className="truncate font-heading text-base font-semibold tracking-tight text-hero-foreground">{title}</h1>
      </div>
      <ol className="flex min-w-0 items-center gap-1" aria-label="Progress">
        {WORKFLOW_STEPS.map((step, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          const link = active ? undefined : steps[step.id];
          const content = (
            <>
              <span className={cn("grid size-4 place-items-center rounded-full text-[10px] tabular-nums", active ? "bg-primary-foreground/20" : done ? "bg-primary/25" : "bg-white/10")}>
                {done ? <Check className="size-2.5" /> : i + 1}
              </span>
              <span className={cn(!active && "hidden md:inline")}>{step.label}</span>
            </>
          );
          const cls = cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors",
            active ? "bg-primary text-primary-foreground" : done ? "text-hero-foreground/85" : "text-hero-foreground/50",
            link && "hover:bg-white/10 hover:text-hero-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          );
          return (
            <li key={step.id} className="flex items-center gap-1">
              {i > 0 && <span className={cn("h-px w-3 sm:w-4", i <= currentIndex ? "bg-primary/70" : "bg-white/15")} aria-hidden />}
              {link?.href ? (
                <Link href={link.href} className={cls}>
                  {content}
                </Link>
              ) : link?.onSelect ? (
                <button type="button" onClick={link.onSelect} disabled={link.disabled} aria-label={step.label} className={cn(cls, "disabled:pointer-events-none disabled:opacity-60")}>
                  {content}
                </button>
              ) : (
                <span className={cls} aria-current={active ? "step" : undefined}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {children && <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5">{children}</div>}
    </header>
  );
}

/** A quiet header action — sits on the dark header band. */
export function HeaderAction({
  icon: Icon,
  children,
  onClick,
  tone = "default",
  disabled,
  title,
  testId,
  pressed,
  ariaLabel,
}: {
  icon?: LucideIcon;
  children: React.ReactNode;
  onClick: () => void;
  /** "accent" = a mode that is on (e.g. Focus Mode) — its exit stays easy to find. */
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
  title?: string;
  testId?: string;
  pressed?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-xs font-medium text-hero-foreground/80 transition-colors hover:bg-white/10 hover:text-hero-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
        tone === "danger" && "hover:border-danger/40 hover:bg-danger/15 hover:text-hero-foreground",
        tone === "accent" && "border-primary/60 bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
      )}
    >
      {Icon && <Icon className="size-3.5" />}
      {children}
    </button>
  );
}
