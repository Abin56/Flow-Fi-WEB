import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface TableSkeletonProps {
  rows?: number;
  columns?: number;
  className?: string;
}

/** Shimmer placeholder rows matching FinanceTable's row height/padding, shown while data loads. */
export function TableSkeleton({ rows = 6, columns = 4, className }: TableSkeletonProps) {
  return (
    <div className={cn("w-full", className)}>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b border-border/60 px-4 py-3.5 last:border-b-0"
        >
          {Array.from({ length: columns }).map((_, colIndex) => (
            <Skeleton
              key={colIndex}
              className={cn("h-4", colIndex === 0 ? "w-1/3" : "flex-1 max-w-32")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
