import Link from "next/link";
import { CalendarClock, CreditCard, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DashEmpty, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

function chipClass(daysLeft: number) {
  if (daysLeft <= 3) return "bg-expense/12 text-expense";
  if (daysLeft <= 6) return "bg-warning/20 text-warning-foreground dark:text-warning";
  return "bg-secondary text-foreground/75";
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
 * `statementStatus` != "paid"), sorted soonest-first, via `useDashboardData`.
 */
export function UpcomingPaymentsCard({ payments, isLoading }: UpcomingPaymentsCardProps) {
  return (
    <DashPanel label="Upcoming payments">
      <DashPanelHeader icon={CalendarClock} title="Upcoming payments" href="/bills" />
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-[6px]" />
          ))}
        </div>
      ) : payments.length === 0 ? (
        <DashEmpty
          title="Nothing due soon"
          description="Upcoming bills and card statements will appear here."
          action={
            <Link href="/loans" className="text-xs font-semibold text-primary-accent-text hover:underline">
              Track a loan or EMI
            </Link>
          }
        />
      ) : (
        <div className="max-h-80 divide-y divide-border-strong/40 overflow-y-auto">
          {payments.map((payment) => {
            const Icon = payment.type === "statement" ? CreditCard : Receipt;
            return (
              <div key={payment.id} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/50">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", payment.type === "statement" ? "bg-purple/12 text-purple" : "bg-primary/20 text-foreground dark:text-primary-accent-text")}>
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{payment.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {payment.subtitle} · {payment.date}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <p className="text-[16px] font-bold text-foreground tabular-nums">{formatCurrency(payment.amount)}</p>
                  <span className={cn("rounded-[4px] px-1.5 text-[10.5px] font-semibold", chipClass(payment.daysLeft))}>
                    {payment.daysLeft <= 0 ? "Due today" : `${payment.daysLeft}d left`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashPanel>
  );
}
