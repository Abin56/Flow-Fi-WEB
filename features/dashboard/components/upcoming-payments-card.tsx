import { CalendarClock, CreditCard, Receipt } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/finance/empty-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function chipClass(daysLeft: number) {
  if (daysLeft <= 3) return "bg-expense/12 text-expense";
  if (daysLeft <= 6) return "bg-warning/25 text-warning-foreground";
  return "bg-muted text-muted-foreground";
}

export interface UpcomingPaymentItem {
  id: string;
  type: "bill" | "statement";
  title: string;
  subtitle: string;
  amount: number;
  date: string;
  daysLeft: number;
}

export interface UpcomingPaymentsCardProps {
  payments: UpcomingPaymentItem[];
  isLoading?: boolean;
}

/**
 * `payments` merges `Bill.nextDueDate` and active `Statement.dueDate` (unpaid, via
 * `statementStatus` != "paid"), sorted soonest-first, via `useDashboardData`. EMI
 * installments aren't joined in — no ready per-schedule "next due" read for this pass.
 */
export function UpcomingPaymentsCard({ payments, isLoading }: UpcomingPaymentsCardProps) {
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
        <h2 className="text-sm font-semibold text-foreground">Upcoming Payments</h2>
        <Link href="/bills" className="text-xs font-semibold text-primary hover:underline">
          View All
        </Link>
      </div>

      {payments.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing due soon" description="Upcoming bills and statements will appear here." className="flex-1" />
      ) : (
        <div className="mt-3 flex flex-1 flex-col gap-1">
          {payments.map((payment) => {
            const Icon = payment.type === "statement" ? CreditCard : Receipt;
            return (
              <div key={payment.id} className="flex items-center gap-3 rounded-xl px-1 py-2 transition-colors hover:bg-muted/50">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{payment.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {payment.subtitle} · {payment.date}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{formatCurrency(payment.amount)}</p>
                <Badge className={cn("shrink-0 border-0 text-[10px]", chipClass(payment.daysLeft))}>
                  {payment.daysLeft <= 0 ? "Due today" : `${payment.daysLeft}d left`}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
