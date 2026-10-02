/**
 * Historical split-expense ghosts: an Expense (split / assigned) still active, with its People shares,
 * although the Transaction it belongs to (`Expense.transactionId`) was deleted on its own — the old
 * Transaction Studio delete did that. Ownership is explicit: `Expense.transactionId` is always a
 * Transaction id, and the shares are the entries whose `transactionRef` is that same id.
 *
 * A ghost is repaired ONLY when no real money has moved against it. Any of these blocks the repair and
 * is reported instead, so payment history is never destroyed:
 *  - an installment with `amountPaid > 0` (a settlement recorded through the expense);
 *  - a "receivedBack"/"repaid" entry on that transaction (incl. "Received:" cash collected at the table);
 *  - an entry recorded against one of the shares (`parentEntryId`) or against one of its installments
 *    (`installmentPaymentRef`) — a Record Payment;
 *  - advance applied to one of the shares.
 *
 * Pure — `repairSplitGhost` (lib/services) re-reads everything fresh and then uses the authoritative
 * `ExpenseRepository.deleteExpense`; nothing here writes.
 */

import type { Expense } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import type { AdvanceApplication, LedgerEntry } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

export interface SplitGhostDependentPayment {
  kind: "installmentPayment" | "settlementEntry" | "receivedAtSplit" | "advanceApplication";
  /** Installment / ledger entry / advance-application id — for diagnostics, not shown in normal UI. */
  id: string;
  amount: number;
}

export interface SplitGhostDiagnostic {
  personId: string | null;
  personName: string;
  /** This person's share of the expense. */
  amount: number;
  expenseId: string;
  transactionId: string;
  dependentPayments: SplitGhostDependentPayment[];
}

export type SplitGhostVerdict =
  | { kind: "notGhost" }
  | { kind: "repair"; expenseId: string; transactionId: string }
  | { kind: "blocked"; reason: "paymentHistory"; expenseId: string; transactionId: string; diagnostics: SplitGhostDiagnostic[] };

export interface SplitGhostInput {
  expense: Expense;
  /** The expense's transaction (active or trashed); `null` = does not exist; `undefined` = unknown. */
  transaction: Pick<Transaction, "id" | "deletedAt"> | null | undefined;
  /** The expense schedule's installments (active). */
  installments: readonly Installment[];
  /** Ledger entries (active) of every person in the split, by person id. */
  entriesByPersonId: Readonly<Record<string, readonly LedgerEntry[]>>;
  /** Advance applications (active) of every person in the split, by person id. */
  advanceApplicationsByPersonId?: Readonly<Record<string, readonly AdvanceApplication[]>>;
}

export function classifySplitGhost({ expense, transaction, installments, entriesByPersonId, advanceApplicationsByPersonId = {} }: SplitGhostInput): SplitGhostVerdict {
  if (expense.deletedAt != null || transaction === undefined) return { kind: "notGhost" };
  if (transaction != null && transaction.deletedAt == null) return { kind: "notGhost" };
  const transactionId = expense.transactionId;
  const scheduleId = expense.scheduleId;

  const diagnostics: SplitGhostDiagnostic[] = [];
  for (const participant of expense.participants) {
    if (participant.isMe) continue;
    const payments: SplitGhostDependentPayment[] = [];
    const installment = participant.installmentId ? installments.find((i) => i.id === participant.installmentId && i.deletedAt == null) : undefined;
    if (installment && installment.amountPaid > 0) payments.push({ kind: "installmentPayment", id: installment.id, amount: installment.amountPaid });

    const entries = participant.personId ? (entriesByPersonId[participant.personId] ?? []).filter((e) => e.deletedAt == null) : [];
    const shareIds = new Set(entries.filter((e) => e.transactionRef === transactionId && e.type === "gave").map((e) => e.id));
    for (const e of entries) {
      if (e.transactionRef === transactionId && (e.type === "receivedBack" || e.type === "repaid")) {
        payments.push({ kind: "receivedAtSplit", id: e.id, amount: e.amount });
      } else if ((e.parentEntryId != null && shareIds.has(e.parentEntryId)) || (scheduleId != null && e.installmentPaymentRef?.startsWith(`${scheduleId}/`))) {
        payments.push({ kind: "settlementEntry", id: e.id, amount: e.amount });
      }
    }
    const applications = participant.personId ? (advanceApplicationsByPersonId[participant.personId] ?? []) : [];
    for (const a of applications) {
      if (a.deletedAt == null && shareIds.has(a.obligationKey.replace(/^ledger:/, ""))) payments.push({ kind: "advanceApplication", id: a.id, amount: a.amount });
    }
    if (payments.length > 0) {
      diagnostics.push({ personId: participant.personId, personName: participant.name, amount: participant.share, expenseId: expense.id, transactionId, dependentPayments: payments });
    }
  }

  return diagnostics.length > 0
    ? { kind: "blocked", reason: "paymentHistory", expenseId: expense.id, transactionId, diagnostics }
    : { kind: "repair", expenseId: expense.id, transactionId };
}
