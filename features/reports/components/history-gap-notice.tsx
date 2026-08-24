import { History } from "lucide-react";
import { EmptyState } from "@/components/finance";
import { FloatingCard } from "@/components/foundation/floating-card";
import { cn } from "@/lib/utils";

/**
 * Honest stand-in for any chart that fundamentally needs balance/spend
 * *history* this codebase doesn't store yet (no snapshot mechanism exists —
 * see `features/reports/hooks/use-reports-data.ts`'s doc comment). Used
 * wherever a trend line or forecast was previously faked from mock data.
 */
export function HistoryGapNotice({ title, className }: { title: string; className?: string }) {
  return (
    <FloatingCard interactive={false} elevation={2} className={cn("flex flex-col", className)}>
      <EmptyState
        icon={History}
        title={title}
        description="This needs balance/spend history tracked over time, which isn't recorded yet — only today's real figures are shown above."
      />
    </FloatingCard>
  );
}
