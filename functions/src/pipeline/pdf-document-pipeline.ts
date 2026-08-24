/**
 * Current `DocumentPipeline` implementation — backlog M2-T2's honestly-
 * scoped stand-in for the real Parser/Classification stages that don't
 * exist yet (see document-pipeline.ts's module comment). Opens the
 * document via the already-real `PdfDocumentProvider` (M1-T7) and maps
 * the outcome to a pipeline result; nothing here fabricates a "parsed"
 * result for a document it hasn't actually looked at.
 *
 * Scoping decision (docs/state-machine.md §4): does not attempt
 * password-protected documents. If `PdfDocumentProvider.open()` reports
 * `PDF_ENCRYPTED` or `INVALID_PASSWORD` here, that means a document
 * reached the async pipeline without ever being unlocked via
 * `decryptDocumentCallable` — mapped to `failureReason: "password_required"`
 * rather than attempted, since this pipeline never has a password to try.
 */

import { PdfDocumentError, type PdfDocumentProvider } from "../pdf/pdf-document-provider";
import type { FailureReason } from "../domain/financial-document-status";
import type { DocumentPipeline, DocumentPipelineResult } from "./document-pipeline";

function mapErrorToFailureReason(error: PdfDocumentError): FailureReason {
  switch (error.code) {
    case "INVALID_PASSWORD":
    case "PDF_ENCRYPTED":
      return "password_required";
    case "PDF_UNSUPPORTED":
      return "unsupported_document";
    case "PDF_CORRUPTED":
    case "PDF_EMPTY":
    case "INTERNAL_ERROR":
      return "parsing_failed";
  }
}

export class PdfDocumentPipeline implements DocumentPipeline {
  constructor(private readonly provider: PdfDocumentProvider) {}

  async run(bytes: Uint8Array): Promise<DocumentPipelineResult> {
    try {
      const handle = await this.provider.open(bytes);
      const pageCount = handle.pageCount;
      await handle.destroy();
      return { outcome: "parsed", pageCount };
    } catch (error) {
      if (error instanceof PdfDocumentError) {
        return { outcome: "failed", failureReason: mapErrorToFailureReason(error), message: error.message };
      }
      return {
        outcome: "failed",
        failureReason: "parsing_failed",
        message: error instanceof Error ? error.message : "Unexpected error.",
      };
    }
  }
}
