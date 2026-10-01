import { isPersonFunded, type Transaction } from "@/lib/models/transaction";

/**
 * What a transaction row shows where it normally names the account: the account's name, or — for an
 * expense a person paid directly (`Transaction.fundedByPersonId`, no account at all) — "Paid by <name>",
 * so it reads as intentional instead of "Unknown account". `null` when neither applies.
 */
export function paidFromLabel(
  transaction: Pick<Transaction, "fundedByPersonId">,
  accountName: string | undefined,
  personNameById?: ReadonlyMap<string, string>,
): string | null {
  if (isPersonFunded(transaction)) return `Paid by ${personNameById?.get(transaction.fundedByPersonId!) ?? "a person"}`;
  return accountName ?? null;
}
