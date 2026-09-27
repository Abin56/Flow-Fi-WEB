/**
 * Permanent deletion of a Loan/EMI entered by mistake — the pure half. Given the agreement's records as
 * read FRESH (inside the deleting Firestore transaction), decides what it owns and how every stored
 * financial effect is taken back out, so the end state equals "this agreement never existed".
 *
 * Ownership is decided ONLY by persisted links — never by amount, date or text:
 *   - a Transaction is owned when it carries this agreement's back-reference (`loanId` / `emiId`), or when
 *     one of this agreement's own payment / disbursement records names it (`transactionId`). That covers
 *     the creation (origination) movement, every recorded payment (regular, advance, partial, extra
 *     principal), every Borrow/Lend More, and a card-linked EMI's card charges;
 *   - a linked card purchase (`purchaseTransactionId`) is NEVER owned: it is the user's real purchase that
 *     existed before the agreement was set up on top of it;
 *   - a People-ledger entry is owned when `transactionRef === agreement id` (legacy Loan-generated entries,
 *     `loan-ledger-sync.ts`).
 *
 * Everything else a Loan/EMI contributes — outstanding, dues/bills, Net Worth, card locked credit, People
 * loan position, dashboard/cash-flow/reports — is DERIVED from the agreement document and its installments,
 * so removing those records is what removes it; nothing is patched by hand.
 *
 * Stored effects reversed exactly once: an owned Transaction still active has its balance effect taken back
 * out of its account (already-reversed ones were reversed when soft-deleted and are only removed); an owned
 * ledger entry still active has its signed amount taken back out of the Person's balance.
 */

import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import { signedAmount, type LedgerEntry } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

export type AgreementKind = "loan" | "emi";

/** Firestore allows 500 writes per transaction; the money-reversal step must fit in ONE of them. */
export const MAX_ATOMIC_DELETION_WRITES = 480;

export interface AgreementDeletionInput {
  kind: AgreementKind;
  agreementId: string;
  /** The linked card purchase — independent history, never removed. */
  purchaseTransactionId: string | null;
  /** Transaction ids named by this agreement's own payment / disbursement records. */
  referencedTransactionIds: string[];
  /** Candidate Transactions: everything carrying the back-reference plus everything referenced above. */
  transactions: Transaction[];
  /** Ledger entries with `transactionRef === agreementId`, active and trashed. */
  ledgerEntries: LedgerEntry[];
  /** Split/shared expenses built on top of any owned Transaction (`expense.transactionId`). */
  dependentExpenseTransactionIds: string[];
}

export interface AgreementDeletionPlan {
  ownedTransactions: Transaction[];
  /** Net change per account — each still-active owned movement undone once. */
  accountDeltas: Map<string, number>;
  /** Change to the linked Person's balance — each still-active owned ledger entry undone once. */
  personDelta: number;
  ledgerEntryIds: string[];
}

/** Why a permanent deletion can't run — the user is told exactly this, nothing is written. */
export class AgreementDeletionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgreementDeletionBlockedError";
  }
}

export function isOwnedTransaction(t: Pick<Transaction, "id" | "loanId" | "emiId">, input: Pick<AgreementDeletionInput, "kind" | "agreementId" | "purchaseTransactionId" | "referencedTransactionIds">): boolean {
  if (input.purchaseTransactionId != null && t.id === input.purchaseTransactionId) return false;
  const backRef = input.kind === "loan" ? t.loanId === input.agreementId : t.emiId === input.agreementId;
  return backRef || input.referencedTransactionIds.includes(t.id);
}

export function planAgreementDeletion(input: AgreementDeletionInput): AgreementDeletionPlan {
  const unique = Array.from(new Map(input.transactions.map((t) => [t.id, t])).values());
  const ownedTransactions = unique.filter((t) => isOwnedTransaction(t, input));
  const ownedIds = new Set(ownedTransactions.map((t) => t.id));

  // A split/shared expense the user built on one of these Transactions is their own later history with its
  // own People effects — never deleted as a side effect, so the deletion stops and says so.
  if (input.dependentExpenseTransactionIds.some((id) => ownedIds.has(id))) {
    throw new AgreementDeletionBlockedError(
      `A shared or split expense was created from one of this ${input.kind === "loan" ? "loan" : "EMI"}'s payments. Delete that expense first, then delete this ${input.kind === "loan" ? "loan" : "EMI"}.`,
    );
  }

  const active = ownedTransactions.filter((t) => t.deletedAt == null);
  const accountDeltas = new Map([...netBalanceDeltas(active, [])].filter(([, delta]) => delta !== 0));
  const entries = Array.from(new Map(input.ledgerEntries.map((e) => [e.id, e])).values()).filter((e) => e.transactionRef === input.agreementId);
  const personDelta = Math.round(entries.filter((e) => e.deletedAt == null).reduce((sum, e) => sum - signedAmount(e), 0) * 100) / 100;
  return { ownedTransactions, accountDeltas, personDelta, ledgerEntryIds: entries.map((e) => e.id) };
}

/** Writes the atomic money step performs: accounts, removed Transactions, Person + entries, the agreement and its schedule marker. */
export function atomicWriteCount(plan: AgreementDeletionPlan): number {
  return plan.accountDeltas.size + plan.ownedTransactions.length + (plan.personDelta !== 0 ? 1 : 0) + plan.ledgerEntryIds.length + 2;
}
