"use client";

import { ArrowLeft, Check, Loader2, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { OperationProgressView } from "@/components/feedback/operation-progress";
import { StackLayer, useInStack } from "@/components/finance/stack-layer";
import { SHEET_BUTTON, SheetAvatar, TransactionSheet } from "@/components/finance/transaction-sheet";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { handleEnterKey } from "@/components/ui/enter-key";
import type { OperationSnapshot } from "@/lib/operation-progress/operation-progress";
import { cn } from "@/lib/utils";

/** Shared payment header, scrolling body and pinned actions. Saves and retries use the caller's confirm handler. */
export function PaymentSheet({
  open,
  onOpenChange,
  eyebrow,
  title,
  titlePrefix,
  description,
  icon: Icon,
  chip,
  heroLabel,
  hero,
  facts,
  actions,
  onBack,
  backDisabled = false,
  compactHeader = false,
  headerTestId,
  instant = false,
  workspace = false,
  children,
  onConfirm,
  onEnter,
  confirmLabel,
  confirmHref,
  loading = false,
  confirmDisabled = false,
  success = false,
  successFeedback,
  refreshing = false,
  operation = null,
  pending = [],
  cancelLabel = "Cancel",
  closeDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Small caps line above the title, e.g. "EMI payment". */
  eyebrow?: string;
  title: string;
  titlePrefix?: string;
  description?: React.ReactNode;
  icon: LucideIcon;
  /** A small status pill next to the title (due / overdue). */
  chip?: { label: string; tone?: "neutral" | "danger" } | null;
  /** The amount block on the right: its caption and the figure. */
  heroLabel?: string;
  hero?: React.ReactNode;
  /** Small figures under the amount (already paid, your share, …) — light text on the dark header. */
  facts?: React.ReactNode;
  actions?: React.ReactNode;
  onBack?: () => void;
  backDisabled?: boolean;
  compactHeader?: boolean;
  headerTestId?: string;
  /** A sibling step of the same flow just closed: skip the enter animation so the swap reads as one sheet. */
  instant?: boolean;
  workspace?: boolean;
  children: React.ReactNode;
  onConfirm: () => void;
  onEnter?: () => void;
  confirmLabel: string;
  confirmHref?: string;
  loading?: boolean;
  confirmDisabled?: boolean;
  success?: boolean;
  successFeedback?: React.ReactNode;
  refreshing?: boolean;
  operation?: OperationSnapshot | null;
  /** What is still missing before the primary action works — shown as "Still needed" chips. */
  pending?: string[];
  cancelLabel?: string;
  closeDisabled?: boolean;
}) {
  const busy = loading || success;
  const keepOpen = busy || closeDisabled;
  // Opened from a Loan/EMI popup: a compact layer beside it instead of the full-width top sheet. Same header, body and footer.
  const inStack = useInStack();
  // Over the Loan & EMI workspace it is a compact light popup in the workspace's own style; the top sheet keeps its dark header.
  const muted = inStack ? "text-muted-foreground" : "text-hero-foreground/68";
  const header = (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2", compactHeader && "gap-x-3 gap-y-1.5")} data-testid={headerTestId}>
      <div className={cn("flex min-w-0 flex-1 basis-56 items-center gap-2.5", compactHeader && "lg:basis-40")}>
        {inStack ? (
          <span aria-hidden className="hidden size-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-foreground sm:grid">
            <Icon className="size-[18px]" strokeWidth={2} />
          </span>
        ) : (
          <SheetAvatar compact>
            <Icon className="size-[18px]" strokeWidth={2} />
          </SheetAvatar>
        )}
        <div className="min-w-0">
          {eyebrow && <p className={cn("text-[10.5px] font-semibold tracking-[0.1em] uppercase [overflow-wrap:anywhere]", muted)}>{eyebrow}</p>}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <DialogTitle aria-label={titlePrefix ? `${titlePrefix} · ${title}` : undefined} className={cn("max-w-full font-heading text-[15px] leading-tight font-bold tracking-tight break-words", inStack ? "text-foreground" : "text-hero-foreground")}>
              {title}
            </DialogTitle>
            {chip && (
              <span
                className={cn(
                  "max-w-full rounded-md px-1.5 py-0.5 text-[11px] leading-tight font-semibold",
                  inStack ? (chip.tone === "danger" ? "bg-expense/10 text-expense" : "bg-secondary text-foreground/80 ring-1 ring-border") : cn("bg-card", chip.tone === "danger" ? "text-[oklch(0.5_0.19_25)]" : "text-foreground/80"),
                )}
              >
                {chip.label}
              </span>
            )}
          </div>
          <DialogDescription className={description ? cn("mt-0.5 text-xs leading-tight break-words", inStack ? "text-muted-foreground" : "text-hero-foreground/70") : "sr-only"}>{description ?? title}</DialogDescription>
        </div>
      </div>
      {(hero != null || facts != null) && (
        <section aria-label="Payment summary" className={cn("flex min-w-0 flex-col gap-1", heroLabel ? "sm:items-end" : compactHeader ? "shrink-0" : "flex-1 basis-44 sm:max-w-[22rem]", !inStack && "[&_span]:text-hero-foreground")}>
          {hero != null && (
            <div className={cn("flex min-w-0 flex-col", heroLabel && "sm:items-end")}>
              {heroLabel && <span className={cn("text-[10.5px] font-semibold tracking-[0.1em] whitespace-nowrap uppercase", muted)}>{heroLabel}</span>}
              {hero}
            </div>
          )}
          {facts}
        </section>
      )}
      {onBack && (
        <button type="button" autoFocus onClick={onBack} disabled={keepOpen || backDisabled} className={cn("inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", inStack ? "text-foreground hover:bg-secondary" : "text-hero-foreground hover:bg-white/10")}>
          <ArrowLeft className="size-3.5" aria-hidden /> Back to payment
        </button>
      )}
      {actions && <div className="ml-auto shrink-0">{actions}</div>}
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-5">
      <div className="min-w-0 flex-1 basis-56 empty:hidden" aria-live="polite">
        {pending.length > 0 && (
          <p className="text-xs leading-snug text-muted-foreground">
            <span className="font-semibold text-foreground">Still needed</span>
            <span> · {pending.join(" · ")}</span>
          </p>
        )}
      </div>
      <div className="ml-auto flex min-w-0 max-w-full flex-1 basis-56 items-center justify-end gap-1.5 sm:flex-none">
        <button type="button" className={cn(SHEET_BUTTON.ghost, "h-9")} onClick={() => onOpenChange(false)} disabled={keepOpen}>
          {cancelLabel}
        </button>
        {confirmHref && !keepOpen ? (
          <Link href={confirmHref} className={cn(SHEET_BUTTON.primary, "min-h-9")}>{confirmLabel}</Link>
        ) : <button
          type="button"
          className={cn(confirmDisabled && !busy ? SHEET_BUTTON.primaryIdle : SHEET_BUTTON.primary, "h-auto min-h-9 min-w-0 flex-1 py-1.5 text-center leading-tight whitespace-normal sm:flex-none", success && "disabled:opacity-100")}
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
              <span className="min-w-0 break-words">{confirmLabel}</span>
            </>
          ) : (
            <span className="min-w-0 break-words">{confirmLabel}</span>
          )}
        </button>}
      </div>
    </div>
  );

  const footerWithOperation = (
    <>
      {success && successFeedback && <div className="border-b border-border px-3 py-2 sm:px-5">{successFeedback}</div>}
      {operation && !(success && successFeedback && operation.status === "success") && (
        <div className="border-b border-border px-3 py-2 animate-in fade-in-0 duration-150 sm:px-5">
          {/* A failure's retry is the sheet's current action, so it runs with whatever is entered now. */}
          <OperationProgressView snapshot={operation.retry ? { ...operation, retry: onConfirm } : operation} />
        </div>
      )}
      {footer}
    </>
  );
  // Enter in any single-line field runs the same primary action as the button (not while busy / invalid).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => handleEnterKey(e, onEnter ?? onConfirm, { enabled: !busy && !confirmDisabled && !confirmHref });
  const body = (
    <div inert={busy} aria-busy={busy} className={cn("@container px-3 py-3 text-sm transition-opacity duration-150 sm:px-5", inStack && !workspace && !compactHeader && "sm:py-4", busy && "opacity-70")}>
      {children}
    </div>
  );

  if (inStack) {
    return (
      <StackLayer tone="light" size="popup" instant={instant} open={open} onRequestClose={() => onOpenChange(false)} closeDisabled={keepOpen} compactHeader={compactHeader} closeWithIcon={onBack != null} header={header} footer={footerWithOperation} onKeyDown={onKeyDown} bodyClassName={workspace ? "bg-secondary/35" : undefined}>
        {body}
      </StackLayer>
    );
  }

  return (
    <TransactionSheet compact open={open} onRequestClose={() => onOpenChange(false)} closeDisabled={keepOpen} header={header} footer={footerWithOperation} onKeyDown={onKeyDown}>
      {body}
    </TransactionSheet>
  );
}
