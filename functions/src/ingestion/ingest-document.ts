/**
 * Fast hand-off from upload-acceptance to the (not-yet-built, M2-T2)
 * Document Analyzer worker — Architecture §28.7's explicit contract:
 * "the client-facing callable function must return quickly (job
 * accepted) and all real parsing must happen in a separate, decoupled
 * worker function." Backlog M2-T1.
 *
 * This module contains no Cloud-Functions-specific code (no `onCall`, no
 * `firebase-functions` imports) — it is a plain function over a Firestore
 * handle, directly unit-testable, matching this milestone's "no parser
 * logic in Cloud Functions themselves; Cloud Functions orchestrate only"
 * rule. The thin `onCall` wrapper lives in functions/src/index.ts.
 *
 * Hand-off mechanism: a Firestore document write, not a queue construct
 * (docs/adr/ADR-004) — flipping financialDocuments/{id}.status from
 * "uploaded" to "parsing" *is* the enqueue action. A future Firestore
 * trigger (M2-T2) reacts to that transition; this function does not wait
 * for it, know about it, or import anything from it.
 */

import type { Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

export interface IngestDocumentInput {
  uid: string;
  documentId: string;
  storagePath: string;
}

export type IngestDocumentResult =
  | { outcome: "accepted"; status: "parsing" }
  | { outcome: "already_in_progress"; status: string }
  | { outcome: "not_found" };

/**
 * Idempotent and resumable by construction: the only state change this
 * function ever makes is "uploaded" -> "parsing", inside a transaction
 * that reads current status first. Calling it twice for the same
 * document — a client retry after a dropped response, the classic case
 * this whole codebase has treated as load-bearing since M1-T6's dedupe
 * fix — finds the document already past "uploaded" on the second call
 * and returns `already_in_progress` without writing anything or
 * signaling the worker again. There is no separate "has this been
 * enqueued" flag to get out of sync with reality; the document's own
 * status field is the single source of truth for both purposes.
 *
 * No separate ownership check: `input.uid` (always the verified caller's
 * own uid from `request.auth.uid` — see index.ts — never client-supplied)
 * IS the path this function queries. A caller with a different uid cannot
 * reach another user's document through this function at all — there is
 * no query shape that would let them — so the result is `not_found`, not
 * a distinct `forbidden` outcome. An earlier version of this function had
 * a `userId`-field check that could never actually fire, given how the
 * ref is constructed; removed once a test proved it dead rather than
 * leaving unreachable code behind. This matches the same
 * path-is-the-security-boundary pattern check-document-exists.ts already
 * uses — see firestore.rules's `isOwner(uid)` for the same idea enforced
 * at the rules layer too.
 */
export async function ingestDocument(
  db: Firestore,
  input: IngestDocumentInput,
): Promise<IngestDocumentResult> {
  const ref = db.collection("users").doc(input.uid).collection("financialDocuments").doc(input.documentId);

  const result = await db.runTransaction(async (tx): Promise<IngestDocumentResult> => {
    const snapshot = await tx.get(ref);

    if (!snapshot.exists) {
      return { outcome: "not_found" };
    }

    const currentStatus = snapshot.get("status") as string;
    if (currentStatus !== "uploaded") {
      return { outcome: "already_in_progress", status: currentStatus };
    }

    tx.update(ref, { status: "parsing", storagePath: input.storagePath });
    return { outcome: "accepted", status: "parsing" };
  });

  switch (result.outcome) {
    case "accepted":
      logger.info("ingestDocument: accepted", { uid: input.uid, documentId: input.documentId });
      break;
    case "already_in_progress":
      logger.info("ingestDocument: idempotent no-op, already past 'uploaded'", {
        uid: input.uid,
        documentId: input.documentId,
        currentStatus: result.status,
      });
      break;
    case "not_found":
      logger.warn("ingestDocument: rejected, document not found", { uid: input.uid, documentId: input.documentId });
      break;
  }

  return result;
}
