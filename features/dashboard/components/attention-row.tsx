import { Bike, CheckCircle2, CreditCard, Landmark, ShoppingBag } from "lucide-react";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const STYLES = {
  bill: { icon: CreditCard, iconClass: "bg-expense/12 text-expense", titleClass: "text-expense" },
  emi: { icon: Landmark, iconClass: "bg-expense/12 text-expense", titleClass: "text-expense" },
  budget: { icon: ShoppingBag, iconClass: "bg-warning/25 text-warning-foreground", titleClass: "text-warning-foreground" },
  goal: { icon: Bike, iconClass: "bg-purple/14 text-purple", titleClass: "text-purple" },
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
 * One flat "Needs Your Attention" card with up to 4 items in a row — replaces the old floating-ribbon bill dock
 * with the reference design's plain grid-of-alerts card.
 *
 * `items` is built in `useDashboardData` from real Bill/Budget-Insight data — EMI and Savings-Goal alert types
 * are never produced (no ported repository for either yet), so this renders whatever real alerts exist rather
 * than a fixed count of four.
 */
export function AttentionRow({ items, isLoading }: AttentionRowProps) {
  if (isLoading) {
    return (
      <section className="surface-flat rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="surface-flat rounded-3xl border border-border/50 p-5">
      <h2 className="text-sm font-semibold text-foreground">Needs Your Attention</h2>

      {items.length === 0 ? (
        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-border/40 p-4 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4.5 text-success" />
          You&apos;re all caught up — no bills or budgets need attention right now.
        </div>
      ) : (
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const style = STYLES[item.type];
          const Icon = style.icon;

          return (
            <div key={item.id} className="flex items-start gap-3 rounded-2xl border border-border/40 p-3">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", style.iconClass)}>
                <Icon className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-xs font-semibold", style.titleClass)}>{item.title}</p>
                <p className="truncate text-sm font-medium text-foreground">{item.subtitle}</p>

                {item.type === "goal" ? (
                  <div className="mt-2 flex items-center gap-2">
                    <ProgressRing value={item.percent ?? 0} size={28} strokeWidth={4} color="var(--purple)">
                      <span className="text-[8px] font-semibold">{item.percent ?? 0}%</span>
                    </ProgressRing>
                    <span className="text-xs text-muted-foreground">{item.note}</span>
                  </div>
                ) : (
                  <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                    {formatCurrency(item.amount ?? 0)}
                  </p>
                )}

                <div className="mt-2">
                  {item.cta === "Pay Now" ? (
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      title="Coming soon"
                      className="cursor-not-allowed rounded-full bg-expense/12 px-3 py-1 text-[11px] font-semibold text-expense opacity-50 transition-colors"
                    >
                      {item.cta}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      title="Coming soon"
                      className={cn("cursor-not-allowed text-[11px] font-semibold opacity-50 transition-colors", style.titleClass)}
                    >
                      {item.cta}
                    </button>
                  )}
                  {item.type !== "goal" && <p className="mt-1 text-[11px] text-muted-foreground">{item.note}</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
