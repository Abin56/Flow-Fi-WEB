import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";

interface FormDialogProps {
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
  /** Extra classes for DialogContent — e.g. a wider `sm:max-w-lg` for a form with a richer layout. */
  contentClassName?: string;
}

/** Wraps Dialog for record create/edit forms — title/description, a content slot for the actual fields
 *  (built by the page), and a footer with Cancel + primary action. Primary button swaps to a loading label
 *  and disables while `loading` is true; no real submission logic lives here. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onCancel,
  onConfirm,
  confirmLabel = "Save",
  loadingLabel = "Saving...",
  loading = false,
  cancelLabel = "Cancel",
  contentClassName,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(contentClassName)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div>{children}</div>
        <DialogFooter>
          <ClayButton
            variant="ghost"
            onClick={() => {
              onCancel?.();
              onOpenChange(false);
            }}
            disabled={loading}
          >
            {cancelLabel}
          </ClayButton>
          <ClayButton variant="primary" onClick={onConfirm} disabled={loading}>
            {loading ? loadingLabel : confirmLabel}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
