"use client";

import { X } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SectionedFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  onCancel?: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  loadingLabel?: string;
  loading?: boolean;
  cancelLabel?: string;
  /** Extra classes for DialogContent — e.g. a wider `sm:max-w-2xl` for a form with more fields. */
  contentClassName?: string;
}

/**
 * The flat, rectangular, bordered "sectioned" popup box — accent bar, banded header, scrollable
 * bordered body, banded footer — first built for the Add Card/Add Account dialogs and now shared
 * so every new record-creation popup gets the same box for free instead of re-deriving it. Pair
 * with `SectionLabel` inside `children` to group fields the same way those two do.
 */
export function SectionedFormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onCancel,
  onConfirm,
  confirmLabel = "Save",
  loadingLabel = "Saving…",
  loading = false,
  cancelLabel = "Cancel",
  contentClassName,
}: SectionedFormDialogProps) {
  function close() {
    onCancel?.();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        className={cn("gap-0 overflow-hidden rounded-none border border-border p-0 shadow-lg ring-0 sm:max-w-lg", contentClassName)}
      >
        <div className="h-1 w-full shrink-0 bg-primary" />

        <button
          type="button"
          onClick={close}
          aria-label="Close"
          disabled={loading}
          className="absolute top-4 right-4 flex size-7 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="size-4" />
        </button>

        <DialogHeader className="shrink-0 gap-1 border-b border-border bg-muted/40 px-6 py-5 text-left">
          <DialogTitle className="font-heading text-lg font-semibold">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-6 overflow-y-auto px-6 py-5 text-sm">{children}</div>

        <DialogFooter className="shrink-0 border-t border-border bg-muted/20 px-6 py-4">
          <ClayButton variant="ghost" className="rounded-none" onClick={close} disabled={loading}>
            {cancelLabel}
          </ClayButton>
          <ClayButton variant="primary" className="rounded-none" onClick={onConfirm} disabled={loading}>
            {loading ? loadingLabel : confirmLabel}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
