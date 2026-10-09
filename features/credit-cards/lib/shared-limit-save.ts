/**
 * Add/Edit Card dialog helpers. The save itself is one Firestore transaction
 * (`lib/repositories/credit-card-save.ts`); this only supplies its per-dialog ids and friendly defaults.
 */

import type { CardNetwork } from "@/lib/models/credit-card";
import { generateId } from "@/lib/utils/id-generator";

/** Ids for every document a dialog session might create — generated once when it opens, reused by retries. */
export function freshCardSaveIds() {
  return {
    sharedLimitId: generateId(),
    primaryAccountId: generateId(),
    primaryCardId: generateId(),
    pairAccountId: generateId(),
    pairCardId: generateId(),
  };
}

type BankLike = { id: string; shortCode: string; name: string } | null;
const bankLabel = (bank: BankLike) => (bank == null || bank.id === "generic" ? null : bank.shortCode || bank.name);

/** Optional shared-limit label → `HDFC Shared Limit` from the bank's short code (or its name). */
export function defaultSharedLimitName(bank: BankLike): string {
  const label = bankLabel(bank);
  return label ? `${label} Shared Limit` : "Shared Limit";
}

/** Optional card name → "HDFC Visa", "HDFC RuPay", or "HDFC •••• 7960" without a network. */
export function autoCardName(bank: BankLike, network: CardNetwork | null, last4: string): string {
  const label = bankLabel(bank) ?? "Credit Card";
  const networkName: Record<CardNetwork, string> = { visa: "Visa", mastercard: "Mastercard", rupay: "RuPay", amex: "Amex" };
  return network ? `${label} ${networkName[network] ?? network}` : `${label} •••• ${last4}`;
}

/** A typical due day ~20 days after the statement day (wrapping the month). */
export function suggestedDueDay(statementDay: number): number {
  const d = statementDay + 20;
  return d > 31 ? d - 31 : d;
}
