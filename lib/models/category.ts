/**
 * Direct port of `lib/features/categories/domain/{category,category_type,
 * category_icons,default_categories}.dart`. Field names, Firestore document
 * shape, and defaults must stay identical to the Flutter model — both apps
 * read/write the same documents.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { AuditEntry, SoftDeletableEntity } from "@/lib/firestore/soft-deletable";

export type CategoryType = "income" | "expense" | "both";

const CATEGORY_TYPES: CategoryType[] = ["income", "expense", "both"];

/** Mirrors `CategoryTypeX.fromName` — unrecognized names fall back to "both". */
export function categoryTypeFromName(name: string): CategoryType {
  return (CATEGORY_TYPES as string[]).includes(name) ? (name as CategoryType) : "both";
}

/**
 * Mirrors `CategoryIcons.fallback` — the stable string key `iconKey` falls
 * back to when a document's key is missing or unrecognized. The full icon
 * catalog itself (`CategoryIcons.catalog`) is a Flutter-side `IconData`
 * lookup with no meaning on the web, so only the fallback key is ported here.
 */
export const CATEGORY_ICON_FALLBACK = "other";

export interface Category extends SoftDeletableEntity {
  name: string;
  type: CategoryType;
  iconKey: string;
  colorValue: number;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
}

function auditEntryFromMap(map: Record<string, unknown>): AuditEntry {
  return {
    timestamp: (map.timestamp as Timestamp).toDate(),
    field: map.field as string,
    oldValue: map.oldValue as string,
    newValue: map.newValue as string,
  };
}

function auditEntryToMap(entry: AuditEntry) {
  return {
    timestamp: Timestamp.fromDate(entry.timestamp),
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
  };
}

export function categoryFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): Category {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name as string,
    type: categoryTypeFromName(data.type as string),
    iconKey: (data.iconKey as string | undefined) ?? CATEGORY_ICON_FALLBACK,
    colorValue: data.colorValue as number,
    isDefault: (data.isDefault as boolean) ?? false,
    isActive: (data.isActive as boolean) ?? true,
    createdAt: (data.createdAt as Timestamp).toDate(),
    deletedAt: (data.deletedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    editHistory: ((data.editHistory as Record<string, unknown>[] | undefined) ?? []).map(auditEntryFromMap),
  };
}

export function categoryToFirestore(category: Category): DocumentData {
  return {
    name: category.name,
    type: category.type,
    iconKey: category.iconKey,
    colorValue: category.colorValue,
    isDefault: category.isDefault,
    isActive: category.isActive,
    createdAt: Timestamp.fromDate(category.createdAt),
    deletedAt: category.deletedAt == null ? null : Timestamp.fromDate(category.deletedAt),
    lastEditedAt: category.lastEditedAt == null ? null : Timestamp.fromDate(category.lastEditedAt),
    editHistory: category.editHistory.map(auditEntryToMap),
  };
}

/**
 * Direct port of `default_categories.dart`'s `DefaultCategorySeed` +
 * `DefaultCategories.all` — one row per starter category, turned into a real
 * `Category` document by `CategoryRepository.seedDefaultsIfEmpty`. Colors are
 * the same `AppColors.categoryPalette` ARGB values Flutter's
 * `Color.toARGB32()` produces (alpha `FF` + the palette's RRGGBB).
 */
export interface DefaultCategorySeed {
  name: string;
  type: CategoryType;
  iconKey: string;
  colorValue: number;
}

const CATEGORY_PALETTE: number[] = [
  0xff5b5fef,
  0xff00c2a8,
  0xffff5b5b,
  0xffffa53e,
  0xff3e8eff,
  0xff1fb873,
  0xffe85d9a,
  0xff8e6cef,
  0xff40c4ff,
  0xffffc857,
];

export const DEFAULT_CATEGORIES: DefaultCategorySeed[] = [
  { name: "Salary", type: "income", iconKey: "work", colorValue: CATEGORY_PALETTE[5] },
  { name: "Freelance", type: "income", iconKey: "laptop", colorValue: CATEGORY_PALETTE[8] },
  { name: "Food", type: "expense", iconKey: "restaurant", colorValue: CATEGORY_PALETTE[2] },
  { name: "Transport", type: "expense", iconKey: "car", colorValue: CATEGORY_PALETTE[4] },
  { name: "Shopping", type: "expense", iconKey: "shopping_bag", colorValue: CATEGORY_PALETTE[6] },
  { name: "Bills & Utilities", type: "expense", iconKey: "receipt", colorValue: CATEGORY_PALETTE[3] },
  { name: "Entertainment", type: "expense", iconKey: "movie", colorValue: CATEGORY_PALETTE[7] },
  { name: "Health", type: "expense", iconKey: "health", colorValue: CATEGORY_PALETTE[1] },
  { name: "Transfer", type: "both", iconKey: "transfer", colorValue: CATEGORY_PALETTE[9] },
  { name: "Other", type: "both", iconKey: "other", colorValue: CATEGORY_PALETTE[0] },
];
