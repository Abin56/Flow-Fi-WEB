import { ChevronLeft, ChevronRight } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}

/** Simple prev/next pager with an "1-20 of 84" summary — no page-number buttons, dataset sizes don't need it. */
export function Pagination({ page, pageSize, total, onPageChange, className }: PaginationProps) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const canPrev = page > 1;
  const canNext = end < total;

  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <p className="text-sm text-muted-foreground">
        {start}-{end} of {total}
      </p>
      <div className="flex items-center gap-1.5">
        <ClayButton
          variant="ghost"
          size="icon"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
        </ClayButton>
        <ClayButton
          variant="ghost"
          size="icon"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="size-4" />
        </ClayButton>
      </div>
    </div>
  );
}
