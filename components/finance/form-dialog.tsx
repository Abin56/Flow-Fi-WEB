import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";
import { useGuardedSubmit } from "./use-guarded-submit";

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
  const handleSubmit = useGuardedSubmit(onConfirm, loading);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-hidden", contentClassName)}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {/* A real <form> (display: contents, so layout is untouched) — Enter in a single-line field submits
            through the same onConfirm as the Save button; textareas keep Enter as a newline natively. */}
        <form className="contents" onSubmit={handleSubmit} noValidate>
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">{children}</div>
          <DialogFooter className="shrink-0">
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
            <ClayButton type="submit" variant="primary" disabled={loading}>
              {loading ? loadingLabel : confirmLabel}
            </ClayButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
