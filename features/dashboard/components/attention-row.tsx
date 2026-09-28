import { AlertCircle, Bike, CheckCircle2, CreditCard, Landmark, ShoppingBag } from "lucide-react";
import { useRouter } from "next/navigation";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_PANEL } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const CTA_HREF: Record<AttentionRowItem["type"], string> = {
  bill: "/bills",
  emi: "/loans",
  budget: "/budgets",
  goal: "/budgets",
};

const STYLES = {
  bill: { icon: CreditCard, iconClass: "bg-expense/12 text-expense", edge: "bg-expense", titleClass: "text-expense" },
  emi: { icon: Landmark, iconClass: "bg-expense/12 text-expense", edge: "bg-expense", titleClass: "text-expense" },
  budget: { icon: ShoppingBag, iconClass: "bg-warning/20 text-warning-foreground dark:text-warning", edge: "bg-warning", titleClass: "text-warning-foreground dark:text-warning" },
  goal: { icon: Bike, iconClass: "bg-purple/12 text-purple", edge: "bg-purple", titleClass: "text-purple" },
} as const;

export interface AttentionRowItem {
  id: string;
  type: "bill" | "emi" | "budget" | "goal";
  title: string;
  subtitle: string;
  amount?: number;
  percent?: number;
  note: string;
  cta: string;
}

export interface AttentionRowProps {
  items: AttentionRowItem[];
  isLoading?: boolean;
}

/**
 * "Needs your attention" — real Bill/Budget alerts from `useDashboardData`, one divided strip. When
 * nothing needs attention it collapses to a single calm line.
 */
export function AttentionRow({ items, isLoading }: AttentionRowProps) {
  const router = useRouter();

  if (isLoading) {
    return <Skeleton className="h-24 rounded-[10px]" />;
  }

  if (items.length === 0) {
    return (
      <section aria-label="Needs your attention" className={cn(DASH_PANEL, "flex items-center gap-2.5 px-4 py-3 text-sm")}>
        <CheckCircle2 className="size-4.5 shrink-0 text-success" />
        <span className="font-semibold text-foreground">All caught up.</span>
        <span className="text-muted-foreground">No bills or budgets need attention right now.</span>
      </section>
    );
  }

  return (
    <section aria-label="Needs your attention" className={DASH_PANEL}>
      <div className="flex items-center gap-2 border-b border-border-strong/50 bg-expense/[0.05] px-4 py-2.5 dark:bg-expense/10">
        <AlertCircle className="size-4 text-expense" strokeWidth={2} />
        <h2 className="font-heading text-[15px] font-semibold text-foreground">Needs your attention</h2>
        <span className="rounded-[4px] bg-expense/12 px-1.5 text-xs font-bold text-expense tabular-nums">{items.length}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 [&>*]:border-border-strong/40 [&>*]:border-b lg:[&>*]:border-b-0 lg:[&>*:not(:last-child)]:border-r">
        {items.map((item) => {
          const style = STYLES[item.type];
          const Icon = style.icon;
          return (
            <div key={item.id} className="relative flex items-start gap-3 px-4 py-3.5">
              <span className={cn("absolute inset-y-3 left-0 w-[3px] rounded-r-full", style.edge)} aria-hidden />
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-[8px]", style.iconClass)}>
                <Icon className="size-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-[11px] font-semibold tracking-[0.04em] uppercase", style.titleClass)}>{item.title}</p>
                <p className="truncate text-sm font-semibold text-foreground">{item.subtitle}</p>
                {item.type === "goal" ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <ProgressRing value={item.percent ?? 0} size={28} strokeWidth={4} color="var(--purple)">
                      <span className="text-[8px] font-semibold">{item.percent ?? 0}%</span>
                    </ProgressRing>
                    <span className="text-xs text-muted-foreground">{item.note}</span>
                  </div>
                ) : (
                  <>
                    <p className="mt-0.5 text-[17px] leading-tight font-bold text-foreground tabular-nums">{formatCurrency(item.amount ?? 0)}</p>
                    <p className="text-[11px] text-muted-foreground">{item.note}</p>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => router.push(CTA_HREF[item.type])}
                  className={cn(
                    "mt-2 flex h-7 items-center rounded-[6px] px-2.5 text-xs font-semibold transition-colors",
                    item.cta === "Pay Now"
                      ? "border border-primary-accent-text bg-primary text-primary-foreground hover:opacity-90"
                      : "border border-border-strong bg-card text-foreground hover:bg-secondary",
                  )}
                >
                  {item.cta}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
