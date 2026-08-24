/**
 * Direct port of `lib/features/savings/data/savings_repository.dart`
 * (`SavingsRepository`). Savings-goal-specific persistence on top of the
 * generic CRUD/soft-delete repository.
 */

import type { CollectionReference } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import { generateId } from "@/lib/utils/id-generator";

export interface CreateGoalParams {
  name: string;
  targetAmount: number;
  dueDate?: Date | null;
  notes?: string;
}

export interface EditGoalParams {
  name?: string;
  targetAmount?: number;
  dueDate?: Date | null;
  clearDueDate?: boolean;
  notes?: string;
}

export class SavingsRepository extends FirestoreCrudRepository<SavingsGoal> {
  constructor(collection: CollectionReference<SavingsGoal>) {
    super(collection);
  }

  async createGoal(params: CreateGoalParams): Promise<SavingsGoal> {
    if (params.targetAmount <= 0) {
      throw new Error("Target amount must be greater than 0");
    }
    const goal: SavingsGoal = {
      id: generateId(),
      name: params.name,
      targetAmount: params.targetAmount,
      currentAmount: 0,
      dueDate: params.dueDate ?? null,
      notes: params.notes ?? "",
      isCompleted: false,
      isArchived: false,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(goal.id, goal);
    return goal;
  }

  async editGoal(goal: SavingsGoal, params: EditGoalParams): Promise<void> {
    if (params.targetAmount != null && params.targetAmount <= 0) {
      throw new Error("Target amount must be greater than 0");
    }
    let updated = goal;
    updated = updateField(updated, "name", updated.name, params.name, (e, v) => ({ ...e, name: v }));
    updated = updateField(
      updated,
      "targetAmount",
      updated.targetAmount,
      params.targetAmount,
      (e, v) => ({ ...e, targetAmount: v }),
    );

    if (params.clearDueDate && updated.dueDate != null) {
      updated = recordEdit(updated, "dueDate", String(updated.dueDate), "none");
      updated = { ...updated, dueDate: null };
    } else {
      updated = updateField(updated, "dueDate", updated.dueDate, params.dueDate, (e, v) => ({ ...e, dueDate: v }));
    }

    updated = updateField(updated, "notes", updated.notes, params.notes, (e, v) => ({ ...e, notes: v }));
    await this.update(updated);
  }

  /**
   * Adds `amount` toward the goal, audit-tracked. Auto-completes the goal
   * once the contribution brings it to or past its target — recorded as
   * its own audit entry alongside the contribution, so both are visible in
   * `SavingsGoal.editHistory`.
   */
  async contribute(goal: SavingsGoal, amount: number): Promise<void> {
    if (amount <= 0) {
      throw new Error("Amount must be greater than 0");
    }
    const newAmount = goal.currentAmount + amount;
    let updated = recordEdit(goal, "currentAmount", String(goal.currentAmount), String(newAmount));
    updated = { ...updated, currentAmount: newAmount };

    if (!updated.isCompleted && newAmount >= updated.targetAmount) {
      updated = recordEdit(updated, "isCompleted", "false", "true");
      updated = { ...updated, isCompleted: true };
    }

    await this.update(updated);
  }

  async markCompleted(goal: SavingsGoal): Promise<void> {
    if (goal.isCompleted) return;
    let updated = recordEdit(goal, "isCompleted", "false", "true");
    updated = { ...updated, isCompleted: true };
    await this.update(updated);
  }

  async markIncomplete(goal: SavingsGoal): Promise<void> {
    if (!goal.isCompleted) return;
    let updated = recordEdit(goal, "isCompleted", "true", "false");
    updated = { ...updated, isCompleted: false };
    await this.update(updated);
  }

  /**
   * Hides a goal from the primary active list without soft-deleting it —
   * archiving is a user-visible organizational action (the "Archive
   * Completed Goals" requirement), not a delete, so it's kept separate
   * from the trash/soft-delete mechanism.
   */
  async archive(goal: SavingsGoal): Promise<void> {
    if (goal.isArchived) return;
    let updated = recordEdit(goal, "isArchived", "false", "true");
    updated = { ...updated, isArchived: true };
    await this.update(updated);
  }

  async unarchive(goal: SavingsGoal): Promise<void> {
    if (!goal.isArchived) return;
    let updated = recordEdit(goal, "isArchived", "true", "false");
    updated = { ...updated, isArchived: false };
    await this.update(updated);
  }
}
