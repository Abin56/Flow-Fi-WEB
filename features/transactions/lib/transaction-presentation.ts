/**
 * Transactions list — PRESENTATION classification only. Maps a transaction's authoritative metadata
 * (`transferId`, the card account on either transfer leg, `loanId` / `emiId` / `paymentAllocationType`,
 * `isPersonLedgerMovement`, `type`) to how its row reads. Never looks at the description, never at the
 * amount's sign alone, and changes nothing about the transaction itself.
 *
 *   income              green filled row        — money genuinely came in
 *   expense             plain row               — money spent
 *   settlement kinds    neutral row + rail + ✓  — an obligation was paid / reduced
 *   borrowing / lending violet debt row          — an obligation was created
 *   transfer            grey row                — money moved between my own accounts
 */

import { isLoanPrincipalDisbursement, type Transaction } from "@/lib/models/transaction";

export type TransactionSemanticKind =
  | "income"
  | "expense"
  | "transfer"
  | "cardPayment"
  | "emiPayment"
  | "loanPayment"
  | "loanRepaymentReceived"
  | "borrowing"
  | "lending"
  | "personReceived"
  | "personRepaid"
  | "borrowedFromPerson";

export type RowTreatment = "income" | "expense" | "transfer" | "debt" | "borrowed" | "settled";

export interface TransactionPresentation {
  kind: TransactionSemanticKind;
  row: RowTreatment;
  /** Type column badge, e.g. "Income", "EMI payment". */
  label: string;
  /** Type column second line, e.g. "Paid back to person". */
  detail: string;
  /** Under the amount: "Money in", "Money out", or the completion word ("EMI paid", "Repaid"). */
  status: string;
  /** Money entered this account (sign / arrow) — from the stored type of this leg. */
  incoming: boolean;
  /** Completed / reduced an obligation — shows the ✓ marker and the settlement rail. */
  settled: boolean;
}

type Tx = Pick<Transaction, "type" | "transferId" | "loanId" | "emiId" | "paymentAllocationType" | "isPersonLedgerMovement">;

/**
 * @param borrowedFromPerson — this is the cash leg of a People "borrowed" ledger entry (`LedgerEntry.transactionRef`).
 * @param touchesCard — for a transfer: this leg's or its paired leg's account is a card account (a card
 *   bill payment — the same rule the Add/Edit popup uses). Account data, not the description.
 */
export function getTransactionPresentation(
  t: Tx,
  { touchesCard = false, borrowedFromPerson = false }: { touchesCard?: boolean; borrowedFromPerson?: boolean } = {},
): TransactionPresentation {
  const incoming = t.type === "income";
  const make = (kind: TransactionSemanticKind, row: RowTreatment, label: string, detail: string, status: string): TransactionPresentation => ({
    kind, row, label, detail, status, incoming, settled: row === "settled",
  });

  if (t.transferId != null) {
    if (touchesCard) return make("cardPayment", "settled", "Card payment", "Credit card bill payment", "Card bill paid");
    return make("transfer", "transfer", "Transfer", incoming ? "Received" : "Sent", incoming ? "Transfer received" : "Transfer sent");
  }
  if (isLoanPrincipalDisbursement(t)) {
    return incoming ? make("borrowing", "borrowed", "Borrowed", "Borrowed money", "You need to repay") : make("lending", "debt", "Loan", "Lent", "Lent");
  }
  if (t.isPersonLedgerMovement) {
    // People cash legs: Borrowed / Received Back come in; Repaid (and Record Payment "I paid") go out.
    // A People "Borrowed" entry's own cash leg (known from the ledger, never the description): money in that must be repaid.
    if (incoming && borrowedFromPerson) return make("borrowedFromPerson", "borrowed", "Borrowed", "Borrowed money", "You need to repay");
    return incoming
      ? make("personReceived", "debt", "People", "Received from person", "Received from person")
      : make("personRepaid", "settled", "People", "Paid back to person", "Repaid");
  }
  if (t.emiId != null && !incoming) return make("emiPayment", "settled", "EMI payment", "EMI repayment", "EMI paid");
  if (t.loanId != null) {
    // A Loan payment transaction: out = I repaid a loan I took; in = a borrower repaid me. Neither is income.
    return incoming
      ? make("loanRepaymentReceived", "settled", "Loan repayment", "Repayment received", "Repaid to you")
      : make("loanPayment", "settled", "Loan repayment", "Loan repayment", "Paid");
  }
  return incoming ? make("income", "income", "Income", "Income", "Money in") : make("expense", "expense", "Expense", "Expense", "Money out");
}
