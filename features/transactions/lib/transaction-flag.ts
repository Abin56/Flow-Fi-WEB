/**
 * Port of `Finance_App/lib/shared/widgets/states/transaction_flag_badge.dart`
 * (`TransactionFlagBadge`) — the same "Not counted" / "Counted in {Month}"
 * indicator the mobile app shows wherever a transaction's balance-effect
 * has been altered by `excludeFromCalculations` or `accountingMonth`. Takes
 * primitive fields (not a `Transaction`) so it's reusable in both the table
 * row and the Transaction Manager popup.
 */

const MONTH_FORMAT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export interface TransactionFlagInput {
  dateTime: Date;
  excludeFromCalculations: boolean;
  accountingMonth: Date | null;
}

export type TransactionFlag = { kind: "excluded"; label: "Not counted" } | { kind: "reassigned"; label: string } | null;

/** Mirrors `TransactionFlagBadge`'s label logic exactly — excluded takes priority over a reassigned month. */
export function transactionFlagFor({ dateTime, excludeFromCalculations, accountingMonth }: TransactionFlagInput): TransactionFlag {
  if (excludeFromCalculations) return { kind: "excluded", label: "Not counted" };
  if (accountingMonth != null && !isSameMonth(accountingMonth, dateTime)) {
    return { kind: "reassigned", label: `Counted in ${MONTH_FORMAT.format(accountingMonth)}` };
  }
  return null;
}

export function formatMonthYear(date: Date): string {
  return MONTH_FORMAT.format(date);
}
