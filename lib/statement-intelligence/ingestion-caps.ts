/**
 * PDF ingestion caps — Architecture v1.0 §22 (edge case: large statement),
 * RFC §28.5 (A5: PDF-as-attack-surface, "enforce a hard page-count/file-
 * size cap before any parsing begins"), §30 item 7 (explicitly delegates
 * the concrete numbers to implementation). Backlog M1-T4.
 *
 * These are a *security backstop*, not a business-logic limit — set well
 * above any realistic legitimate statement (including the "100+ pages,
 * e.g. corporate cards" case Architecture §22 says must still be handled
 * via chunked processing, not rejected) so this cap only ever fires on
 * genuinely abusive/malformed input.
 *
 * Runs identically in the browser (File/Blob -> ArrayBuffer) and in a Node
 * Cloud Function (Buffer) because it operates on a plain Uint8Array — see
 * functions/src/ingestion/validate-document.ts for the server-side
 * re-validation that must never trust this client-side check alone
 * (RFC §28.5: "re-validated server-side (can't be bypassed)").
 */

import { PDFDocument } from "pdf-lib";

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_PAGE_COUNT = 300;

/** The first bytes of every valid PDF, per ISO 32000 — %PDF- */
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export type IngestionCapViolation =
  | { kind: "file_too_large"; sizeBytes: number; maxBytes: number }
  | { kind: "not_a_pdf" }
  | { kind: "too_many_pages"; pageCount: number; maxPages: number }
  | { kind: "unreadable"; message: string };

export type IngestionCapResult =
  | { ok: true; pageCount: number }
  | { ok: false; violation: IngestionCapViolation };

function hasPdfMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC_BYTES.length) return false;
  return PDF_MAGIC_BYTES.every((expected, i) => bytes[i] === expected);
}

/**
 * Validates size, PDF magic bytes (defense in depth against a file merely
 * *named* `.pdf`, RFC §28.5), and page count, in that order — cheapest and
 * least-attacker-controllable checks first, so a crafted huge/malformed
 * file is rejected before the expensive step (loading it with pdf-lib) ever
 * runs against it.
 */
export async function validateIngestionCaps(bytes: Uint8Array): Promise<IngestionCapResult> {
  if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      violation: { kind: "file_too_large", sizeBytes: bytes.byteLength, maxBytes: MAX_FILE_SIZE_BYTES },
    };
  }

  if (!hasPdfMagicBytes(bytes)) {
    return { ok: false, violation: { kind: "not_a_pdf" } };
  }

  let pageCount: number;
  try {
    // updateMetadata:false avoids pdf-lib rewriting the doc just to count pages.
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    pageCount = pdf.getPageCount();
  } catch (e) {
    return { ok: false, violation: { kind: "unreadable", message: e instanceof Error ? e.message : String(e) } };
  }

  if (pageCount > MAX_PAGE_COUNT) {
    return { ok: false, violation: { kind: "too_many_pages", pageCount, maxPages: MAX_PAGE_COUNT } };
  }

  return { ok: true, pageCount };
}

/** User-facing message for each violation kind — Architecture §4.1 Screen 2. */
export function describeIngestionCapViolation(violation: IngestionCapViolation): string {
  switch (violation.kind) {
    case "file_too_large":
      return `This file is ${(violation.sizeBytes / (1024 * 1024)).toFixed(1)} MB, which is over the ${(violation.maxBytes / (1024 * 1024)).toFixed(0)} MB limit.`;
    case "not_a_pdf":
      return "This file doesn't look like a PDF. Please upload the original statement file.";
    case "too_many_pages":
      return `This document has ${violation.pageCount} pages, which is over the ${violation.maxPages}-page limit.`;
    case "unreadable":
      return "This file appears damaged — try re-downloading it from your bank.";
  }
}
