/**
 * PDF library abstraction layer — Architecture v1.0 §8 (native/OCR/hybrid
 * parsing tiers are format-agnostic; this is the seam that keeps them
 * that way), backlog M1-T7.
 *
 * No business logic anywhere else in this codebase may depend on pdfjs-dist
 * (or whatever library eventually backs this) directly or reference its
 * types. Everything the parser pipeline needs from a PDF — verify a
 * password, open the document, get page text/images, get page count — goes
 * through this interface. Swapping the backing library later (the
 * production choice, pdfjs-dist, was made explicitly as an implementation
 * detail, not an architectural commitment) means writing a new
 * PdfDocumentProvider implementation, not touching the parser, OCR,
 * AI-validation, or any downstream pipeline stage.
 */

/** Standardized error codes — stable across whatever library implements this interface. */
export type PdfErrorCode =
  | "INVALID_PASSWORD"
  | "PDF_CORRUPTED"
  | "PDF_UNSUPPORTED"
  | "PDF_EMPTY"
  | "PDF_ENCRYPTED"
  | "INTERNAL_ERROR";

export class PdfDocumentError extends Error {
  constructor(
    public readonly code: PdfErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PdfDocumentError";
  }
}

/**
 * A single text run at its painted position, straight from the PDF's text
 * rendering matrix (docs/adr/ADR-006). `x`/`y` are NOT reading order — pdfjs
 * emits items in content-stream (paint) order, which on a real statement can
 * place a page's top header block after its transaction table. Consumers
 * that need reading order (Table Detector, Row Extractor) must reconstruct
 * it themselves from position, never assume array order means layout order.
 */
export interface PdfPageTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageText {
  pageNumber: number;
  /** Flattened, space-joined text — readability checks only. Never parse table/row structure out of this; see `items` (ADR-006). */
  text: string;
  items: PdfPageTextItem[];
}

/** An opened, decrypted (if applicable) PDF handle — opaque outside this layer. */
export interface PdfDocumentHandle {
  pageCount: number;
  getPageText(pageNumber: number): Promise<PdfPageText>;
  getAllPageText(): Promise<PdfPageText[]>;
  destroy(): Promise<void>;
}

export interface PdfDocumentProvider {
  /**
   * Opens a PDF, verifying the password if the document is encrypted.
   * Throws PdfDocumentError with one of the standardized codes — never a
   * library-specific error type — so callers (backlog M1-T7's
   * decrypt-document flow, and later the Statement Analyzer worker,
   * Architecture §6) never need to know which library is behind this.
   *
   * `bytes` must never be logged or persisted by any implementation of
   * this method beyond the lifetime of the call — Architecture §24's
   * corrected rule (decrypted content is Function-memory-only, never
   * written to Storage).
   */
  open(bytes: Uint8Array, password?: string): Promise<PdfDocumentHandle>;
}
