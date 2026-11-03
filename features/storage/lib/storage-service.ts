/**
 * Storage Management — Firebase I/O. Takes `db` / `storage` explicitly so it can run against the emulators in tests.
 *
 * Source of truth for "what is stored": the `financialDocuments` records (which hold each upload's `storagePath`) are
 * resolved to the REAL objects with `getMetadata` (actual size, content type, creation time); files with no record
 * are found by listing the document-type folder where storage.rules allows it. Nothing is estimated and nothing is written to Firestore:
 * deleting a file removes only the Storage object, never a record — a document whose object is gone simply no longer
 * contributes to usage.
 *
 * LIMITATIONS (documented in the UI): the client SDK has no "total bucket size" API, so usage is the sum of the
 * object sizes this module can see; original filenames are not stored anywhere, so a label is built from the record.
 */

import { collection, getDocs, type Firestore } from "firebase/firestore";
import { deleteObject, getMetadata, listAll, ref, type FirebaseStorage } from "firebase/storage";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { loadStorageLimit } from "./storage-limit";
import {
  dedupeByPath,
  describeStorageLimitBlock,
  parseOwnedStoragePath,
  sectionForDocumentType,
  summarizeStorage,
  wouldExceedLimit,
  type StorageFileRecord,
} from "./storage-usage";

export interface StorageDeps {
  db: Firestore;
  storage: FirebaseStorage;
}

export interface StorageDiscovery {
  files: StorageFileRecord[];
  /** Records whose object no longer exists in Storage (already deleted) — they use no space. */
  missingObjects: number;
  /** Objects that exist but whose metadata could not be read (network/permission) — usage may be understated. */
  unreadable: number;
  /** Whether files with no statement record could be searched for (best-effort: listing a document-type folder must be allowed by storage.rules). */
  orphanScan: "done" | "unavailable";
}

const METADATA_CONCURRENCY = 8;

function code(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
}

async function inChunks<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += METADATA_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + METADATA_CONCURRENCY).map(fn))));
  }
  return out;
}

