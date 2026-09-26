/**
 * A person's Loan history for the People activity feed — derived from the Loan (creation) and its
 * Loan-linked Transactions (payments, prepayments, Borrow/Lend More), never from legacy Loan-generated
 * ledger entries (those are filtered out by `isLegacyLoanLedgerEntry` so a Loan event is never shown
 * twice). The origination Transaction is skipped: the creation event already represents it. Trashed
 * Loans (including reversed originations) contribute nothing. Pure.
 */

import { isOriginationTransactionId } from "@/lib/engines/loan-origination";
import type { Loan } from "@/lib/models/loan";
import type { Transaction } from "@/lib/models/transaction";
import { loanTransactionLabel } from "@/features/loans/lib/loan-labels";

export interface PersonLoanActivity {
  /** `loan:{loanId}` for the creation event, `loan-txn:{transactionId}` for a Loan Transaction. */
  id: string;
  loanId: string;
  date: Date;
  description: string;
  amount: number;
  /** Effect on "they owe me": + raises it, − lowers it. */
  signedEffect: number;
}

export function personLoanActivity(
  personId: string,
  loans: readonly Loan[],
  transactions: readonly Pick<Transaction, "id" | "loanId" | "type" | "amount" | "dateTime" | "paymentAllocationType" | "deletedAt">[],
): PersonLoanActivity[] {
  const mine = loans.filter((l) => l.personId === personId && l.deletedAt == null);
  const byId = new Map(mine.map((l) => [l.id, l]));
  // Borrow/Lend More raises `loanAmount`; the creation event shows the original principal.
  const disbursedByLoan = new Map<string, number>();
  for (const t of transactions) {
    if (t.deletedAt != null || t.loanId == null || isOriginationTransactionId(t.id) || t.paymentAllocationType !== "additionalDisbursement") continue;
    disbursedByLoan.set(t.loanId, (disbursedByLoan.get(t.loanId) ?? 0) + t.amount);
  }
  const items: PersonLoanActivity[] = mine.map((loan) => {
    const name = loan.name?.trim();
    const original = loan.loanAmount - (disbursedByLoan.get(loan.id) ?? 0);
    const base = loan.direction === "given" ? "Lent" : "Borrowed";
    return {
      id: `loan:${loan.id}`,
      loanId: loan.id,
      date: loan.loanDate,
      description: name ? `${base} — ${name}` : base,
      amount: original,
      signedEffect: loan.direction === "given" ? original : -original,
    };
  });
  for (const t of transactions) {
    if (t.deletedAt != null || t.loanId == null || isOriginationTransactionId(t.id)) continue;
    const loan = byId.get(t.loanId);
    if (loan == null) continue;
    // Money into my account lowers "they owe me" (a repayment received, or Borrow More); money out
    // raises it (Lend More, or my repayment of a borrowed Loan) — whatever the Loan direction.
    const signedEffect = t.type === "income" ? -t.amount : t.amount;
    items.push({
      id: `loan-txn:${t.id}`,
      loanId: loan.id,
      date: t.dateTime,
      description: loanTransactionLabel({ ...t, id: t.id }, loan) ?? "Loan payment",
      amount: t.amount,
      signedEffect,
    });
  }
  return items.sort((a, b) => b.date.getTime() - a.date.getTime());
}
