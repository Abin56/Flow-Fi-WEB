import { ArrowLeftRight, CreditCard, HandCoins, Landmark, ReceiptText, Smartphone, Users, Wallet } from "lucide-react";
import type { ActivityItem, ActivityKind } from "@/features/activity/lib/activity-classify";
import { cn } from "@/lib/utils";

const ICON: Record<ActivityKind, typeof Wallet> = {
  expense: Wallet,
  income: Wallet,
  splitExpense: Users,
  personFunded: Users,
  peopleMovement: HandCoins,
  loanPayment: Landmark,
  loanAgreement: Landmark,
  emiPayment: Smartphone,
  billPayment: ReceiptText,
  transfer: ArrowLeftRight,
  cardPayment: CreditCard,
};

/** The action's type icon, tinted by direction (money in / out / between my accounts); muted once reversed. */
export function ActivityIcon({ item, className }: { item: ActivityItem; className?: string }) {
  const Icon = ICON[item.kind];
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full",
        item.state !== "active"
          ? "bg-muted text-muted-foreground"
          : item.direction === "in"
            ? "bg-success/16 text-success"
            : item.direction === "out"
              ? "bg-expense/12 text-expense"
              : "bg-primary/14 text-foreground",
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}
