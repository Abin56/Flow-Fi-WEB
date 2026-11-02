/**
 * Permanently removes an uploaded statement: the PDF in Storage, its staged
 * import (`documentImports/{id}` + `records`), and the `financialDocuments`
 * doc itself, so the same PDF can be uploaded again later.
 *
 * Refused (never partially applied) when any staged row was already imported
 * as a real transaction — the staging rows are the only link between those
 * transactions and this PDF, and the duplicate checks rely on them.
 *
 * Order matters: Storage first (a failure leaves everything intact and
 * retryable), then staging, then the document last so a half-finished delete
 * stays visible in the UI and can simply be deleted again.
 */

import type { Firestore } from "firebase-admin/firestore";
import { STALE_PARSING_MS } from "./check-document-exists";
import { assertOwnedStoragePath, deleteStorageObject } from "../storage";

export interface DeleteStatementDocumentInput {
  uid: string;
  documentId: string;
}

export type DeleteStatementDocumentResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "has_imported_transactions" }
  | { outcome: "still_processing" };

function toMillis(value: unknown): number | null {
  const maybe = value as { toMillis?: () => number } | null | undefined;
  return maybe && typeof maybe.toMillis === "function" ? maybe.toMillis() : null;
}

export async function deleteStatementDocument(
  db: Firestore,
  input: DeleteStatementDocumentInput,
  deleteObject: (storagePath: string) => Promise<void> = deleteStorageObject,
): Promise<DeleteStatementDocumentResult> {
  const user = db.collection("users").doc(input.uid);
  const docRef = user.collection("financialDocuments").doc(input.documentId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) return { outcome: "not_found" };

  if (snapshot.get("status") === "parsing") {
    const startedMs = toMillis(snapshot.get("parsingStartedAt")) ?? toMillis(snapshot.get("uploadedAt"));
    if (startedMs == null || Date.now() - startedMs <= STALE_PARSING_MS) return { outcome: "still_processing" };
  }

  const importRef = user.collection("documentImports").doc(input.documentId);
  const committed = await importRef.collection("records").where("committedTransactionId", "!=", null).limit(1).get();
  if (!committed.empty) return { outcome: "has_imported_transactions" };

  const storagePath = snapshot.get("storagePath") as string | null | undefined;
  if (storagePath) {
    assertOwnedStoragePath(storagePath, input.uid);
    await deleteObject(storagePath);
  }

  await db.recursiveDelete(importRef);
  await db.recursiveDelete(docRef);
  return { outcome: "deleted" };
}
