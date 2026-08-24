import type { LucideIcon } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

/** Smaller inline sibling of FeaturePlaceholder — for empty tables/panels rather than a full page. */
export function EmptyState({ icon: Icon, title, description, actionLabel, onAction, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1 px-6 py-14 text-center", className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-e1">
        <Icon className="size-4.5" />
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && <p className="max-w-xs text-sm text-muted-foreground">{description}</p>}
      {actionLabel && onAction && (
        <ClayButton size="sm" variant="secondary" className="mt-3" onClick={onAction}>
          {actionLabel}
        </ClayButton>
      )}
    </div>
  );
}
