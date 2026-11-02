/**
 * Storage Management — pure calculation helpers (no Firebase imports, fully unit-testable).
 *
 * Usage is always DERIVED from the real object metadata of the files that exist in Firebase Storage; nothing
 * here is a stored counter, so it cannot drift after a failed upload, an interrupted delete or a second device.
 * Sizes use binary units (1 MB = 1024 × 1024 bytes), matching `storage.rules`.
 */

export const BYTES_PER_MB = 1024 * 1024;
export const BYTES_PER_GB = 1024 * BYTES_PER_MB;

/** Personal-use default allocation until the user picks one. */
export const DEFAULT_STORAGE_LIMIT_BYTES = 500 * BYTES_PER_MB;
export const MIN_STORAGE_LIMIT_BYTES = 1 * BYTES_PER_MB;
export const MAX_STORAGE_LIMIT_BYTES = 100 * BYTES_PER_GB;
export const STORAGE_LIMIT_PRESETS_MB = [500, 700, 1024] as const;

/** Where a stored file lives, derived from `users/{uid}/documents/{documentType}/{fileName}` (storage.rules). */
export interface StorageSectionDef {
  id: string;
  label: string;
  description: string;
}

const KNOWN_SECTIONS: Record<string, StorageSectionDef> = {
  credit_card_statement: {
    id: "credit_card_statement",
    label: "Imported card statements",
    description: "Credit-card statement PDFs uploaded in Statement Review",
  },
};

export function sectionForDocumentType(documentType: string): StorageSectionDef {
  const known = KNOWN_SECTIONS[documentType];
  if (known) return known;
  const label = documentType.replace(/[_-]+/g, " ").trim();
  return {
    id: documentType || "other",
    label: label ? `Other documents (${label})` : "Other documents",
    description: "Other uploaded documents",
  };
}

/** `users/{uid}/documents/{documentType}/{fileName}` → its parts, or null for any path outside the user's documents. */
export function parseOwnedStoragePath(path: string, uid: string): { documentType: string; fileName: string } | null {
  const match = /^users\/([^/]+)\/documents\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match || match[1] !== uid) return null;
  return { documentType: match[2]!, fileName: match[3]! };
}

/** One real object in Storage (size/time come from the object's own metadata) plus the records that point at it. */
export interface StorageFileRecord {
  path: string;
  fileName: string;
  sectionId: string;
  sectionLabel: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date | null;
  /** Human label built from the linked record(s) — original filenames are not stored anywhere. */
  displayName: string;
  /** `financialDocuments` ids that reference this exact object (usually one; the object is shared when the same PDF was uploaded for two cards). */
  documentIds: string[];
  /** Cards/accounts those records were uploaded against. */
  accountIds: string[];
  /** Status of the linked document(s) — decides whether deleting the file is safe right now. */
  documentStatuses: string[];
}

export interface StorageSectionUsage extends StorageSectionDef {
  bytes: number;
  fileCount: number;
  /** Share of the total used storage, 0–100 (0 when nothing is used). */
  sharePercent: number;
}

export type StorageLevel = "ok" | "warning" | "full" | "over";

export interface StorageUsageSummary {
  usedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  /** Raw percent of the limit used — can exceed 100 when the limit was lowered below current usage. */
  percentUsed: number;
  fileCount: number;
  level: StorageLevel;
  sections: StorageSectionUsage[];
}

export const STORAGE_WARNING_PERCENT = 80;

/** Counts each distinct object path once, whatever number of records reference it. */
export function dedupeByPath(files: readonly StorageFileRecord[]): StorageFileRecord[] {
  const seen = new Map<string, StorageFileRecord>();
  for (const f of files) {
    const existing = seen.get(f.path);
    if (!existing) {
      seen.set(f.path, f);
      continue;
    }
    seen.set(f.path, {
      ...existing,
      documentIds: [...new Set([...existing.documentIds, ...f.documentIds])],
      accountIds: [...new Set([...existing.accountIds, ...f.accountIds])],
      documentStatuses: [...new Set([...existing.documentStatuses, ...f.documentStatuses])],
    });
  }
  return [...seen.values()];
}

