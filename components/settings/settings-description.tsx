import { cn } from "@/lib/utils";

/** Helper/description text under a form field or setting label. */
export function SettingsDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
