import type { DestructiveDeleteImpactRow, DestructiveDeleteWarningRow } from "@/components/finance";
import { formatCurrency } from "@/lib/format";
import type { AccountDeletionImpact } from "@/lib/repositories/account-deletion";
import type { CreditCardDeletionImpact } from "@/lib/repositories/credit-card-deletion";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "What will be permanently deleted" rows for the destructive-delete dialog — an Account or a Credit Card. */
export function deletionImpactRows(
  impact: AccountDeletionImpact | CreditCardDeletionImpact,
  entityLabel: "account" | "card",
): DestructiveDeleteImpactRow[] {
  const isCard = "emiCount" in impact;
  return [
    { label: plural(impact.transactionCount, "transaction"), count: impact.transactionCount },
    { label: `${plural(impact.transferSiblingCount, "linked transfer")} on other accounts`, count: impact.transferSiblingCount },
    { label: plural(impact.expenseCount, "shared/assigned expense"), count: impact.expenseCount },
    { label: plural(impact.ledgerEntryCount, "people's ledger entry", "people's ledger entries"), count: impact.ledgerEntryCount },
    {
      label: `${impact.affectedPersonCount} person${impact.affectedPersonCount === 1 ? "'s" : "s'"} balance will be recalculated`,
      count: impact.affectedPersonCount,
    },
    { label: plural(impact.agreementLoanCount, "loan"), count: impact.agreementLoanCount },
    { label: plural(isCard ? impact.emiCount : impact.agreementEmiCount, "EMI"), count: isCard ? impact.emiCount : impact.agreementEmiCount },
    {
      label: `${plural(impact.agreementLegCount, "loan/EMI payment")} on other accounts (those balances are corrected)`,
      count: impact.agreementLegCount,
    },
    { label: `${plural(impact.billCount, "bill")} paying from this ${entityLabel}`, count: impact.billCount },
    ...(isCard
      ? [
          { label: plural(impact.statementCount, "statement"), count: impact.statementCount },
          { label: "Shared credit limit will also be removed (no other card uses it)", count: impact.sharedLimitWillBeRemoved ? 1 : 0 },
        ]
      : []),
  ];
}

/** One prominent warning row per loan / EMI / person balance that is still unsettled and would be lost. */
export function deletionWarningRows(impact: AccountDeletionImpact | CreditCardDeletionImpact): DestructiveDeleteWarningRow[] {
  return impact.unsettled.map((item) => {
    const money = formatCurrency(item.amount);
    if (item.kind === "person") {
      return {
        title: `People ledger — ${item.name}`,
        detail: item.direction === "owedToMe" ? `${item.name} still owes you ${money}.` : `You still owe ${item.name} ${money}.`,
      };
    }
    const label = item.kind === "loan" ? "Loan" : "EMI";
    const pending = item.pendingInstallments != null ? ` across ${plural(item.pendingInstallments, "unpaid installment")}` : "";
    return {
      title: `${label} — ${item.name}`,
      detail:
        item.direction === "owedToMe"
          ? `${money} still to be collected${pending}.`
          : `${money} still left to pay${pending}.`,
    };
  });
}
