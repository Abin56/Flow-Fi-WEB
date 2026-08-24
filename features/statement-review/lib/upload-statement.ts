/**
 * Real client-side upload flow for a Credit Card Statement PDF —
 * Statement Intelligence Workspace, upload stage only (see
 * docs/statement-workspace-vision.md §2 steps 1-2 and
 * docs/state-machine.md T1/T2).
 *
 * This wires the actually-deployed, actually-tested callables in
 * `functions/src/index.ts` end to end:
 *   1. `validateIngestionCaps` (lib/statement-intelligence/ingestion-caps.ts)
 *      — client-side size/magic-bytes/page-count backstop, RFC §28.5.
 *   2. `sha256HexOfFile` (lib/statement-intelligence/document-hash.ts)
 *      — the pre-upload dedupe hash.
 *   3. `checkDocumentExistsCallable` — short-circuits if this exact file
 *      (by accountId + hash) was already uploaded; returns the existing
 *      document instead of creating a duplicate (docs/state-machine.md T1).
 *   4. Upload the actual bytes to Firebase Storage at the path convention
 *      `users/{uid}/documents/{documentType}/{fileName}` (storage.rules,
 *      lib/models/financial-document.ts's `storagePath` doc comment).
 *   5. `ingestDocumentCallable` — flips the document from "uploaded" to
 *      "parsing" (docs/state-machine.md T2), the real fast hand-off to the
 *      (currently PDF-open-only, see pdf-document-pipeline.ts) worker.
 *
 * Deliberately does NOT attempt to read back a `StatementWorkspaceModel`
 * anywhere in this flow — nothing downstream of step 5 writes one yet for
 * a real uploaded document (verified against
 * functions/src/worker/document-analyzer-worker.ts and
 * functions/src/pipeline/pdf-document-pipeline.ts).
 */

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { ref, uploadBytes } from "firebase/storage";
import { functions, storage } from "@/lib/firebase/client";
import { describeIngestionCapViolation, validateIngestionCaps } from "@/lib/statement-intelligence/ingestion-caps";
import { sha256HexOfFile } from "@/lib/statement-intelligence/document-hash";

/** `documentType` is fixed to the one Statement Intelligence Workspace scope this feature covers. */
const DOCUMENT_TYPE = "credit_card_statement" as const;

export interface UploadStatementInput {
  uid: string;
  accountId: string;
  file: File;
}

export type UploadStatementResult =
  | { outcome: "uploaded"; documentId: string }
  | { outcome: "already_exists"; documentId: string; status: string }
  | { outcome: "rejected"; message: string };

interface CheckDocumentExistsResponse {
  documentId: string;
  alreadyExists: boolean;
  status: string;
}

interface IngestDocumentResponse {
  outcome: "accepted" | "already_in_progress" | "not_found";
  status?: string;
}

/**
 * Turns a raw thrown error from the upload flow (a `FirebaseError` from an
 * `onCall` invocation or the Storage SDK, or anything else) into the
 * user-facing category this feature promises: Unsupported PDF / Password
 * required / Wrong password / Corrupted PDF / Network error / Internal
 * server error. `functions/src/index.ts`'s `toClientError` already gives
 * `HttpsError`s a specific, friendly `message` — this only needs to catch
 * the cases an `HttpsError`'s message can't cover (no connectivity, the SDK
 * never reaching the server at all) and otherwise pass the server's message
 * straight through.
 */
export function describeUploadError(error: unknown): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case "functions/unavailable":
      case "storage/retry-limit-exceeded":
      case "storage/canceled":
        return "Network error — check your connection and try again.";
      case "functions/unauthenticated":
        return "Please sign in again and retry the upload.";
      default:
        // functions/invalid-argument, functions/internal, etc. already carry
        // the friendly message toClientError() set server-side.
        return error.message || "Something went wrong on our end. Please try again.";
    }
  }
  return error instanceof Error ? error.message : "Upload failed. Please try again.";
}

/** Storage path convention: users/{uid}/documents/{documentType}/{fileName} (storage.rules). */
function storagePathFor(uid: string, fileHash: string): string {
  return `users/${uid}/documents/${DOCUMENT_TYPE}/${fileHash}.pdf`;
}

export async function uploadStatement({ uid, accountId, file }: UploadStatementInput): Promise<UploadStatementResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  const capResult = await validateIngestionCaps(bytes);
  if (!capResult.ok) {
    return { outcome: "rejected", message: describeIngestionCapViolation(capResult.violation) };
  }

  const fileHash = await sha256HexOfFile(file);

  const checkDocumentExists = httpsCallable<
    { accountId: string; documentType: string; fileHash: string },
    CheckDocumentExistsResponse
  >(functions, "checkDocumentExistsCallable");

  const checkResult = await checkDocumentExists({ accountId, documentType: DOCUMENT_TYPE, fileHash });
  const { documentId, alreadyExists, status } = checkResult.data;

  if (alreadyExists) {
    return { outcome: "already_exists", documentId, status };
  }

  const storagePath = storagePathFor(uid, fileHash);
  await uploadBytes(ref(storage, storagePath), bytes, { contentType: "application/pdf" });

  const ingestDocument = httpsCallable<{ documentId: string; storagePath: string }, IngestDocumentResponse>(
    functions,
    "ingestDocumentCallable",
  );
  await ingestDocument({ documentId, storagePath });

  return { outcome: "uploaded", documentId };
}
