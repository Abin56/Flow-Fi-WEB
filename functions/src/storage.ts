import { getApps, initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

/**
 * Reads an uploaded object's bytes from the default bucket — used by
 * decryptDocumentCallable and retryDocumentParsingCallable (index.ts).
 *
 * This uses the Admin SDK, which does NOT run storage.rules — callers of
 * this function are themselves the only security boundary standing between
 * a request and any object in the bucket. Every call site MUST validate the
 * path with `assertOwnedStoragePath` (or read the path from a document the
 * caller's own uid already owns, never from unchecked client input) before
 * calling this. Do not add a new call site that passes a client-supplied
 * path straight through.
 */
export async function readStorageObjectBytes(storagePath: string): Promise<Uint8Array> {
  const app = getApps().length ? getApps()[0]! : initializeApp();
  const [buffer] = await getStorage(app).bucket().file(storagePath).download();
  return new Uint8Array(buffer);
}

/**
 * Storage path convention (storage.rules, upload-statement.ts):
 * `users/{uid}/documents/{documentType}/{fileName}`. Client-side Storage
 * SDK reads/writes are bounded by storage.rules to `request.auth.uid ==
 * uid` in that path — but Admin SDK reads (readStorageObjectBytes above)
 * bypass storage.rules entirely, so any callable that accepts a
 * client-supplied storagePath must re-check this same ownership rule
 * itself, or a caller could read any other user's uploaded statement by
 * simply naming their uid in the path.
 */
const OWNED_PATH_PATTERN = /^users\/([^/]+)\/documents\/[^/]+\/[^/]+$/;

export class StoragePathOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoragePathOwnershipError";
  }
}

/** Throws unless `storagePath` is shaped like `users/{uid}/documents/...` for exactly the given `uid`. */
export function assertOwnedStoragePath(storagePath: string, uid: string): void {
  const match = OWNED_PATH_PATTERN.exec(storagePath);
  if (!match || match[1] !== uid) {
    throw new StoragePathOwnershipError("storagePath does not belong to the authenticated user.");
  }
}
