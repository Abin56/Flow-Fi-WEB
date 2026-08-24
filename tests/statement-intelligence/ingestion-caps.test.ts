/**
 * Real PDF fixtures generated with pdf-lib (not fabricated byte strings) —
 * backlog M1-T4 acceptance criteria: "Files over the size/page cap are
 * rejected client-side with a clear message before upload begins."
 */

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_PAGE_COUNT,
  describeIngestionCapViolation,
  validateIngestionCaps,
} from "@/lib/statement-intelligence/ingestion-caps";

async function makePdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([200, 200]);
  return pdf.save();
}

describe("validateIngestionCaps", () => {
  it("accepts a real, small, well-formed PDF and reports its true page count", async () => {
    const bytes = await makePdf(3);
    const result = await validateIngestionCaps(bytes);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pageCount).toBe(3);
  });

  it("accepts a PDF right at the page-count boundary", async () => {
    const bytes = await makePdf(MAX_PAGE_COUNT);
    const result = await validateIngestionCaps(bytes);
    expect(result.ok).toBe(true);
  });

  it("rejects a real PDF that exceeds the page-count cap", async () => {
    const bytes = await makePdf(MAX_PAGE_COUNT + 1);
    const result = await validateIngestionCaps(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation.kind).toBe("too_many_pages");
      if (result.violation.kind === "too_many_pages") {
        expect(result.violation.pageCount).toBe(MAX_PAGE_COUNT + 1);
      }
    }
  });

  it("rejects a file over the size cap before even attempting to parse it", async () => {
    const oversized = new Uint8Array(MAX_FILE_SIZE_BYTES + 1);
    oversized.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // valid %PDF- prefix, still too big
    const result = await validateIngestionCaps(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation.kind).toBe("file_too_large");
  });

  it("rejects a non-PDF file even when it would otherwise pass size checks (defense in depth, RFC §28.5)", async () => {
    const pngMagicBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await validateIngestionCaps(pngMagicBytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation.kind).toBe("not_a_pdf");
  });

  it("rejects a truncated/corrupted PDF (has the magic bytes but isn't structurally valid)", async () => {
    const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00, 0x00]);
    const result = await validateIngestionCaps(corrupt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation.kind).toBe("unreadable");
  });

  it("produces a clear, user-facing message for every violation kind", () => {
    expect(describeIngestionCapViolation({ kind: "file_too_large", sizeBytes: 60_000_000, maxBytes: MAX_FILE_SIZE_BYTES })).toContain("MB");
    expect(describeIngestionCapViolation({ kind: "not_a_pdf" })).toContain("PDF");
    expect(describeIngestionCapViolation({ kind: "too_many_pages", pageCount: 400, maxPages: MAX_PAGE_COUNT })).toContain("400");
    expect(describeIngestionCapViolation({ kind: "unreadable", message: "x" })).toContain("damaged");
  });
});
