/**
 * Document-level edge fixtures — GOLDEN, immutable (docs/parser-pipeline-design.md
 * v3 Task 2, requirement 3 & 5). These exist to validate pipeline
 * BEHAVIOR (does the existing PDF Provider / ingestion-caps infrastructure
 * react correctly), not transaction-volume scenarios — they intentionally
 * don't need hundreds of rows.
 *
 * Reuses the real Standard Security Handler encryptor already built and
 * verified in Milestone 1 (functions/tests/fixtures/pdf-standard-security-handler.ts)
 * rather than re-implementing PDF encryption a second time.
 */

import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { addPasswordProtection } from "../pdf-standard-security-handler";

export const EDGE_FIXTURE_PASSWORD = "EdgeCase1234!";

/** A real, valid, password-protected PDF (RC4 40-bit, verified against real pdfjs-dist in M1-T7's suite). */
export async function makeEncryptedPdf(pageCount = 2): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([300, 300]);
  addPasswordProtection(pdf, EDGE_FIXTURE_PASSWORD, EDGE_FIXTURE_PASSWORD);
  return pdf.save({ useObjectStreams: false });
}

/** Same encrypted document — reused by the "wrong password" test case rather than duplicated. */
export const makeWrongPasswordTargetPdf = makeEncryptedPdf;

/** Real %PDF- magic bytes, structurally broken beyond that. */
export function makeCorruptedPdf(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/** A genuinely 0-page PDF (pdf-lib's addDefaultPage:false, per the real finding in M1-T7 that this default silently re-adds a page). */
export async function makeBlankDocumentPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  return pdf.save({ addDefaultPage: false });
}

/** A single page with no text drawn at all — a deterministic proxy for "scanned image, no extractable text layer" without needing real OCR/image assets. */
export async function makeNoTextLayerPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]); // blank canvas, no drawText call
  return pdf.save({ addDefaultPage: false });
}

/** A page rotated 90 degrees — real pdf-lib rotation metadata, exercising the same "auto-rotate before extraction" edge case named in Architecture §22. */
export async function makeRotatedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 300]);
  page.drawText("HDFC Bank Statement Summary", { x: 10, y: 150, size: 10, font });
  page.setRotation(degrees(90));
  return pdf.save({ addDefaultPage: false });
}

/** Page count intentionally near lib/statement-intelligence/ingestion-caps.ts's MAX_PAGE_COUNT boundary (300). */
export async function makeVeryLargePageCountPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([300, 300]);
  return pdf.save({ addDefaultPage: false });
}

/** Generic, bank-agnostic text — no fingerprint keywords for any of the 4 seeded issuer templates, exercising the Document Classifier's "no confident match" fallback path (Architecture §16 Stage 2) once that classifier exists. */
export async function makeUnsupportedLayoutPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 300]);
  page.drawText("Generic Account Activity Report — Some Financial Institution", { x: 10, y: 150, size: 9, font });
  return pdf.save({ addDefaultPage: false });
}
