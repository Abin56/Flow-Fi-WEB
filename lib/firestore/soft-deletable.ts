/**
 * Direct port of `lib/core/models/{soft_deletable_entity,soft_deletable_mixin,
 * auditable_mixin,audit_entry}.dart`. Every persisted financial entity
 * (Account, Transaction, Bill, Person, ...) carries these same three fields,
 * with the same semantics: soft-delete via `deletedAt`, full edit history
 * via `editHistory`, never a hard overwrite of a changed financial value.
 */

export interface AuditEntry {
  timestamp: Date;
  field: string;
  oldValue: string;
  newValue: string;
}

export interface SoftDeletableEntity {
  id: string;
  deletedAt: Date | null;
  lastEditedAt: Date | null;
  editHistory: AuditEntry[];
}

export function isDeleted(entity: SoftDeletableEntity): boolean {
  return entity.deletedAt != null;
}

/** Mirrors `AuditableMixin.recordEdit` — appends, never mutates prior entries. */
export function recordEdit<T extends SoftDeletableEntity>(
  entity: T,
  field: string,
  oldValue: string,
  newValue: string,
): T {
  if (oldValue === newValue) return entity;
  const now = new Date();
  return {
    ...entity,
    editHistory: [...entity.editHistory, { timestamp: now, field, oldValue, newValue }],
    lastEditedAt: now,
  };
}

/**
 * Mirrors `AuditableMixin.updateField` — no-ops when `newValue` is
 * null/undefined or equal to `oldValue`, so callers can pass straight
 * through optional edit parameters without their own checks.
 */
export function updateField<T extends SoftDeletableEntity, V>(
  entity: T,
  field: string,
  oldValue: V,
  newValue: V | null | undefined,
  apply: (entity: T, value: V) => T,
): T {
  if (newValue == null || newValue === oldValue) return entity;
  const applied = apply(entity, newValue);
  return recordEdit(applied, field, String(oldValue), String(newValue));
}
