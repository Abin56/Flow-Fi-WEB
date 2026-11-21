import { cn } from "@/lib/utils";

const LABEL = "text-[10.5px] font-bold tracking-[0.07em] text-foreground/60 uppercase";

/** A header column's title — an icon chip + the small-caps label. */
export function ColumnLabel({ icon, children, className }: { icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <p className={cn(LABEL, "flex items-center gap-1.5", className)}>
      {icon && <span className="grid size-4 place-items-center rounded-[5px] bg-secondary text-foreground/60">{icon}</span>}
      {children}
    </p>
  );
}

/** The dotted line that carries the eye from a label to its amount. */
export function Leader() {
  return <span aria-hidden className="mb-[5px] h-px min-w-3 flex-1 self-end border-b border-dotted border-border-strong/80" />;
}
