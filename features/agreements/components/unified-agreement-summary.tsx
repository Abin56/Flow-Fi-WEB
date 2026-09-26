import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CalendarClock } from "lucide-react";
import { FloatingCard } from "@/components/foundation/floating-card";
import { formatCurrency } from "@/lib/format";
import type { UnifiedAgreementSummary } from "@/features/agreements/lib/unified-workspace-model";

const items = [
  { key: "liabilityPrincipal", label: "I Owe", icon: ArrowUpRight, tone: "text-expense bg-expense/10" },
  { key: "receivablePrincipal", label: "Owed to Me", icon: ArrowDownLeft, tone: "text-success bg-success/10" },
  { key: "dueSoonAmount", label: "Due Soon", icon: CalendarClock, tone: "text-warning-foreground bg-warning/15" },
  { key: "overdueAmount", label: "Overdue", icon: AlertTriangle, tone: "text-expense bg-expense/10" },
] as const;

export function UnifiedAgreementSummaryStrip({ summary }: { summary: UnifiedAgreementSummary }) {
  return (
    <FloatingCard interactive={false} className="grid gap-1 p-2 sm:grid-cols-2 xl:grid-cols-4">
      {items.map(({ key, label, icon: Icon, tone }) => {
        const count = key === "dueSoonAmount" ? summary.dueSoonCount : key === "overdueAmount" ? summary.overdueCount : null;
        return (
          <div key={key} className="flex min-w-0 items-center gap-3 rounded-xl px-3 py-3 sm:px-4">
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon className="size-4" /></span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{label}{count != null ? ` · ${count}` : ""}</p>
              <p className="truncate font-mono text-base font-semibold tabular-nums text-foreground">{formatCurrency(summary[key])}</p>
            </div>
          </div>
        );
      })}
    </FloatingCard>
  );
}
