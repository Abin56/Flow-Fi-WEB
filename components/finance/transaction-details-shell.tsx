"use client";

/**
 * Shared "Transaction Details" popup shell — the Dialog structure (header,
 * identity strip, optional alert banner, 3-column card grid, footer)
 * originally built for Transaction Studio's `TransactionManageModal` and
 * extracted here so the SMS Candidates popup (`CandidateDetailsModal`)
 * renders from the exact same visual implementation instead of a second,
 * drifting copy. Purely presentational — no data fetching, no mutations, no
 * feature-specific types. Each caller supplies its own section content and
 * footer actions as pre-composed `ReactNode`s built from the exported
 * `SectionCard`/`Field`/`MerchantAvatar`/`StatChip` primitives.
 */

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

/** One of the popup's body cards — icon-badge + title header. Border uses `foreground/12` rather
 *  than the theme's own `--border` token, which is a 10%-opacity tint of the *primary* color and
 *  reads as essentially invisible against this dialog's white `bg-popover`/`bg-surface`; a
 *  low-opacity slice of `--foreground` gives a genuinely visible neutral hairline instead. */
export function SectionCard({
  icon: Icon,
  title,
  tone = "default",
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        tone === "danger" ? "border-danger/40 bg-danger/5" : "border-foreground/12 bg-surface",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            tone === "danger" ? "bg-danger/15 text-danger" : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <h4 className={cn("text-sm font-semibold", tone === "danger" ? "text-danger" : "text-foreground")}>{title}</h4>
      </div>
      {children}
    </div>
  );
}

/** Label → control → (optional error), the one field pattern every field in the popup uses. */
export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Neutral initials avatar for the identity strip — tinted by direction (income=success, expense=the row's own amount tone). */
export function MerchantAvatar({ name, credit }: { name: string; credit: boolean }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
        credit ? "bg-success/12 text-success" : "bg-expense/12 text-expense",
      )}
    >
      {initial}
    </span>
  );
}

export function StatChip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

export function TransactionDetailsShell({
  open,
  onOpenChange,
  busy = false,
  headerIcon: HeaderIcon,
  headerTitle,
  headerDescription,
  headerBadge,
  identityAvatarName,
  identityCredit,
  identityTitle,
  identitySubtitle,
  statChips,
  banner,
  leftColumn,
  middleColumn,
  rightColumn,
  footerLeft,
  footerActions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** While true, the Dialog won't close on outside-click/Escape — mirrors "don't dismiss mid-save/mid-delete". */
  busy?: boolean;
  headerIcon: React.ComponentType<{ className?: string }>;
  headerTitle: ReactNode;
  headerDescription: ReactNode;
  /** Optional extra badge shown before the close button, e.g. a reference-number chip. */
  headerBadge?: ReactNode;
  identityAvatarName: string;
  identityCredit: boolean;
  identityTitle: ReactNode;
  identitySubtitle: ReactNode;
  /** The row of `StatChip`s shown on the right of the identity strip. */
  statChips: ReactNode;
  /** Extra alert row between the identity strip and the column grid — e.g. needs-review/duplicate warnings. Omitted entirely (no extra spacing) when undefined. */
  banner?: ReactNode;
  leftColumn: ReactNode;
  middleColumn: ReactNode;
  rightColumn: ReactNode;
  footerLeft?: ReactNode;
  footerActions: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-full flex-col gap-0 overflow-hidden rounded-none border border-border p-0 shadow-lg ring-0 sm:max-w-[1096px]"
      >
        <div className="h-1 w-full shrink-0 bg-primary" />

        <DialogHeader className="shrink-0 flex-row items-center justify-between gap-3 border-b border-border px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <HeaderIcon className="size-4" />
            </span>
            <div>
              <DialogTitle className="text-base">{headerTitle}</DialogTitle>
              <DialogDescription>{headerDescription}</DialogDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {headerBadge}
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => onOpenChange(false)}>
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border bg-muted/30 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <MerchantAvatar name={identityAvatarName} credit={identityCredit} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{identityTitle}</p>
              <p className="truncate text-xs text-muted-foreground">{identitySubtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-5">{statChips}</div>
        </div>

        {banner && <div className="shrink-0 border-b border-border px-6 py-3">{banner}</div>}

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-6 py-4 md:grid-cols-3 md:items-start">
          {leftColumn}
          <div className="flex flex-col gap-4">{middleColumn}</div>
          <div className="flex flex-col gap-4">{rightColumn}</div>
        </div>

        <DialogFooter className="shrink-0 flex-row items-center justify-between border-t border-border px-6 py-3 sm:justify-between">
          {footerLeft ?? <span />}
          <div className="flex items-center gap-2">{footerActions}</div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
