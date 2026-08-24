/**
 * pdfjs-dist-backed PdfDocumentProvider — backlog M1-T7. This is the ONLY
 * file in this codebase allowed to import from "pdfjs-dist"; every pdfjs
 * type/exception is translated to the standardized PdfDocumentError codes
 * at this boundary (see pdf-document-provider.ts's module comment).
 *
 * pdfjs-dist ships ESM-only (`legacy/build/pdf.mjs`); this package's
 * TypeScript output is CommonJS (functions/tsconfig.json), so the library
 * is loaded via a dynamic `import()` rather than `require` — this is the
 * one place that indirection is needed, contained entirely behind this
 * module so nothing else has to know about it.
 */

import type { PdfDocumentHandle, PdfDocumentProvider, PdfPageText, PdfPageTextItem } from "./pdf-document-provider";
import { PdfDocumentError } from "./pdf-document-provider";

// Structural types for just the pieces of the pdfjs-dist API this file
// touches — avoids leaking pdfjs's own types past this module per the
// abstraction requirement, while still getting type-checked usage below.
interface PdfjsTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}
interface PdfjsTextContent {
  items: PdfjsTextItem[];
}
interface PdfjsPageProxy {
  getTextContent(): Promise<PdfjsTextContent>;
}
interface PdfjsDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPageProxy>;
  destroy(): Promise<void>;
}
interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocumentProxy>;
  destroy(): Promise<void>;
}
interface PdfjsModule {
  getDocument(params: {
    data: Uint8Array;
    password?: string;
    isEvalSupported: boolean;
    useSystemFonts: boolean;
  }): PdfjsLoadingTask;
  PasswordException: new (...args: unknown[]) => Error & { code: number };
  PasswordResponses: { NEED_PASSWORD: number; INCORRECT_PASSWORD: number };
  InvalidPDFException: new (...args: unknown[]) => Error;
}

let pdfjsModulePromise: Promise<PdfjsModule> | null = null;

/** Lazily loaded once per Cloud Function instance, not once per call. */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfjsModule>;
  }
  return pdfjsModulePromise;
}

function classifyError(pdfjs: PdfjsModule, error: unknown): PdfDocumentError {
  if (error instanceof pdfjs.PasswordException) {
    if (error.code === pdfjs.PasswordResponses.NEED_PASSWORD) {
      return new PdfDocumentError("PDF_ENCRYPTED", "This document is password-protected.", error);
    }
    if (error.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD) {
      return new PdfDocumentError("INVALID_PASSWORD", "Incorrect password.", error);
    }
    return new PdfDocumentError("INTERNAL_ERROR", "Unrecognized password exception.", error);
  }
  if (error instanceof pdfjs.InvalidPDFException) {
    return new PdfDocumentError("PDF_CORRUPTED", "This file appears damaged.", error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/unsupported|not supported|unknown encryption/i.test(message)) {
    return new PdfDocumentError("PDF_UNSUPPORTED", "This document uses an unsupported PDF feature.", error);
  }
  return new PdfDocumentError("INTERNAL_ERROR", "Unexpected error opening the document.", error);
}

/** ADR-006: `transform` is pdfjs's text rendering matrix — indices [4]/[5] are the item's painted x/y, the only reliable position source (array order is paint order, not reading order). */
function toPositionalItem(item: PdfjsTextItem): PdfPageTextItem | null {
  const str = item.str ?? "";
  if (str.trim().length === 0) return null;
  const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
  return {
    str,
    x: transform[4] ?? 0,
    y: transform[5] ?? 0,
    width: item.width ?? 0,
    height: item.height ?? 0,
  };
}

async function getPageText(doc: PdfjsDocumentProxy, pageNumber: number): Promise<PdfPageText> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str ?? "").join(" ");
  const items = content.items.map(toPositionalItem).filter((item): item is PdfPageTextItem => item !== null);
  return { pageNumber, text, items };
}

export class PdfjsDocumentProvider implements PdfDocumentProvider {
  async open(bytes: Uint8Array, password?: string): Promise<PdfDocumentHandle> {
    const pdfjs = await loadPdfjs();

    let doc: PdfjsDocumentProxy;
    let loadingTask: PdfjsLoadingTask;
    try {
      loadingTask = pdfjs.getDocument({
        // pdfjs-dist transfers/detaches the input buffer to its (real or
        // loopback/fake) worker — passing the caller's own Uint8Array
        // directly would leave it unusable for any second call the
        // caller makes with the same bytes (observed directly: reusing
        // `bytes` across two attemptUnlock() calls threw
        // "DataCloneError: Cannot transfer object of unsupported type"
        // on the second one). A defensive copy keeps that pdfjs-specific
        // behavior from leaking past this abstraction.
        data: new Uint8Array(bytes),
        password,
        isEvalSupported: false,
        useSystemFonts: true,
      });
      doc = await loadingTask.promise;
    } catch (error) {
      throw classifyError(pdfjs, error);
    }

    // PDFDocumentProxy has no destroy() of its own — the loading task owns
    // teardown (learned from the real pdfjs API surface, not assumed; see
    // functions/tests/pdf-document-provider.test.ts).
    const destroy = () => loadingTask.destroy();

    if (doc.numPages === 0) {
      await destroy();
      throw new PdfDocumentError("PDF_EMPTY", "This document has no pages.");
    }

    return {
      pageCount: doc.numPages,
      getPageText: (pageNumber: number) => getPageText(doc, pageNumber),
      getAllPageText: async () => {
        const pages: PdfPageText[] = [];
        for (let i = 1; i <= doc.numPages; i++) pages.push(await getPageText(doc, i));
        return pages;
      },
      destroy,
    };
  }
}
