/**
 * PDF Analyzer — PdfUnlockService. Thin orchestration wrapper around the
 * existing `PdfDocumentProvider.open(bytes, password)` + `PdfDocumentError`
 * classification (both already exist and are tested elsewhere) — this
 * module adds nothing but a discriminated-result shape so callers branch
 * on `.ok` instead of try/catch at every call site.
 */

import { PdfDocumentError, type PdfDocumentHandle, type PdfDocumentProvider, type PdfErrorCode } from "../pdf/pdf-document-provider";

export type TryUnlockResult = { ok: true; handle: PdfDocumentHandle } | { ok: false; code: PdfErrorCode };

export async function tryUnlock(
  provider: PdfDocumentProvider,
  bytes: Uint8Array,
  password: string,
): Promise<TryUnlockResult> {
  try {
    const handle = await provider.open(bytes, password);
    return { ok: true, handle };
  } catch (error) {
    if (error instanceof PdfDocumentError) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
}
