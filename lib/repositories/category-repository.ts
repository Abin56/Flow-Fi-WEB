/**
 * Direct port of `lib/features/categories/data/category_repository.dart`
 * (`CategoryRepository`). Category-specific persistence on top of the
 * generic CRUD/soft-delete repository, plus first-launch seeding of the
 * default category set.
 */

import type { CollectionReference } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { updateField } from "@/lib/firestore/soft-deletable";
import type { Category, CategoryType } from "@/lib/models/category";
import { DEFAULT_CATEGORIES } from "@/lib/models/category";
import { generateId } from "@/lib/utils/id-generator";

export interface CreateCategoryParams {
  name: string;
  type: CategoryType;
  iconKey: string;
  colorValue: number;
}

export interface EditCategoryParams {
  name?: string;
  type?: CategoryType;
  iconKey?: string;
  colorValue?: number;
  isActive?: boolean;
}

export class CategoryRepository extends FirestoreCrudRepository<Category> {
  constructor(collection: CollectionReference<Category>) {
    super(collection);
  }

  async createCategory(params: CreateCategoryParams): Promise<Category> {
    const category: Category = {
      id: generateId(),
      name: params.name,
      type: params.type,
      iconKey: params.iconKey,
      colorValue: params.colorValue,
      createdAt: new Date(),
      isDefault: false,
      isActive: true,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(category.id, category);
    return category;
  }

  async editCategory(category: Category, params: EditCategoryParams): Promise<void> {
    let updated = category;
    updated = updateField(updated, "name", updated.name, params.name, (e, v) => ({ ...e, name: v }));
    updated = updateField(updated, "type", updated.type, params.type, (e, v) => ({ ...e, type: v }));
    updated = updateField(updated, "icon", updated.iconKey, params.iconKey, (e, v) => ({ ...e, iconKey: v }));
    updated = updateField(updated, "color", updated.colorValue, params.colorValue, (e, v) => ({
      ...e,
      colorValue: v,
    }));
    updated = updateField(updated, "isActive", updated.isActive, params.isActive, (e, v) => ({
      ...e,
      isActive: v,
    }));
    await this.update(updated);
  }

  /**
   * Populates the default category set the first time this user's
   * `categories` collection is found empty (fresh account, or every category
   * having since been purged). Safe to call on every cold read — it only
   * writes when `getAll` comes back empty.
   */
  async seedDefaultsIfEmpty(): Promise<void> {
    const existing = await this.getAll();
    if (existing.length > 0) return;

    for (const seed of DEFAULT_CATEGORIES) {
      const category: Category = {
        id: generateId(),
        name: seed.name,
        type: seed.type,
        iconKey: seed.iconKey,
        colorValue: seed.colorValue,
        createdAt: new Date(),
        isDefault: true,
        isActive: true,
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      await this.add(category.id, category);
    }
  }
}
