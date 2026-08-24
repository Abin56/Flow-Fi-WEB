import { AnimatedNumber } from "@/components/foundation/animated-number";
import { FloatingCard } from "@/components/foundation/floating-card";
import { cn } from "@/lib/utils";

interface ComparisonCardProps {
  title: string;
  a: { label: string; value: number; color?: string };
  b: { label: string; value: number; color?: string };
  format: (value: number) => string;
  className?: string;
}

/** Two metrics side by side with a shared proportional scale bar — e.g. Income vs Expense. */
export function ComparisonCard({ title, a, b, format, className }: ComparisonCardProps) {
  const total = a.value + b.value || 1;
  const aPct = (a.value / total) * 100;

  return (
    <FloatingCard interactive={false} elevation={1} className={cn("flex flex-col gap-4", className)}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: a.color ?? "var(--success)" }} />
            {a.label}
          </p>
          <p className="mt-1 font-heading text-xl font-semibold tracking-tight tabular-nums">
            <AnimatedNumber value={a.value} format={format} />
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: b.color ?? "var(--expense)" }} />
            {b.label}
          </p>
          <p className="mt-1 font-heading text-xl font-semibold tracking-tight tabular-nums">
            <AnimatedNumber value={b.value} format={format} />
          </p>
        </div>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-l-full transition-[width]"
          style={{ width: `${aPct}%`, background: a.color ?? "var(--success)" }}
        />
        <div
          className="h-full rounded-r-full transition-[width]"
          style={{ width: `${100 - aPct}%`, background: b.color ?? "var(--expense)" }}
        />
      </div>
    </FloatingCard>
  );
}