function toDate(value: unknown): Date | null {
  const maybe = value as { toDate?: () => Date } | null | undefined;
  if (maybe && typeof maybe.toDate === "function") return maybe.toDate();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const DATE_FMT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

interface LinkedRecord {
  documentId: string;
  accountId: string;
  status: string;
  label: string;
}

function labelFor(data: Record<string, unknown>): string {
  const bank = typeof data.bank === "string" && data.bank ? data.bank : null;
  const period = data.period as { start?: unknown; end?: unknown } | null | undefined;
  const start = toDate(period?.start);
  const end = toDate(period?.end);
  const uploaded = toDate(data.uploadedAt);
  const when = start && end ? `${DATE_FMT.format(start)} – ${DATE_FMT.format(end)}` : uploaded ? `uploaded ${DATE_FMT.format(uploaded)}` : "";
  return [bank ? `${bank} statement` : "Statement PDF", when].filter(Boolean).join(" · ");
}

export async function discoverStorageFiles({ db, storage }: StorageDeps, uid: string): Promise<StorageDiscovery> {
  const snap = await getDocs(collection(db, FirestoreCollections.users, uid, FirestoreCollections.financialDocuments));
  const linked = new Map<string, LinkedRecord[]>();
  for (const d of snap.docs) {
    const data = d.data();
    const path = typeof data.storagePath === "string" ? data.storagePath : "";
    if (!parseOwnedStoragePath(path, uid)) continue; // never touch a path outside this user's documents
    const list = linked.get(path) ?? [];
    list.push({
      documentId: d.id,
      accountId: typeof data.accountId === "string" ? data.accountId : "",
      status: typeof data.status === "string" ? data.status : "unknown",
      label: labelFor(data),
    });
    linked.set(path, list);
  }

  // Files with no record (e.g. an interrupted upload): list each document-type folder in use. The rules allow listing a
  // type folder but not `documents/` itself, so only known folders are scanned; any refusal just turns the scan off.
  let orphanScan: StorageDiscovery["orphanScan"] = "done";
  const orphanPaths: string[] = [];
  const folders = new Set(["credit_card_statement", ...[...linked.keys()].map((p) => parseOwnedStoragePath(p, uid)!.documentType)]);
  for (const type of folders) {
    try {
      const listing = await listAll(ref(storage, `users/${uid}/documents/${type}`));
      for (const item of listing.items) if (!linked.has(item.fullPath)) orphanPaths.push(item.fullPath);
    } catch {
      orphanScan = "unavailable";
    }
  }

  let missingObjects = 0;
  let unreadable = 0;
  const allPaths = [...linked.keys(), ...orphanPaths];
  const results = await inChunks(allPaths, async (path): Promise<StorageFileRecord | null> => {
    const parts = parseOwnedStoragePath(path, uid)!;
    try {
      const meta = await getMetadata(ref(storage, path));
      const records = linked.get(path) ?? [];
      const section = sectionForDocumentType(parts.documentType);
      return {
        path,
        fileName: parts.fileName,
        sectionId: section.id,
        sectionLabel: section.label,
        contentType: meta.contentType ?? "application/octet-stream",
        sizeBytes: meta.size,
        uploadedAt: meta.timeCreated ? new Date(meta.timeCreated) : null,
        displayName: records[0]?.label ?? "Unlinked file (no statement record)",
        documentIds: records.map((r) => r.documentId),
        accountIds: records.map((r) => r.accountId).filter(Boolean),
        documentStatuses: records.map((r) => r.status),
      };
    } catch (e) {
      if (code(e) === "storage/object-not-found") missingObjects += 1;
      else unreadable += 1;
      return null;
    }
  });

  return {
    files: dedupeByPath(results.filter((f): f is StorageFileRecord => f !== null)),
    missingObjects,
    unreadable,
    orphanScan,
  };
}

export type UploadGateResult = { allowed: true } | { allowed: false; message: string };

/**
 * Refuses an upload that would exceed the configured limit. Measures fresh (not from a cache) so a stale screen can't
 * let an upload through. If the object already exists (same PDF uploaded for a second card) it adds no bytes.
 * If usage can't be measured at all (offline / error) it does NOT block — a broken meter must not stop a statement import.
 */
export async function checkUploadAllowed(
  deps: StorageDeps,
  uid: string,
  incoming: { path: string; sizeBytes: number },
  limitBytes: number = loadStorageLimit(uid),
): Promise<UploadGateResult> {
  let discovery: StorageDiscovery;
  try {
    discovery = await discoverStorageFiles(deps, uid);
  } catch (e) {
    console.warn("[storage] usage could not be measured; upload not blocked", e);
    return { allowed: true };
  }
  const alreadyStored = discovery.files.some((f) => f.path === incoming.path);
  const incomingBytes = alreadyStored ? 0 : incoming.sizeBytes;
  const used = summarizeStorage(discovery.files, limitBytes).usedBytes;
  if (wouldExceedLimit(used, incomingBytes, limitBytes)) {
    return { allowed: false, message: describeStorageLimitBlock(used, incomingBytes, limitBytes) };
  }
  return { allowed: true };
}

export interface DeleteFilesResult {
  deleted: string[];
  failed: { path: string; message: string }[];
}

/**
 * Deletes ONLY the selected Storage objects. No Firestore write happens here, so transactions, statement history,
 * staged rows and `financialDocuments` records are untouched. A file that is already gone counts as deleted.
 */
export async function deleteStorageFiles({ storage }: Pick<StorageDeps, "storage">, uid: string, paths: readonly string[]): Promise<DeleteFilesResult> {
  const result: DeleteFilesResult = { deleted: [], failed: [] };
  for (const path of [...new Set(paths)]) {
    if (!parseOwnedStoragePath(path, uid)) {
      result.failed.push({ path, message: "Not one of your stored documents." });
      continue;
    }
    try {
      await deleteObject(ref(storage, path));
      result.deleted.push(path);
    } catch (e) {
      if (code(e) === "storage/object-not-found") result.deleted.push(path);
      else result.failed.push({ path, message: code(e) === "storage/unauthorized" ? "Storage refused the delete." : e instanceof Error ? e.message : "Delete failed." });
    }
  }
  return result;
}
