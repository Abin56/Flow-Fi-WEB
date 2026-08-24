import { cn } from "@/lib/utils";

const toneClass = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary",
  success: "bg-success/15 text-success",
  expense: "bg-expense/12 text-expense",
  warning: "bg-warning/18 text-warning-foreground",
  purple: "bg-purple/15 text-purple",
} as const;

export interface ClayBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof toneClass;
}

/** Flat pastel status chip — used for category/status labels. Deliberately flat (no shadow): a badge is a label,
 *  not a surface, so giving it clay elevation would compete with the actual clay cards it sits inside. */
export function ClayBadge({ tone = "neutral", className, ...props }: ClayBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium",
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}