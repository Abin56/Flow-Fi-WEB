/**
 * What the Loan UI should offer for a Loan created by the unified wizard: the plain "Move to Trash" or
 * the reversal-aware "Reverse & Delete", plus the confirmation copy. Derived from the live Transaction
 * and Account lists (both already watched by the page) — no extra read. The repository enforces the
 * same rule (`OriginationDeleteBlockedError`), so this only decides which button to show.
 */

import {
  originationIdsFor,
  originationKeyFromLoanId,
  originationMovementKindOf,
  originationReversalMessage,
} from "@/lib/engines/loan-origination";
import type { Transaction } from "@/lib/models/transaction";

export interface LoanOriginationUi {
  /** Null for Loans not created by the unified wizard (nothing to reverse). */
  idempotencyKey: string | null;
  /** True when the origination moved money that is still active — plain trash is not allowed. */
  moneyActive: boolean;
  /** Confirmation text for "Reverse & Delete". */
  message: string;
}

export function loanOriginationUi(
  loanId: string,
  transactions: Pick<Transaction, "id" | "type" | "amount" | "accountId" | "paymentAllocationType" | "deletedAt">[],
  accountNameById: (accountId: string) => string | undefined,
): LoanOriginationUi {
  const key = originationKeyFromLoanId(loanId);
  if (key == null) return { idempotencyKey: null, moneyActive: false, message: "" };
  const transactionId = originationIdsFor(key).transactionId;
  const origination = transactions.find((t) => t.id === transactionId && t.deletedAt == null) ?? null;
  return {
    idempotencyKey: key,
    moneyActive: origination != null,
    message: originationReversalMessage(
      origination == null
        ? null
        : { kind: originationMovementKindOf(origination), amount: origination.amount, accountName: accountNameById(origination.accountId) ?? "the account" },
    ),
  };
}
