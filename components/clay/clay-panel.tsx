import { cn } from "@/lib/utils";

interface ClayPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** "raised" (default) = resting clay surface. "pressed" = inset/pushed-in — active nav container, search well. */
  variant?: "raised" | "pressed";
  /** Stronger elevation for panels that should read as floating above everything else (dialogs, dropdowns). */
  strong?: boolean;
}

/** The base clay surface — sidebar, top bar, AI panel, command palette and dialogs all sit on this. */
export function ClayPanel({ variant = "raised", strong = false, className, style, ...props }: ClayPanelProps) {
  return (
    <div
      className={cn("rounded-3xl border border-border/60 bg-card", className)}
      style={{
        boxShadow: variant === "pressed" ? "var(--shadow-pressed)" : strong ? "var(--shadow-e4)" : "var(--shadow-e2)",
        ...style,
      }}
      {...props}
    />
  );
}
