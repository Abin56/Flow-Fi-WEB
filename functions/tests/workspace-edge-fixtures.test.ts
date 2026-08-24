/**
 * Document-level edge fixture tests — docs/parser-pipeline-design.md v3
 * Task 2, requirement 3. See functions/tests/fixtures/workspace-edge/README.md
 * for what each fixture validates and why. PDF-byte-level cases are
 * checked against the REAL PdfjsDocumentProvider (M1-T7) and the real
 * ingestion-caps validator (M1-T4) — no mocking of pipeline behavior.
 */

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { StatementWorkspaceModelSchema } from "../src/workspace/statement-workspace-model";
import { runAllBusinessValidation } from "./fixtures/workspace/business-validation";
import {
  FOREIGN_CURRENCY_FIXTURE,
  MISSING_LAST_PAGE_FIXTURE,
  NO_TRANSACTION_TABLE_FIXTURE,
  VERY_OLD_STATEMENT_FIXTURE,
} from "./fixtures/workspace-edge/model-edge-fixtures";
import {
  EDGE_FIXTURE_PASSWORD,
  makeBlankDocumentPdf,
  makeCorruptedPdf,
  makeEncryptedPdf,
  makeNoTextLayerPdf,
  makeRotatedPdf,
  makeUnsupportedLayoutPdf,
  makeVeryLargePageCountPdf,
  makeWrongPasswordTargetPdf,
} from "./fixtures/workspace-edge/pdf-byte-fixtures";
import { PdfjsDocumentProvider } from "../src/pdf/pdfjs-document-provider";

const provider = new PdfjsDocumentProvider();

// Mirrors lib/statement-intelligence/ingestion-caps.ts's MAX_PAGE_COUNT
// (web package, M1-T4) — NOT imported directly: functions/ is a separate
// npm package (docs/adr/ADR-001) with its own tsconfig `rootDir`, which
// correctly rejects reaching into a sibling package via a relative path
// (found by actually trying it — tsc error TS6059 — not assumed). These
// two tests exercise pdf-lib's real page counting at the same boundary
// value, without duplicating ingestion-caps.ts's validation logic itself.
const MIRRORED_MAX_PAGE_COUNT = 300;

describe("PDF-byte-level edge fixtures (real PdfjsDocumentProvider)", () => {
  it("Encrypted PDF: opens successfully with the correct password", async () => {
    const bytes = await makeEncryptedPdf();
    const handle = await provider.open(bytes, EDGE_FIXTURE_PASSWORD);
    expect(handle.pageCount).toBe(2);
    await handle.destroy();
  });

  it("Wrong Password: rejects with INVALID_PASSWORD", async () => {
    const bytes = await makeWrongPasswordTargetPdf();
    await expect(provider.open(bytes, "definitely-wrong")).rejects.toMatchObject({ code: "INVALID_PASSWORD" });
  });

  it("Corrupted PDF: rejects with PDF_CORRUPTED", async () => {
    const bytes = makeCorruptedPdf();
    await expect(provider.open(bytes)).rejects.toMatchObject({ code: "PDF_CORRUPTED" });
  });

  it("Blank Page (0-page document): rejects with PDF_EMPTY", async () => {
    const bytes = await makeBlankDocumentPdf();
    await expect(provider.open(bytes)).rejects.toMatchObject({ code: "PDF_EMPTY" });
  });

  it("Rotated PDF: opens successfully (real pdf-lib rotation metadata)", async () => {
    const bytes = await makeRotatedPdf();
    const handle = await provider.open(bytes);
    expect(handle.pageCount).toBe(1);
    await handle.destroy();
  });

  it("Scanned PDF (no text layer): opens successfully but page text is empty", async () => {
    const bytes = await makeNoTextLayerPdf();
    const handle = await provider.open(bytes);
    const page = await handle.getPageText(1);
    expect(page.text.trim()).toBe("");
    await handle.destroy();
  });

  it("Very Large Statement: a real PDF at the ingestion cap boundary has exactly that many pages", async () => {
    const bytes = await makeVeryLargePageCountPdf(MIRRORED_MAX_PAGE_COUNT);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(MIRRORED_MAX_PAGE_COUNT);
  });

  it("Very Large Statement: a real PDF one page over the cap boundary has exactly that many pages (lib/statement-intelligence/ingestion-caps.test.ts owns asserting this gets rejected)", async () => {
    const bytes = await makeVeryLargePageCountPdf(MIRRORED_MAX_PAGE_COUNT + 1);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(MIRRORED_MAX_PAGE_COUNT + 1);
  });

  it("Unsupported Layout: opens fine at the PDF level (classifier-level rejection is a later milestone, not yet built)", async () => {
    const bytes = await makeUnsupportedLayoutPdf();
    const handle = await provider.open(bytes);
    const page = await handle.getPageText(1);
    expect(page.text).toContain("Generic Account Activity Report");
    await handle.destroy();
  });
}, 30000);

describe("Model-level edge fixtures", () => {
  it("Missing Last Page: schema-valid, but business validation correctly flags the balance mismatch", () => {
    expect(StatementWorkspaceModelSchema.safeParse(MISSING_LAST_PAGE_FIXTURE).success).toBe(true);
    const violations = runAllBusinessValidation(MISSING_LAST_PAGE_FIXTURE);
    expect(violations.some((v) => v.includes("Balance arithmetic mismatch"))).toBe(true);
    expect(MISSING_LAST_PAGE_FIXTURE.validationPanel.report.passed).toBe(false);
  });

  it("No Transaction Table: schema-valid, zero transactions, diagnostics flags it, validation reports an error", () => {
    expect(StatementWorkspaceModelSchema.safeParse(NO_TRANSACTION_TABLE_FIXTURE).success).toBe(true);
    expect(NO_TRANSACTION_TABLE_FIXTURE.transactions).toHaveLength(0);
    expect(NO_TRANSACTION_TABLE_FIXTURE.diagnostics.transactionTableFound).toBe(false);
    expect(NO_TRANSACTION_TABLE_FIXTURE.validationPanel.report.passed).toBe(false);
  });

  it("Foreign Currency Statement: schema-valid, uses non-trivial currency confidence, passes business validation", () => {
    expect(StatementWorkspaceModelSchema.safeParse(FOREIGN_CURRENCY_FIXTURE).success).toBe(true);
    expect(runAllBusinessValidation(FOREIGN_CURRENCY_FIXTURE)).toEqual([]);
    expect(FOREIGN_CURRENCY_FIXTURE.transactions.every((t) => t.currency.value === "INR")).toBe(true);
    expect(FOREIGN_CURRENCY_FIXTURE.transactions.some((t) => t.originalRawText.includes("USD"))).toBe(true);
  });

  it("Very Old Statement: a legitimately old but valid date passes date-sanity checks", () => {
    expect(StatementWorkspaceModelSchema.safeParse(VERY_OLD_STATEMENT_FIXTURE).success).toBe(true);
    expect(runAllBusinessValidation(VERY_OLD_STATEMENT_FIXTURE)).toEqual([]);
    expect(VERY_OLD_STATEMENT_FIXTURE.statementInfo.statementDate.value?.getUTCFullYear()).toBe(2018);
  });
});
