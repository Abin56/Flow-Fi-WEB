import { cn } from "@/lib/utils";

/** Row of controls (range picker, toggle, export) that sits in a ChartContainer's header action slot. */
export function ChartToolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-2", className)}>{children}</div>;
}
