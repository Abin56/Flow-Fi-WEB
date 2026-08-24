import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

interface CurrencyCellProps {
  amount: number;
  /** When true, positive amounts render in --color-success and no sign; negative render in --color-expense. */
  signed?: boolean;
  className?: string;
}

/** Tabular-nums currency cell — income green, expense/negative in the expense tone, neutral otherwise. */
export function CurrencyCell({ amount, signed = true, className }: CurrencyCellProps) {
  const isNegative = amount < 0;
  const isPositive = amount > 0;
  return (
    <span
      className={cn(
        "font-mono text-sm tabular-nums",
        signed && isPositive && "text-success",
        signed && isNegative && "text-expense",
        !signed && "text-foreground",
        className,
      )}
    >
      {isPositive && signed ? "+" : ""}
      {formatCurrency(amount)}
    </span>
  );
}

interface DateCellProps {
  date: Date | string;
  className?: string;
}

function toDate(date: Date | string): Date {
  return typeof date === "string" ? new Date(date) : date;
}

/** Relative-ish date label: Today / Yesterday / "N days ago" within a week, short date otherwise. */
export function DateCell({ date, className }: DateCellProps) {
  const d = toDate(date);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);

  let label: string;
  if (diffDays === 0) label = "Today";
  else if (diffDays === 1) label = "Yesterday";
  else if (diffDays > 1 && diffDays <= 6) label = `${diffDays} days ago`;
  else
    label = d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });

  return <span className={cn("text-sm text-muted-foreground", className)}>{label}</span>;
}
