import { Receipt, Smartphone, Wifi, Zap } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/finance/empty-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const ICONS: Record<string, typeof Receipt> = {
  "HDFC Credit Card": Receipt,
  "Airtel Mobile": Smartphone,
  "Electricity Bill": Zap,
  "Internet Bill": Wifi,
};

function chipClass(daysLeft: number) {
  if (daysLeft <= 3) return "bg-expense/12 text-expense";
  if (daysLeft <= 6) return "bg-warning/25 text-warning-foreground";
  return "bg-muted text-muted-foreground";
}

export interface UpcomingBillsCardProps {
  upcomingBills: {
    id: string;
    name: string;
    date: string;
    daysLeft: number;
  }[];
  isLoading?: boolean;
}

/** `upcomingBills` reads `Bill.nextDueDate` directly (soonest 4), via `useDashboardData`. */
export function UpcomingBillsCard({ upcomingBills, isLoading }: UpcomingBillsCardProps) {
  if (isLoading) {
    return (
      <section className="surface-flat flex h-full flex-col gap-3 rounded-3xl border border-border/50 p-5">
        <Skeleton className="h-4 w-32" />
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-xl" />
        ))}
      </section>
    );
  }

  return (
    <section className="surface-flat flex h-full flex-col rounded-3xl border border-border/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Upcoming Bills</h2>
        <Link href="/bills" className="text-xs font-semibold text-primary hover:underline">
          View All
        </Link>
      </div>

      {upcomingBills.length === 0 ? (
        <EmptyState icon={Receipt} title="No upcoming bills" description="Bills due soon will appear here." className="flex-1" />
      ) : (
      <div className="mt-3 flex flex-1 flex-col gap-1">
        {upcomingBills.map((bill) => {
          const Icon = ICONS[bill.name] ?? Receipt;
          return (
            <div key={bill.id} className="flex items-center gap-3 rounded-xl px-1 py-2 transition-colors hover:bg-muted/50">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{bill.name}</p>
                <p className="text-xs text-muted-foreground">{bill.date}</p>
              </div>
              <Badge className={cn("shrink-0 border-0 text-[10px]", chipClass(bill.daysLeft))}>
                {bill.daysLeft} days left
              </Badge>
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
