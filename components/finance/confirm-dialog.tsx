import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { handleEnterKey } from "@/components/ui/enter-key";
import { cn } from "@/lib/utils";
import { useGuardedAction } from "./use-guarded-submit";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
}

/** No alert-dialog primitive exists in components/ui yet, so this wraps Dialog directly. Destructive variant
 *  tints the confirm button with --color-danger for delete/archive-style confirmations. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  variant = "default",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  loading = false,
}: ConfirmDialogProps) {
  // Enter confirms from anywhere in the dialog (focus opens on Cancel, so a held-down Enter — `event.repeat` —
  // is ignored: the Enter that opened the dialog can't also confirm it). A rapid double Enter/click runs the
  // action once.
  const confirm = useGuardedAction(onConfirm, loading);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onKeyDown={(e) => handleEnterKey(e, confirm, { enabled: !loading, fromButtons: true })}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <ClayButton variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </ClayButton>
          <ClayButton
            variant="primary"
            onClick={confirm}
            disabled={loading}
            className={cn(variant === "destructive" && "bg-danger text-danger-foreground")}
          >
            {confirmLabel}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
