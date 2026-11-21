import { Bike, CheckCircle2, CreditCard, Landmark, ShoppingBag } from "lucide-react";
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
  goal: "/savings",
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
 * "Needs your attention" — real Bill/Budget/Goal alerts from `useDashboardData`. A slim strip: the heading sits
 * beside the items on wide screens and every item is one compact row, so a single alert costs one line of height.
 * When nothing needs attention it collapses to a single calm line.
 */
export function AttentionRow({ items, isLoading }: AttentionRowProps) {
  const router = useRouter();

  if (isLoading) {
    return <Skeleton className="h-14 rounded-[12px]" />;
  }

  if (items.length === 0) {
    return (
      <section aria-label="Needs your attention" className={cn(DASH_PANEL, "flex items-center gap-2.5 px-4 py-2.5 text-sm")}>
        <CheckCircle2 className="size-4.5 shrink-0 text-success" />
        <span className="font-semibold text-foreground">All caught up.</span>
        <span className="text-muted-foreground">No bills need attention right now.</span>
      </section>
    );
  }

  return (
    <section aria-label="Needs your attention" className={cn(DASH_PANEL, "flex flex-col md:flex-row")}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-strong/45 bg-expense/[0.05] px-4 py-2 md:border-r md:pr-5 md:border-b-0 dark:bg-expense/10">
        <span className="relative flex size-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-expense/60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-expense" />
        </span>
        <h2 className="font-heading text-[14px] leading-tight font-semibold whitespace-nowrap text-foreground">Needs your attention</h2>
        <span className="ml-auto rounded-[4px] bg-expense/12 px-1.5 text-xs font-bold text-expense tabular-nums md:ml-0">{items.length}</span>
      </div>
      <div
        className={cn(
          "grid min-w-0 flex-1 grid-cols-1 [&>*]:border-border-strong/40 [&>*:not(:last-child)]:border-b",
          items.length > 1 && "xl:grid-cols-2 xl:[&>*]:border-b-0 xl:[&>*:nth-child(odd):not(:last-child)]:border-r xl:[&>*:nth-child(n+3)]:border-t",
        )}
      >
        {items.map((item) => {
          const style = STYLES[item.type];
          const Icon = style.icon;
          return (
            <div key={item.id} className="group relative flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40">
              <span className={cn("absolute inset-y-2.5 left-0 w-[3px] rounded-r-full", style.edge)} aria-hidden />
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-transform duration-200 group-hover:scale-105", style.iconClass)}>
                <Icon className="size-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-[10.5px] font-semibold tracking-[0.04em] uppercase", style.titleClass)}>{item.title}</p>
                <p className="truncate text-sm font-semibold text-foreground">{item.subtitle}</p>
              </div>
              {item.type === "goal" ? (
                <div className="flex shrink-0 items-center gap-2">
                  <ProgressRing value={item.percent ?? 0} size={28} strokeWidth={4} color="var(--purple)">
                    <span className="text-[8px] font-semibold">{item.percent ?? 0}%</span>
                  </ProgressRing>
                  <span className="max-w-40 truncate text-xs text-muted-foreground" title={item.note}>
                    {item.note}
                  </span>
                </div>
              ) : (
                <div className="shrink-0 text-right">
                  <p className="text-[15px] leading-tight font-bold text-foreground tabular-nums">{formatCurrency(item.amount ?? 0)}</p>
                  <p className="max-w-36 truncate text-[11px] text-muted-foreground" title={item.note}>
                    {item.note}
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={() => router.push(CTA_HREF[item.type])}
                className={cn(
                  "flex h-7 shrink-0 items-center rounded-[6px] px-2.5 text-xs font-semibold transition-[background-color,opacity,transform] active:scale-[0.97]",
                  item.cta === "Pay Now"
                    ? "border border-primary-accent-text bg-primary text-primary-foreground hover:opacity-90"
                    : "border border-border-strong bg-card text-foreground hover:bg-secondary",
                )}
              >
                {item.cta}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
