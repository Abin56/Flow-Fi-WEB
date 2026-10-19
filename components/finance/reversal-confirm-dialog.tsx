"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { handleEnterKey } from "@/components/ui/enter-key";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ReversalConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already formatted, e.g. "₹5,683". */
  amountLabel: string;
  /** Optional one-line context under the amount, e.g. "HDFC Regalia · paid from SBI". */
  subtitle?: string;
  /** "What will change" — only effects that were really derived from the linked records. */
  effects: readonly string[];
  /** When set, cancelling is not possible: this explains why and the confirm button is hidden. */
  blockedReason?: string | null;
  /** The last attempt's failure, shown in place — nothing was changed. */
  error?: string | null;
  busy?: boolean;
  title?: string;
  keepLabel?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

/**
 * The one compact confirmation for correcting a mistaken FlowFi entry ("Cancel recorded payment"). Purely
 * presentational: each feature supplies its own impact lines (derived from its own engine) and its own
 * reversal call, and revalidates inside that call — a preview here never replaces the transactional checks.
 */
export function ReversalConfirmDialog({
  open,
  onOpenChange,
  amountLabel,
  subtitle,
  effects,
  blockedReason,
  error,
  busy,
  title = "Cancel this recorded payment?",
  keepLabel = "Keep payment",
  confirmLabel = "Cancel recorded payment",
  onConfirm,
}: ReversalConfirmDialogProps) {
  const blocked = blockedReason != null && blockedReason !== "";
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" onKeyDown={(e) => handleEnterKey(e, () => void onConfirm(), { enabled: !busy && !blocked, fromButtons: true })}>
        <DialogHeader>
          <DialogTitle>{blocked ? "Can't cancel this payment" : title}</DialogTitle>
          <DialogDescription>
            Amount: <span className="font-semibold text-foreground tabular-nums">{amountLabel}</span>
            {subtitle ? ` · ${subtitle}` : ""}
          </DialogDescription>
        </DialogHeader>
        {blocked ? (
          <p className="text-sm text-foreground/85">{blockedReason}</p>
        ) : (
          <div className="text-sm">
            <p className="mb-1 text-xs font-semibold tracking-[0.06em] text-foreground/70 uppercase">What will change</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-foreground/85 tabular-nums">
              {effects.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {blocked ? "Close" : keepLabel}
          </Button>
          {!blocked && (
            <Button variant="destructive" onClick={() => void onConfirm()} disabled={busy}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