export function summarizeStorage(files: readonly StorageFileRecord[], limitBytes: number): StorageUsageSummary {
  const unique = dedupeByPath(files);
  const usedBytes = unique.reduce((sum, f) => sum + f.sizeBytes, 0);
  const bySection = new Map<string, StorageSectionUsage>();
  for (const f of unique) {
    const cur = bySection.get(f.sectionId) ?? {
      id: f.sectionId,
      label: f.sectionLabel,
      description: sectionForDocumentType(f.sectionId).description,
      bytes: 0,
      fileCount: 0,
      sharePercent: 0,
    };
    cur.bytes += f.sizeBytes;
    cur.fileCount += 1;
    bySection.set(f.sectionId, cur);
  }
  const sections = [...bySection.values()]
    .map((s) => ({ ...s, sharePercent: usedBytes > 0 ? (s.bytes / usedBytes) * 100 : 0 }))
    .sort((a, b) => b.bytes - a.bytes);
  const percentUsed = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
  const level: StorageLevel =
    usedBytes > limitBytes ? "over" : usedBytes === limitBytes && limitBytes > 0 ? "full" : percentUsed >= STORAGE_WARNING_PERCENT ? "warning" : "ok";
  return {
    usedBytes,
    limitBytes,
    remainingBytes: Math.max(0, limitBytes - usedBytes),
    percentUsed,
    fileCount: unique.length,
    level,
    sections,
  };
}

/** True when adding `incomingBytes` would push usage past the limit. Exactly reaching the limit is allowed. */
export function wouldExceedLimit(usedBytes: number, incomingBytes: number, limitBytes: number): boolean {
  return usedBytes + Math.max(0, incomingBytes) > limitBytes;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= BYTES_PER_GB) return `${trim(bytes / BYTES_PER_GB, 2)} GB`;
  if (bytes >= BYTES_PER_MB) return `${trim(bytes / BYTES_PER_MB, bytes >= 100 * BYTES_PER_MB ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export type LimitParseResult = { ok: true; bytes: number } | { ok: false; message: string };

/** Parses the custom-limit field (a number of MB). */
export function parseLimitMb(input: string): LimitParseResult {
  const text = input.trim().replace(/,/g, "");
  if (!text) return { ok: false, message: "Enter a storage limit in MB." };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, message: "Use a plain number of MB, e.g. 700." };
  const bytes = Math.round(Number(text) * BYTES_PER_MB);
  if (bytes < MIN_STORAGE_LIMIT_BYTES) return { ok: false, message: "The limit must be at least 1 MB." };
  if (bytes > MAX_STORAGE_LIMIT_BYTES) return { ok: false, message: "The limit can't exceed 100 GB." };
  return { ok: true, bytes };
}

/** The user-facing sentence shown when an upload is refused. */
export function describeStorageLimitBlock(usedBytes: number, incomingBytes: number, limitBytes: number): string {
  const remaining = Math.max(0, limitBytes - usedBytes);
  return (
    `Not enough storage: this file needs ${formatBytes(incomingBytes)}, but only ${formatBytes(remaining)} is left ` +
    `(${formatBytes(usedBytes)} of your ${formatBytes(limitBytes)} limit is used). ` +
    `Free up space in Settings → Storage, or raise the limit there.`
  );
}

export function storageLevelMessage(s: StorageUsageSummary): string | null {
  if (s.level === "over") return `You're over your ${formatBytes(s.limitBytes)} limit by ${formatBytes(s.usedBytes - s.limitBytes)}. New uploads are blocked until you delete files or raise the limit.`;
  if (s.level === "full") return `Your ${formatBytes(s.limitBytes)} limit is full. New uploads are blocked until you free space or raise the limit.`;
  if (s.level === "warning") return `You've used ${Math.round(s.percentUsed)}% of your ${formatBytes(s.limitBytes)} limit — ${formatBytes(s.remainingBytes)} left.`;
  return null;
}
