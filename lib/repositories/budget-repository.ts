/**
 * Direct port of `lib/features/budget/data/budget_repository.dart`
 * (`BudgetRepository`). Budget-specific persistence on top of the generic
 * CRUD/soft-delete repository, plus the "at most one active budget per
 * (type, categoryId)" invariant — Firestore has no unique-constraint
 * mechanism, so this is enforced here against live data before every create.
 *
 * Dart throws `AppException` for validation failures; no `AppException`
 * port exists yet in this codebase, so this mirrors every other web
 * repository's convention (see e.g. `account-repository.ts`,
 * `savings-repository.ts`) of throwing a plain `Error` with the same
 * message text.
 */

import type { CollectionReference } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { updateField } from "@/lib/firestore/soft-deletable";
import type { Budget, BudgetType } from "@/lib/models/budget";
import { budgetTypeLabel } from "@/lib/models/budget";
import { generateId } from "@/lib/utils/id-generator";

export interface CreateBudgetParams {
  type: BudgetType;
  amount: number;
  categoryId?: string | null;
}

export class BudgetRepository extends FirestoreCrudRepository<Budget> {
  constructor(collection: CollectionReference<Budget>) {
    super(collection);
  }

  async createBudget(params: CreateBudgetParams): Promise<Budget> {
    const { type, amount } = params;
    const categoryId = params.categoryId ?? null;

    if (amount <= 0) {
      throw new Error("Budget amount must be greater than 0");
    }

    const existing = await this.getAll();
    const duplicate = existing.some((b) => b.type === type && b.categoryId === categoryId);
    if (duplicate) {
      throw new Error(
        categoryId == null
          ? `A ${budgetTypeLabel(type).toLowerCase()} budget already exists`
          : "This category already has a budget",
      );
    }

    const budget: Budget = {
      id: generateId(),
      type,
      amount,
      categoryId,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(budget.id, budget);
    return budget;
  }

  /**
   * Only the amount is editable post-creation — `Budget.type` and
   * `Budget.categoryId` define *what* the budget is; changing either would
   * silently repurpose an existing budget rather than replacing it.
   */
  async editBudget(budget: Budget, amount: number): Promise<void> {
    if (amount <= 0) {
      throw new Error("Budget amount must be greater than 0");
    }
    const updated = updateField(budget, "amount", budget.amount, amount, (e, v) => ({ ...e, amount: v }));
    await this.update(updated);
  }
}
