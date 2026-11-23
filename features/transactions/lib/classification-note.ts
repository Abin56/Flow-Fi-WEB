/**
 * A plain-words classification for a transaction that is NOT ordinary income or spending — so the edit view says what
 * the money really is ("Money borrowed from ABIN — a loan you repay, not income") instead of just "Income".
 * Read-only: it describes existing records (the transaction's flags and its People ledger entry type) and changes
 * nothing. Returns null for ordinary transactions. Pure.
 */

import type { LedgerEntryType } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

export interface ClassificationNote {
  title: string;
  detail: string;
}

export function classificationNote(
  t: Pick<Transaction, "type" | "isPersonLedgerMovement" | "loanId" | "emiId" | "paymentAllocationType" | "linkedPersonId" | "owesPersonToggle">,
  ctx: { entryType: LedgerEntryType | null; personName: string | null },
): ClassificationNote | null {
  const who = ctx.personName?.trim() || "this person";
  if (t.isPersonLedgerMovement) {
    switch (ctx.entryType) {
      case "borrowed":
        return { title: `Money borrowed from ${who}`, detail: `A loan you must repay — it is a liability, not income. It raised this account once and is not in your income reports.` };
      case "receivedBack":
        return { title: `Payment received from ${who}`, detail: `${who} paying back money they owed you — not income.` };
      case "repaid":
        return { title: `Paid back to ${who}`, detail: `Repaying money you owed — not a personal expense.` };
      case "gave":
        return { title: `Money given to ${who}`, detail: `Money you lent — ${who} owes you. A receivable, not your own spending.` };
      default:
        return t.type === "income"
          ? { title: `Money received from ${who}`, detail: `A People movement — not income.` }
          : { title: `Money paid to ${who}`, detail: `A People movement — not a personal expense.` };
    }
  }
  if (t.loanId != null && t.paymentAllocationType === "additionalDisbursement") {
    return { title: t.type === "income" ? "Loan money received" : "Loan money lent", detail: t.type === "income" ? "Borrowed principal — a liability, not income." : "Lent principal — a receivable, not spending." };
  }
  if (t.type === "expense" && t.linkedPersonId != null && t.owesPersonToggle && t.loanId == null && t.emiId == null) {
    return { title: `Paid for ${who}`, detail: `You paid this; ${who} owes you their share — only your own share counts as your spending.` };
  }
  return null;
}
