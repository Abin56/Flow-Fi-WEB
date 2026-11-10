"use client";

import { Check, Loader2, type LucideIcon } from "lucide-react";
import { OperationProgressView } from "@/components/feedback/operation-progress";
import { StackLayer, useInStack } from "@/components/finance/stack-layer";
import { SHEET_BUTTON, SheetAvatar, TransactionSheet } from "@/components/finance/transaction-sheet";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { handleEnterKey } from "@/components/ui/enter-key";
import type { OperationSnapshot } from "@/lib/operation-progress/operation-progress";
import { cn } from "@/lib/utils";

/**
 * Record Payment (Loan / EMI), in the same top sheet as Transaction Details (`TransactionSheet`, `compact`): a dark
 * header with what is being paid (eyebrow, title, status chip, installment line) and the amount that matters on the
 * right with a few small figures under it; a light body of small cards (the caller lays them out — form left, context
 * rail right on desktop); a sticky footer with "Still needed" and the actions.
 *
 * Behaviour is exactly the old `LoanEmiFormDialog`'s: nothing can be closed or edited while saving, Enter in a field
 * runs the primary action (or `onEnter`), the running operation's progress sits above the footer, and a failed write's
 * retry re-runs `onConfirm` with whatever is entered now. The sheet itself never writes anything.
 */
export function PaymentSheet({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  icon: Icon,
  chip,
  heroLabel,
  hero,
  facts,
  toolbar,
  instant = false,
  children,
  onConfirm,
  onEnter,
  confirmLabel,
  loading = false,
  confirmDisabled = false,
  success = false,
  refreshing = false,
  operation = null,
  pending = [],
  cancelLabel = "Cancel",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Small caps line above the title, e.g. "EMI payment". */
  eyebrow: string;
  title: string;
  description?: string;
  icon: LucideIcon;
  /** A small status pill next to the title (due / overdue). */
  chip?: { label: string; tone?: "neutral" | "danger" } | null;
  /** The amount block on the right: its caption and the figure. */
  heroLabel?: string;
  hero?: React.ReactNode;
  /** Small figures under the amount (already paid, your share, …) — light text on the dark header. */
  facts?: React.ReactNode;
  /** Pinned under the header, above the scrolling body — the payment flow's "what are you recording" switch. */
  toolbar?: React.ReactNode;
  /** A sibling step of the same flow just closed: skip the enter animation so the swap reads as one sheet. */
  instant?: boolean;
  children: React.ReactNode;
  onConfirm: () => void;
  onEnter?: () => void;
  confirmLabel: string;
  loading?: boolean;
  confirmDisabled?: boolean;
  success?: boolean;
  refreshing?: boolean;
  operation?: OperationSnapshot | null;
  /** What is still missing before the primary action works — shown as "Still needed" chips. */
  pending?: string[];
  cancelLabel?: string;
}) {
  const busy = loading || success;
  // Opened from a Loan/EMI popup: a compact layer beside it instead of the full-width top sheet. Same header, body and footer.
  const inStack = useInStack();
  const header = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <SheetAvatar compact>
          <Icon className="size-[18px]" strokeWidth={2} />
        </SheetAvatar>
        <div className="min-w-0">
          <p className="text-[10.5px] font-semibold tracking-[0.1em] whitespace-nowrap text-hero-foreground/68 uppercase">{eyebrow}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <DialogTitle className="max-w-full truncate font-heading text-[15px] leading-tight font-bold tracking-tight text-hero-foreground">{title}</DialogTitle>
            {chip && (
              <span
                className={cn(
                  "shrink-0 rounded-full bg-card px-2 py-0.5 text-[11px] font-semibold",
                  chip.tone === "danger" ? "text-[oklch(0.5_0.19_25)]" : "text-foreground/80",
                )}
              >
                {chip.label}
              </span>
            )}
          </div>
          <DialogDescription className={description ? "mt-0.5 truncate text-[12px] text-hero-foreground/70" : "sr-only"}>{description ?? title}</DialogDescription>
        </div>
      </div>
      {(hero != null || facts != null) && (
        <section aria-label="Payment summary" className="flex min-w-0 flex-col items-start gap-1 sm:items-end">
          {hero != null && (
            <div className="flex flex-col sm:items-end">
              {heroLabel && <span className="text-[10.5px] font-semibold tracking-[0.1em] whitespace-nowrap text-hero-foreground/68 uppercase">{heroLabel}</span>}
              {hero}
            </div>
          )}
          {facts}
        </section>
      )}
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-5">
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-2" aria-live="polite">
        {pending.length === 0 ? (
          !confirmDisabled && (
            <p className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[oklch(0.44_0.13_149)] dark:text-success">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-success text-success-foreground">
                <Check className="size-3" strokeWidth={3} />
              </span>
              <span className="truncate">Ready</span>
            </p>
          )
        ) : (
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
            <span className="shrink-0 text-[12.5px] font-medium text-foreground/72">Still needed:</span>
            {pending.map((p) => (
              <span key={p} className="inline-flex h-6 shrink-0 items-center rounded-full border border-dashed border-border-strong bg-card px-2 text-[11.5px] font-semibold text-foreground/80">
                {p}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-1 basis-full flex-wrap items-center justify-end gap-1.5 sm:flex-none sm:basis-auto">
        <button type="button" className={cn(SHEET_BUTTON.ghost, "h-9")} onClick={() => onOpenChange(false)} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={cn(confirmDisabled && !busy ? SHEET_BUTTON.primaryIdle : SHEET_BUTTON.primary, "h-9 min-w-0 flex-1 sm:flex-none", success && "disabled:opacity-100")}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
          aria-busy={loading}
        >
          {success ? (
            <>
              <Check className="size-4 animate-in zoom-in-50 fade-in-0 duration-200" strokeWidth={3} />
              {refreshing ? "Saved · Updating balances…" : "Done"}
            </>
          ) : loading ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              <span className="truncate">{confirmLabel}</span>
            </>
          ) : (
            <span className="truncate">{confirmLabel}</span>
          )}
        </button>
      </div>
    </div>
  );

  const footerWithOperation = (
    <>
      {operation && (
        <div className="border-b border-border px-3 py-2 animate-in fade-in-0 duration-150 sm:px-5">
          {/* A failure's retry is the sheet's current action, so it runs with whatever is entered now. */}
          <OperationProgressView snapshot={operation.retry ? { ...operation, retry: onConfirm } : operation} />
        </div>
      )}
      {footer}
    </>
  );
  // Enter in any single-line field runs the same primary action as the button (not while busy / invalid).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => handleEnterKey(e, onEnter ?? onConfirm, { enabled: !busy && !confirmDisabled });
  const body = (
    <div inert={busy} aria-busy={busy} className={cn("@container px-3 py-3 text-sm transition-opacity duration-150 sm:px-5", inStack && "sm:py-4", busy && "opacity-70")}>
      {!inStack && toolbar && <div className="mb-3">{toolbar}</div>}
      {children}
    </div>
  );

  if (inStack) {
    return (
      <StackLayer tone="hero" size="wide" instant={instant} toolbar={toolbar} open={open} onRequestClose={() => onOpenChange(false)} closeDisabled={busy} header={header} footer={footerWithOperation} onKeyDown={onKeyDown}>
        {body}
      </StackLayer>
    );
  }

  return (
    <TransactionSheet compact open={open} onRequestClose={() => onOpenChange(false)} closeDisabled={busy} header={header} footer={footerWithOperation} onKeyDown={onKeyDown}>
      {body}
    </TransactionSheet>
  );
}
