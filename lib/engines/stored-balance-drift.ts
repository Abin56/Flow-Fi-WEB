/**
 * READ-ONLY detectors for drift between a STORED running balance and the balance its own records imply
 * (web-financial-integrity-audit P0-01 / P0-03). Pure: nothing is written and nothing is repaired — a caller
 * may only report what these return. Repair is a separate, user-approved task.
 *
 * Both stored balances are maintained by deltas: every write that creates/edits/deletes/restores a movement
 * adjusts the cached figure in the same Firestore transaction. So for a document whose history went only
 * through those paths:
 *   Account.currentBalance === Account.openingBalance + Σ balanceEffect(active transactions on it)
 *   Person.currentBalance  === Person.openingBalance  + Σ signedAmount(active ledger entries)
 * A difference means a delta was applied twice / missed (e.g. the pre-fix double delete), or the document was
 * written outside the app's write paths. The detector cannot tell WHICH movement caused it.
 */

import { signedAmount, type LedgerEntry } from "@/lib/models/person";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";

const PAISE_TOLERANCE = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface BalanceDrift {
  id: string;
  stored: number;
  /** What the active records imply. */
  expected: number;
  /** stored − expected (positive: the stored balance is higher than its records explain). */
  drift: number;
}

/** Account balance drift, or null when the stored balance matches its active transactions to the paisa. */
export function accountBalanceDrift(
  account: { id: string; openingBalance: number; currentBalance: number },
  transactions: readonly Transaction[],
): BalanceDrift | null {
  const expected = round2(
    account.openingBalance +
      transactions.filter((t) => t.deletedAt == null && t.accountId === account.id).reduce((s, t) => s + balanceEffect(t), 0),
  );
  const drift = round2(account.currentBalance - expected);
  return Math.abs(drift) < PAISE_TOLERANCE ? null : { id: account.id, stored: account.currentBalance, expected, drift };
}

/** People stored-balance drift, or null when `Person.currentBalance` matches its active ledger entries. */
export function personBalanceDrift(
  person: { id: string; openingBalance: number; currentBalance: number },
  entries: readonly LedgerEntry[],
): BalanceDrift | null {
  const expected = round2(person.openingBalance + entries.filter((e) => e.deletedAt == null).reduce((s, e) => s + signedAmount(e), 0));
  const drift = round2(person.currentBalance - expected);
  return Math.abs(drift) < PAISE_TOLERANCE ? null : { id: person.id, stored: person.currentBalance, expected, drift };
}

export type SplitLinkDriftKind =
  /** The split's transaction is gone / trashed while the split itself is live. */
  | "transactionMissing"
  /** The transaction's amount differs from the split's total. */
  | "transactionAmount"
  /** The participants' shares don't add up to the split's total. */
  | "shareTotal"
  /** A participant's tracking installment is missing or doesn't owe their share. */
  | "installmentAmount"
  /** A person's live "gave" share entries on this split don't add up to their share. */
  | "peopleShare";

export interface SplitLinkDrift {
  kind: SplitLinkDriftKind;
  /** The participant concerned, when the drift is per person. */
  personId?: string | null;
  expected: number;
  actual: number;
}

/**
 * READ-ONLY consistency check of one live split/assigned Expense against the records it owns (audit P1-09):
 * its Transaction, each participant's tracking installment and each person's share entry on the split's
 * transaction (`transactionRef`). Returns every disagreement found — empty when consistent. Never writes.
 * `entriesByPerson`: the person's ledger entries whose `transactionRef` is the split's transaction (any state).
 * A disagreement after a manual People correction (an "Edited:" adjustment instead of the share entry) is
 * reported too — it needs a human look, not an automatic repair.
 */
export function splitLinkDrift(params: {
  expense: { totalAmount: number; deletedAt: Date | null; participants: readonly { personId: string | null; isMe: boolean; share: number; installmentId: string | null }[] };
  transaction: Pick<Transaction, "amount" | "deletedAt"> | null;
  installments: readonly { id: string; amountDue: number; deletedAt: Date | null }[];
  entriesByPerson: ReadonlyMap<string, readonly LedgerEntry[]>;
}): SplitLinkDrift[] {
  const { expense, transaction, installments, entriesByPerson } = params;
  if (expense.deletedAt != null) return [];
  const out: SplitLinkDrift[] = [];
  const differs = (a: number, b: number) => Math.abs(a - b) >= PAISE_TOLERANCE;
  if (transaction == null || transaction.deletedAt != null) out.push({ kind: "transactionMissing", expected: expense.totalAmount, actual: 0 });
  else if (differs(transaction.amount, expense.totalAmount)) out.push({ kind: "transactionAmount", expected: expense.totalAmount, actual: transaction.amount });
  const shares = round2(expense.participants.reduce((s, p) => s + p.share, 0));
  if (differs(shares, expense.totalAmount)) out.push({ kind: "shareTotal", expected: expense.totalAmount, actual: shares });
  const installmentById = new Map(installments.filter((i) => i.deletedAt == null).map((i) => [i.id, i]));
  for (const p of expense.participants) {
    if (p.isMe) continue;
    const inst = p.installmentId == null ? undefined : installmentById.get(p.installmentId);
    if (inst == null || differs(inst.amountDue, p.share)) out.push({ kind: "installmentAmount", personId: p.personId, expected: p.share, actual: inst?.amountDue ?? 0 });
    if (p.personId == null) continue;
    const gave = round2((entriesByPerson.get(p.personId) ?? []).filter((e) => e.deletedAt == null && e.type === "gave").reduce((s, e) => s + e.amount, 0));
    if (differs(gave, p.share)) out.push({ kind: "peopleShare", personId: p.personId, expected: p.share, actual: gave });
  }
  return out;
}
