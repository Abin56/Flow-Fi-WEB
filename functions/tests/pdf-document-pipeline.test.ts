/**
 * Real PDF fixtures + the real PdfjsDocumentProvider — backlog M2-T2's
 * Pipeline layer. Proves PdfDocumentPipeline genuinely opens and reads
 * the document rather than fabricating a result.
 */

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { PdfDocumentPipeline } from "../src/pipeline/pdf-document-pipeline";
import { PdfjsDocumentProvider } from "../src/pdf/pdfjs-document-provider";

async function makePlainPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([300, 300]);
  return pdf.save({ addDefaultPage: false });
}

describe("PdfDocumentPipeline", () => {
  it("returns 'parsed' with the real page count for a valid PDF", async () => {
    const bytes = await makePlainPdf(4);
    const pipeline = new PdfDocumentPipeline(new PdfjsDocumentProvider());
    const result = await pipeline.run(bytes);
    expect(result).toEqual({ outcome: "parsed", pageCount: 4 });
  });

  it("returns 'failed' with failureReason 'parsing_failed' for a corrupted PDF", async () => {
    const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00, 0x00]);
    const pipeline = new PdfDocumentPipeline(new PdfjsDocumentProvider());
    const result = await pipeline.run(corrupt);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.failureReason).toBe("parsing_failed");
  });

  it("never throws — always resolves to a DocumentPipelineResult, even for garbage input", async () => {
    const garbage = new Uint8Array([1, 2, 3]);
    const pipeline = new PdfDocumentPipeline(new PdfjsDocumentProvider());
    await expect(pipeline.run(garbage)).resolves.toMatchObject({ outcome: "failed" });
  });
});
