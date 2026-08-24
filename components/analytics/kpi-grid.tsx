import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { cn } from "@/lib/utils";

/** Responsive grid wrapper for a row of MetricCards, staggered in on mount. */
export function KpiGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Stagger className={cn("grid grid-cols-2 gap-4 lg:grid-cols-4", className)}>
      {Array.isArray(children) ? children.map((child, i) => <StaggerItem key={i}>{child}</StaggerItem>) : children}
    </Stagger>
  );
}
