import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import type { CandidateDuplicateResult } from "./candidate-duplicate";

export type ComparisonMatch = "same" | "similar" | "different" | "unknown";

export interface ComparisonRow {
  field: "amount" | "date" | "merchant" | "account" | "direction";
  label: string;
  candidate: string;
  existing: string;
  match: ComparisonMatch;
}

export type DuplicateStrength = "strong" | "likely" | "weak";

export interface DuplicateComparison {
  rows: ComparisonRow[];
  strength: DuplicateStrength;
  /** One plain-language sentence — never contains an internal transaction id. */
  summary: string;
}

const AMOUNT_EPSILON = 0.005;

const moneyFormat = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function accountLabelFor(accountId: string | null, accounts: Account[]): string | null {
  if (!accountId) return null;
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return null;
  return account.accountNumberLast4 ? `${account.name} •••• ${account.accountNumberLast4}` : account.name;
}

/** The account a `"card:<id>"` / `"account:<id>"` destination key posts to (a card posts to its own account). */
export function destinationAccountId(key: string | null, creditCards: CreditCardProfile[]): string | null {
  if (!key) return null;
  const [kind, id] = key.split(":");
  if (kind === "card") return creditCards.find((c) => c.id === id)?.accountId ?? null;
  return id ?? null;
}

/**
 * A field-by-field, human-readable comparison between a candidate and the existing transaction it may duplicate. Uses only
 * what both records carry (amount, date, merchant/description, account, direction) and never surfaces internal ids. It
 * describes — it never decides: nothing here dismisses, merges or imports anything.
 */
export function buildDuplicateComparison(params: {
  candidate: SmsTransactionCandidate;
  /** The destination the reviewer has chosen (or Android's own match) — what an import would post to. */
  candidateAccountKey: string | null;
  existing: Pick<Transaction, "amount" | "dateTime" | "description" | "accountId" | "type">;
  duplicate: Pick<CandidateDuplicateResult, "confidence">;
  accounts: Account[];
  creditCards: CreditCardProfile[];
}): DuplicateComparison {
  const { candidate, existing, accounts, creditCards } = params;
  const candidateAccountId = destinationAccountId(params.candidateAccountKey, creditCards);

  const amountMatch: ComparisonMatch = Math.abs(candidate.amount - existing.amount) <= AMOUNT_EPSILON ? "same" : "different";
  const dateMatch: ComparisonMatch = sameLocalDay(candidate.transactionDate, existing.dateTime) ? "same" : "different";

  const candidateName = candidate.merchant ?? candidate.bankName ?? "";
  const existingName = existing.description ?? "";
  let merchantMatch: ComparisonMatch = "unknown";
  if (candidateName && existingName) {
    const c = norm(candidateName);
    const e = norm(existingName);
    merchantMatch = c === e ? "same" : c.includes(e) || e.includes(c) ? "similar" : "different";
  }

  const existingAccountLabel = accountLabelFor(existing.accountId, accounts);
  const candidateAccountLabel = accountLabelFor(candidateAccountId, accounts);
  const accountMatch: ComparisonMatch = !candidateAccountId || !existing.accountId ? "unknown" : candidateAccountId === existing.accountId ? "same" : "different";

  const candidateIsExpense = candidate.direction === "debit";
  const existingIsExpense = existing.type === "expense";
  const directionMatch: ComparisonMatch = candidateIsExpense === existingIsExpense ? "same" : "different";

  const rows: ComparisonRow[] = [
    { field: "amount", label: "Amount", candidate: moneyFormat.format(candidate.amount), existing: moneyFormat.format(existing.amount), match: amountMatch },
    { field: "date", label: "Date", candidate: dateFormat.format(candidate.transactionDate), existing: dateFormat.format(existing.dateTime), match: dateMatch },
    { field: "merchant", label: "Merchant", candidate: candidateName || "—", existing: existingName || "—", match: merchantMatch },
    { field: "account", label: "Account / card", candidate: candidateAccountLabel ?? "Not chosen yet", existing: existingAccountLabel ?? "—", match: accountMatch },
    { field: "direction", label: "Direction", candidate: candidateIsExpense ? "Expense" : "Income", existing: existingIsExpense ? "Expense" : "Income", match: directionMatch },
  ];

  const strength: DuplicateStrength = params.duplicate.confidence >= 0.85 ? "strong" : params.duplicate.confidence >= 0.5 ? "likely" : "weak";

  const sameParts: string[] = [];
  if (amountMatch === "same") sameParts.push("amount");
  if (dateMatch === "same") sameParts.push("date");
  if (merchantMatch === "same" || merchantMatch === "similar") sameParts.push("merchant");
  if (accountMatch === "same") sameParts.push("account");
  const differs = rows.filter((r) => r.match === "different").map((r) => r.label.toLowerCase());
  const summary =
    (sameParts.length > 0 ? `Same ${sameParts.join(", ")} as a transaction you already have.` : "Looks like a transaction you already have.") +
    (differs.length > 0 ? ` It differs in ${differs.join(", ")}.` : "") +
    " Nothing has been imported, merged or dismissed.";

  return { rows, strength, summary };
}
