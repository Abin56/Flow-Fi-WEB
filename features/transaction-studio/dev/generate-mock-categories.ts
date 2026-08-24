/**
 * DEV-ONLY — a small, realistic category set for Transaction Studio's mock-data fixture (the
 * existing "Live/20 rows/…" toggle, plus the local dev-preview route bypass — see
 * `components/layout/route-guard.tsx`). Never imported by any production data path.
 *
 * Without a real signed-in user, `useCategories()` safely returns `[]` (`enabled: !!uid` in
 * `hooks/use-categories.ts` — no Firestore call happens at all). With zero real categories,
 * `generateMockStagedRecords`'s `resolveCategoryName` has nothing to pick from, so *every*
 * expense/income mock row would end up with `category: null` and fail preflight with "Missing
 * Category" — a wall of one status, exactly what the Status-column work was fixing. This gives
 * that generator (and `getPreflightBlockers`) real candidates to resolve against, plain in-memory
 * objects — nothing here reads or writes Firestore, same as `generate-mock-staged-records.ts`.
 */

import type { Category } from "@/lib/models/category";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function category(id: string, name: string, type: Category["type"], iconKey: string): Category {
  return {
    id,
    name,
    type,
    iconKey,
    colorValue: 0,
    isDefault: true,
    isActive: true,
    createdAt: NOW,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

export function generateMockCategories(): Category[] {
  return [
    category("mock-cat-shopping", "Shopping", "expense", "shopping"),
    category("mock-cat-food", "Food & Dining", "expense", "food"),
    category("mock-cat-transport", "Transport", "expense", "transport"),
    category("mock-cat-entertainment", "Entertainment", "expense", "entertainment"),
    category("mock-cat-bills", "Bills & Utilities", "expense", "bills"),
    category("mock-cat-salary", "Salary", "income", "salary"),
    category("mock-cat-other", "Other", "both", "other"),
  ];
}
