import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import { formatCurrencyExact } from "@/lib/format";
import { accountLabelFor } from "./duplicate-comparison";
import type { PossibleMatch } from "./possible-matches";

/** What a reviewer needs to recognise an already-saved transaction at a glance — plain text only, never an internal id. */
export interface MatchedTransactionSummary {
  description: string;
  /** "12 Oct 2026", with the time when the record carries one. */
  dateText: string;
  amountText: string;
  /** `Expense` / `Income`, so the row never rests on a sign or a colour alone. */
  directionText: string;
  accountLabel: string | null;
  categoryLabel: string | null;
  /** Where the saved record came from: "SMS import", "Statement import", "Added manually". `null` when unknown. */
  sourceLabel: string | null;
}

export interface RowMatch extends PossibleMatch {
  existing: MatchedTransactionSummary;
}

const SOURCE_LABELS: Record<NonNullable<Transaction["source"]>, string> = { sms: "SMS import", pdf: "Statement import", manual: "Added manually", other: "Other source" };

export function summarizeExistingTransaction(t: Transaction, accounts: Account[], categories: Pick<Category, "id" | "name">[]): MatchedTransactionSummary {
  const d = t.dateTime;
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  const date = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return {
    description: t.description.trim() || "No description",
    dateText: hasTime ? `${date}, ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })}` : date,
    amountText: formatCurrencyExact(t.amount),
    directionText: t.type === "income" ? "Income" : "Expense",
    accountLabel: accountLabelFor(t.accountId, accounts),
    categoryLabel: categories.find((c) => c.id === t.categoryId)?.name ?? null,
    sourceLabel: t.source ? SOURCE_LABELS[t.source] : null,
  };
}

/** Attaches the saved transaction's readable facts to each match; a match whose transaction is no longer loaded is dropped (nothing to compare). */
export function buildRowMatches(matches: PossibleMatch[], transactionById: ReadonlyMap<string, Transaction>, accounts: Account[], categories: Pick<Category, "id" | "name">[]): RowMatch[] {
  const out: RowMatch[] = [];
  for (const m of matches) {
    const t = transactionById.get(m.transactionId);
    if (t) out.push({ ...m, existing: summarizeExistingTransaction(t, accounts, categories) });
  }
  return out;
}
