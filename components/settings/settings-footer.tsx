import { cn } from "@/lib/utils";

/** Sticky action bar for a settings form/card — "Cancel" / "Save changes" pair, right-aligned. */
export function SettingsFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}
