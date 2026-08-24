import { FloatingCard } from "@/components/foundation/floating-card";
import { SectionHeader } from "@/components/foundation/section-header";
import { cn } from "@/lib/utils";

interface ChartContainerProps {
  eyebrow?: string;
  title: string;
  description?: string;
  toolbar?: React.ReactNode;
  legend?: React.ReactNode;
  children: React.ReactNode;
  height?: number;
  className?: string;
}

/** The standard chart shell — every analytics chart composes on this so padding, header layout,
 *  and elevation stay identical across the whole workspace. */
export function ChartContainer({
  eyebrow,
  title,
  description,
  toolbar,
  legend,
  children,
  height = 320,
  className,
}: ChartContainerProps) {
  return (
    <FloatingCard interactive={false} elevation={2} className={cn("flex flex-col", className)}>
      <SectionHeader eyebrow={eyebrow} title={title} description={description} action={toolbar} />
      <div style={{ height }} className="mt-5 -ml-2 w-[calc(100%+0.5rem)]">
        {children}
      </div>
      {legend && <div className="mt-4 border-t border-border/60 pt-4">{legend}</div>}
    </FloatingCard>
  );
}
