import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Skeleton for a SettingsRow — icon + two lines + control placeholder. */
export function SettingsRowSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 px-5 py-4", className)}>
      <div className="flex min-w-0 items-center gap-3">
        <Skeleton className="size-9 shrink-0 rounded-xl" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
      <Skeleton className="h-5.5 w-9.5 shrink-0 rounded-full" />
    </div>
  );
}

/** Skeleton for a SettingsCard — heading + a few text lines, matching clay padding. */
export function SettingsCardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 p-5", className)}>
      <Skeleton className="h-4 w-40" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-3 w-full max-w-sm" />
      ))}
    </div>
  );
}

/** Skeleton for a ProfileHeader — avatar + name/email lines. */
export function ProfileHeaderSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 p-5", className)}>
      <Skeleton className="size-16 shrink-0 rounded-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-48" />
      </div>
    </div>
  );
}
