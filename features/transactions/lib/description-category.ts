import type { Category } from "@/lib/models/category";

/**
 * Description / Category rule for a plain income or expense: at least ONE of the two is required.
 *  - description only  → saved uncategorized (`categoryId` ""; every report already renders that as "Uncategorized")
 *  - category only     → the category's name becomes the description
 *  - both              → saved as entered
 *  - neither           → refused
 */
export const DESCRIPTION_OR_CATEGORY_MESSAGE = "Enter a description or select a category.";

export type ResolvedDescriptionCategory = { ok: true; description: string; categoryId: string } | { ok: false; message: string };

export function resolveDescriptionAndCategory(input: { description: string; categoryId: string; categories: Pick<Category, "id" | "name">[] }): ResolvedDescriptionCategory {
  const description = input.description.trim();
  // A category id that no longer exists (deleted) counts as "no category".
  const category = input.categoryId ? input.categories.find((c) => c.id === input.categoryId) : undefined;
  if (description === "" && !category) return { ok: false, message: DESCRIPTION_OR_CATEGORY_MESSAGE };
  return { ok: true, description: description !== "" ? description : category!.name, categoryId: category?.id ?? "" };
}
