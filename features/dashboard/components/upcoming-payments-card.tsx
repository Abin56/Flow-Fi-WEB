import Link from "next/link";
import { CalendarClock, CreditCard, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DASH_ROW, DashEmpty, DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
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
  /** A bill cycle already past due — shown as "Nd overdue", never as "due today" / "N days left". */
  overdue?: boolean;
}

export interface UpcomingPaymentsCardProps {
  payments: UpcomingPaymentItem[];
  isLoading?: boolean;
}

/**
 * `payments` merges `Bill.nextDueDate` and active `Statement.dueDate` (unpaid, via
 * `statementStatus` != "paid"), sorted soonest-first, via `useDashboardData`. The list scrolls inside the panel
 * so the dashboard row keeps a steady height however many payments are due.
 */
export function UpcomingPaymentsCard({ payments, isLoading }: UpcomingPaymentsCardProps) {
  return (
    <DashPanel label="Upcoming payments" className="h-auto">
      <DashPanelHeader
        icon={CalendarClock}
        title="Upcoming payments"
        href="/bills"
        compact
        aside={!isLoading && payments.length > 0 ? <span className="rounded-[4px] bg-secondary px-1.5 text-[11px] font-bold text-foreground/75 tabular-nums">{payments.length}</span> : undefined}
      />
      {isLoading ? (
        <div className="flex flex-col gap-1.5 p-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full rounded" />
          ))}
        </div>
      ) : payments.length === 0 ? (
        <DashEmpty
          title="Nothing due soon"
          description="Upcoming bills and card statements will appear here."
          compact
          action={
            <Link href="/loans" className="text-xs font-semibold text-primary-accent-text hover:underline">
              Track a loan or EMI
            </Link>
          }
        />
      ) : (
        <div className="max-h-40 divide-y divide-border-strong/35 overflow-y-auto">
          {payments.map((payment) => {
            const Icon = payment.type === "statement" ? CreditCard : Receipt;
            return (
              <div key={payment.id} className={cn(DASH_ROW, "group")}>
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md transition-transform duration-200 group-hover:scale-105",
                    payment.type === "statement" ? "bg-purple/12 text-purple" : "bg-primary/20 text-foreground dark:text-primary-accent-text",
                  )}
                >
                  <Icon className="size-3" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs leading-4 font-semibold text-foreground">{payment.title}</p>
                  <p className="truncate text-[11px] leading-3.5 text-muted-foreground">
                    {payment.subtitle} · {payment.date}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <p className="text-xs leading-4 font-bold text-foreground tabular-nums">{formatCurrency(payment.amount)}</p>
                  <span className={cn("rounded-[4px] px-1.5 text-[10.5px] leading-[1.45] font-semibold", payment.overdue ? "bg-expense/12 text-expense" : chipClass(payment.daysLeft))}>
                    {payment.overdue ? `${Math.abs(payment.daysLeft)}d overdue` : payment.daysLeft <= 0 ? "Due today" : `${payment.daysLeft}d left`}
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
