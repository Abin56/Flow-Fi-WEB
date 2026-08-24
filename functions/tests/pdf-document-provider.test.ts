/**
 * Real pdf-lib-generated fixtures + the real pdfjs-dist library — no
 * mocking of the PDF parsing/decryption behavior itself. Encrypted
 * fixtures are built with the test-only Standard Security Handler
 * implementation (tests/fixtures/pdf-standard-security-handler.ts),
 * itself verified against the standard RC4 test vector in a sibling suite
 * — so a wrong password genuinely fails against real, independent
 * decryption logic, and the right one genuinely succeeds. Backlog M1-T7.
 */

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { PdfDocumentError } from "../src/pdf/pdf-document-provider";
import { PdfjsDocumentProvider } from "../src/pdf/pdfjs-document-provider";
import { addPasswordProtection } from "./fixtures/pdf-standard-security-handler";

const USER_PASSWORD = "Test1234";

async function makePlainPdf(pageCount: number, withText = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = withText ? await pdf.embedFont(StandardFonts.Helvetica) : null;
  for (let i = 0; i < pageCount; i++) {
    const page = pdf.addPage([300, 300]);
    if (font) page.drawText(`Statement page ${i + 1} — HDFC Regalia — Txn AMAZON INDIA Rs 4999.00`, { x: 10, y: 150, size: 10, font });
  }
  // addDefaultPage defaults to true — without disabling it, a genuinely
  // 0-page document silently gets a page added back at save() time, which
  // is exactly what happened the first time this fixture was written (see
  // the "EMPTY DOCUMENT" test below and pdf-standard-security-handler.ts's
  // module comment for the sibling lesson about pdf-lib's save() defaults).
  return pdf.save({ addDefaultPage: false });
}

async function makeEncryptedPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([300, 300]);
  addPasswordProtection(pdf, USER_PASSWORD, USER_PASSWORD);
  // useObjectStreams defaults to true, which packs objects into a
  // compressed Object Stream constructed internally during save() — AFTER
  // addPasswordProtection's per-object encryption loop already ran against
  // context.enumerateIndirectObjects(). The packed stream never went
  // through that loop, so the fixture was invalid until this was disabled
  // (empirically found via pdfjs-dist itself rejecting the correct
  // password — see pdf-standard-security-handler.ts's module comment).
  return pdf.save({ useObjectStreams: false });
}

describe("PdfjsDocumentProvider — plain (unencrypted) PDFs", () => {
  it("opens a real PDF and reports the correct page count", async () => {
    const bytes = await makePlainPdf(3);
    const provider = new PdfjsDocumentProvider();
    const handle = await provider.open(bytes);
    try {
      expect(handle.pageCount).toBe(3);
    } finally {
      await handle.destroy();
    }
  });

  it("extracts real text content from pages", async () => {
    const bytes = await makePlainPdf(1, true);
    const provider = new PdfjsDocumentProvider();
    const handle = await provider.open(bytes);
    try {
      const page = await handle.getPageText(1);
      expect(page.text).toContain("AMAZON INDIA");
    } finally {
      await handle.destroy();
    }
  });

  it("EMPTY DOCUMENT: throws PDF_EMPTY for a real zero-page PDF", async () => {
    const bytes = await makePlainPdf(0);
    const provider = new PdfjsDocumentProvider();
    await expect(provider.open(bytes)).rejects.toMatchObject({ code: "PDF_EMPTY" });
  });

  it("PDF_EMPTY is reachable code, not dead code — the guard fires whenever numPages is genuinely 0", async () => {
    // The fixture above already proves this against a real PDF once
    // addDefaultPage:false stops pdf-lib re-inserting a page at save()
    // time. This second assertion just pins the exact numPages value the
    // fixture produces, so a future pdf-lib upgrade that silently changes
    // that default again fails loudly here instead of via the PDF_EMPTY
    // test's rejection alone looking like a false pass.
    const bytes = await makePlainPdf(0);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(0);
  });

  it("CORRUPTED PDF: throws PDF_CORRUPTED for malformed bytes", async () => {
    const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const provider = new PdfjsDocumentProvider();
    await expect(provider.open(corrupt)).rejects.toMatchObject({ code: "PDF_CORRUPTED" });
  });

  it("errors are always PdfDocumentError with a standardized code, never a raw pdfjs exception", async () => {
    const corrupt = new Uint8Array([0x00, 0x01, 0x02]);
    const provider = new PdfjsDocumentProvider();
    try {
      await provider.open(corrupt);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PdfDocumentError);
      expect((e as PdfDocumentError).name).toBe("PdfDocumentError");
    }
  });
});

describe("PdfjsDocumentProvider — password-protected PDFs (RC4 40-bit, real Standard Security Handler)", () => {
  it("CORRECT PASSWORD: opens successfully and reports the right page count", async () => {
    const bytes = await makeEncryptedPdf(2);
    const provider = new PdfjsDocumentProvider();
    const handle = await provider.open(bytes, USER_PASSWORD);
    try {
      expect(handle.pageCount).toBe(2);
    } finally {
      await handle.destroy();
    }
  });

  it("INCORRECT PASSWORD: throws INVALID_PASSWORD, proven against real decryption logic", async () => {
    const bytes = await makeEncryptedPdf(2);
    const provider = new PdfjsDocumentProvider();
    await expect(provider.open(bytes, "wrong-password")).rejects.toMatchObject({ code: "INVALID_PASSWORD" });
  });

  it("ENCRYPTED WITHOUT PASSWORD: throws PDF_ENCRYPTED when no password is supplied at all", async () => {
    const bytes = await makeEncryptedPdf(2);
    const provider = new PdfjsDocumentProvider();
    await expect(provider.open(bytes)).rejects.toMatchObject({ code: "PDF_ENCRYPTED" });
  });

  it("an empty-string password is treated the same as no password (pdfjs-dist's real behavior, verified empirically)", async () => {
    const bytes = await makeEncryptedPdf(2);
    const provider = new PdfjsDocumentProvider();
    await expect(provider.open(bytes, "")).rejects.toMatchObject({ code: "PDF_ENCRYPTED" });
  });
});

describe("PdfjsDocumentProvider — large statement", () => {
  it("LARGE STATEMENT: handles a 50-page document with real per-page text extraction", async () => {
    const bytes = await makePlainPdf(50, true);
    const provider = new PdfjsDocumentProvider();
    const handle = await provider.open(bytes);
    try {
      expect(handle.pageCount).toBe(50);
      const allPages = await handle.getAllPageText();
      expect(allPages).toHaveLength(50);
      expect(allPages[0]!.text).toContain("Statement page 1");
      expect(allPages[49]!.text).toContain("Statement page 50");
    } finally {
      await handle.destroy();
    }
  }, 30000);
});
