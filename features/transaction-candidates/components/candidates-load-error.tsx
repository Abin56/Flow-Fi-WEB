"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";

/** Inline error for the SMS candidates list when its live Firestore listener fails — complements (doesn't replace) the app-wide `WatcherErrorBanner`. */
export function CandidatesLoadError({ message, error, onRetry, className }: { message: string; error?: Error | null; onRetry: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-3 rounded-2xl border border-danger/30 bg-danger/8 px-4 py-3 text-sm", className)}>
      <AlertCircle className="size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{message}</p>
        {error?.message && <p className="truncate text-xs text-muted-foreground">{error.message}</p>}
      </div>
      <ClayButton variant="secondary" size="sm" onClick={onRetry}>
        <RotateCcw className="size-3.5" />
        Retry
      </ClayButton>
    </div>
  );
}
