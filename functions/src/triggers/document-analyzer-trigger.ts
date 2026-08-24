/**
 * Cloud Function Trigger layer — backlog M2-T2, docs/adr/ADR-004. This is
 * the ONLY file that knows this hand-off is implemented as a Firestore
 * `onDocumentUpdated` trigger rather than a Cloud Tasks queue. Its job
 * ends at "should I react to this write, and if so, what are the plain
 * inputs the Worker needs" — it does not know how the Worker decides
 * what to do with those inputs, and it does not know anything about the
 * Pipeline underneath the Worker.
 *
 * `shouldTriggerAnalysis` is deliberately a plain, exported, pure
 * function — testable directly without needing the Firebase Functions
 * Emulator (the actual `onDocumentUpdated` registration below is thin
 * wiring around it, same accepted-and-documented gap as
 * checkDocumentExistsCallable/ingestDocumentCallable's own onCall wrappers:
 * the logic is tested for real, the framework glue is not, and that's
 * recorded as an open risk rather than implied to be covered).
 */

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { getDb } from "../firestore";
import { MultiBankCreditCardStatementPipeline } from "../pipeline/multi-bank-credit-card-statement-pipeline";
import { PdfjsDocumentProvider } from "../pdf/pdfjs-document-provider";
import { readStorageObjectBytes } from "../storage";
import { runDocumentAnalyzer } from "../worker/document-analyzer-worker";

export function shouldTriggerAnalysis(before: { status?: string } | undefined, after: { status?: string } | undefined): boolean {
  if (!after) return false; // document deleted
  if (after.status !== "parsing") return false; // only react to entering "parsing" (docs/state-machine.md T2)
  if (before?.status === "parsing") return false; // already was "parsing" — not a new transition into it
  return true;
}

const pipeline = new MultiBankCreditCardStatementPipeline(new PdfjsDocumentProvider(), getDb());

export const onFinancialDocumentUpdated = onDocumentUpdated(
  "users/{uid}/financialDocuments/{documentId}",
  async (event) => {
    const before = event.data?.before.data() as { status?: string } | undefined;
    const after = event.data?.after.data() as { status?: string; storagePath?: string } | undefined;

    if (!shouldTriggerAnalysis(before, after)) return;

    const { uid, documentId } = event.params as { uid: string; documentId: string };
    const storagePath = after!.storagePath;
    if (typeof storagePath !== "string") {
      logger.error("onFinancialDocumentUpdated: 'parsing' status with no storagePath — cannot proceed", {
        uid,
        documentId,
      });
      return;
    }

    await runDocumentAnalyzer(getDb(), pipeline, readStorageObjectBytes, { uid, documentId, storagePath });
  },
);
