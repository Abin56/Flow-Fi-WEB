/**
 * Read-only check of which category each transaction was filed under, for records imported while a category name was
 * resolved without its direction. Pure: no Firestore, no writes, and it never proposes which category was meant.
 * It reports ids, date, amount and category only — no description or notes.
 */

import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";

export type CategoryFindingLevel =
  /** The category's type contradicts the direction AND a same-named category fits it — the old import bug's pattern. */
  | "conflict-with-namesake"
  /** The type contradicts the direction, with no fitting namesake. May be deliberate (a refund under an expense category). */
  | "conflict"
  /** The type fits, but other categories of the same name also fit: only the owner knows which was meant. Not an error. */
  | "ambiguous-name"
  /** The stored id matches no category given (deleted, or not loaded — pass trashed categories too). */
  | "unknown-category";

export interface CategoryFinding {
  transactionId: string;
  date: Date;
  amount: number;
  category: { id: string; name: string | null; type: Category["type"] | null };
  expectedType: "expense" | "income";
  level: CategoryFindingLevel;
  /** The transaction came from an import (SMS, or a statement / Smart Capture marker in its notes). */
  imported: boolean;
  reason: string;
  /** Same-named categories that fit the direction — evidence to review, never an automatic replacement. */
  namesakeIds: string[];
}

type Audited = Pick<Transaction, "id" | "type" | "amount" | "dateTime" | "categoryId" | "deletedAt" | "source" | "notes" | "transferId" | "loanId" | "emiId" | "isPersonLedgerMovement">;

const live = (c: Category) => c.deletedAt == null && c.isActive !== false;

export function auditCategoryAssignments(transactions: readonly Audited[], categories: readonly Category[]): CategoryFinding[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const findings: CategoryFinding[] = [];
  for (const t of transactions) {
    // Transfers and People / Loan / EMI cash legs carry a technical category their own module chose.
    if (t.deletedAt != null || t.transferId != null || t.loanId != null || t.emiId != null || t.isPersonLedgerMovement) continue;
    if (t.type !== "expense" && t.type !== "income") continue;
    const expected = t.type;
    const current = byId.get(t.categoryId) ?? null;
    const namesakes = current ? categories.filter((c) => c.id !== current.id && live(c) && c.name === current.name && (c.type === expected || c.type === "both")) : [];
    let level: CategoryFindingLevel;
    let reason: string;
    if (!current) {
      level = "unknown-category";
      reason = "The stored category id matches no known category.";
    } else if (current.type !== "both" && current.type !== expected) {
      level = namesakes.length > 0 ? "conflict-with-namesake" : "conflict";
      reason = `An ${expected} is filed under an ${current.type} category${namesakes.length > 0 ? `, and another category with the same name fits an ${expected}` : ""}.`;
    } else if (namesakes.length > 0) {
      level = "ambiguous-name";
      reason = `More than one category named "${current.name}" fits this ${expected}.`;
    } else continue;
    findings.push({
      transactionId: t.id,
      date: t.dateTime,
      amount: t.amount,
      category: { id: t.categoryId, name: current?.name ?? null, type: current?.type ?? null },
      expectedType: expected,
      level,
      imported: t.source === "sms" || /Imported via/.test(t.notes ?? ""),
      reason,
      namesakeIds: namesakes.map((c) => c.id),
    });
  }
  return findings;
}
