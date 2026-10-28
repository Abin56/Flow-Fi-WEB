import type { Category } from "@/lib/models/category";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";

export interface CategorySuggestion {
  categoryId: string;
  name: string;
  /** How many of the user's earlier transactions with this merchant used this category. */
  count: number;
  /** How many earlier transactions matched this merchant at all. */
  total: number;
}

const MIN_MATCHES = 2;
const MAX_SUGGESTIONS = 3;

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Normalised descriptions, kept per transaction object: the history is scanned on every open and every Next, and re-lowercasing thousands of strings each time is what made it slow. Garbage-collected with the transactions. */
const normalised = new WeakMap<object, string>();
function normDescription(t: { description: string }): string {
  let d = normalised.get(t);
  if (d === undefined) {
    d = norm(t.description);
    normalised.set(t, d);
  }
  return d;
}

function sameMerchant(d: string, m: string): boolean {
  if (!d || !m) return false;
  if (d === m) return true;
  // A longer note that CONTAINS the merchant ("Swiggy order") counts, but a very short merchant would match everything.
  return m.length >= 4 && d.includes(m);
}

/**
 * Categories the user themselves already used for the same merchant — offered as one-click SUGGESTIONS the reviewer may
 * accept, never applied automatically. Needs the merchant name the SMS gave (a bank name is not a merchant), at least
 * two earlier transactions of the same direction, and only suggests categories valid for this direction.
 */
export function suggestCategories(
  candidate: Pick<SmsTransactionCandidate, "merchant" | "direction">,
  transactions: Pick<Transaction, "description" | "categoryId" | "type" | "deletedAt">[],
  allowed: Pick<Category, "id" | "name">[],
): CategorySuggestion[] {
  const merchant = candidate.merchant?.trim();
  if (!merchant) return [];
  const type: Transaction["type"] = candidate.direction === "credit" ? "income" : "expense";
  const wanted = norm(merchant);
  const counts = new Map<string, number>();
  let total = 0;
  for (const t of transactions) {
    if (t.deletedAt != null || t.type !== type || !t.categoryId) continue;
    if (!sameMerchant(normDescription(t), wanted)) continue;
    total += 1;
    counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
  }
  if (total < MIN_MATCHES) return [];
  const names = new Map(allowed.map((c) => [c.id, c.name]));
  return [...counts.entries()]
    .filter(([id]) => names.has(id))
    .sort((a, b) => b[1] - a[1] || (names.get(a[0]) ?? "").localeCompare(names.get(b[0]) ?? ""))
    .slice(0, MAX_SUGGESTIONS)
    .map(([categoryId, count]) => ({ categoryId, name: names.get(categoryId) as string, count, total }));
}
