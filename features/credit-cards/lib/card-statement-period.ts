import type { CardBill } from "@/lib/engines/card-cycle-bills";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { statementWindowForDate } from "@/lib/repositories/credit-card-repository";

const monthDay = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
const fullDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function formatCardStatementDate(date: Date): string {
  return fullDate.format(date);
}

export function formatCardStatementPeriod({ periodStart, periodEnd }: Pick<CardBill, "periodStart" | "periodEnd">): string {
  const startFormat = periodStart.getFullYear() === periodEnd.getFullYear() ? monthDay : fullDate;
  return `${startFormat.format(periodStart)} – ${fullDate.format(periodEnd)}`;
}

export function cardStatementCycles(
  card: CreditCardProfile,
  bills: readonly CardBill[],
  payable: CardBill | null,
  now: Date = new Date(),
) {
  const next = statementWindowForDate(card, now);
  const previousDay = new Date(next.periodStart);
  previousDay.setDate(previousDay.getDate() - 1);
  const previous = statementWindowForDate(card, previousDay);
  const previousCloseMonth = new Date(previous.periodEnd.getFullYear(), previous.periodEnd.getMonth(), 1);
  const latest = bills.reduce<CardBill | null>((last, bill) => {
    if (!bill.isClosed || bill.periodEnd < previousCloseMonth) return last;
    return last == null || bill.periodEnd > last.periodEnd ? bill : last;
  }, null);
  const bill = payable ?? latest;
  return { bill, statement: bill ?? previous, next, payable: payable != null };
}
