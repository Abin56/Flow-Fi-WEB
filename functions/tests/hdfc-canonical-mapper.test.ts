/**
 * HDFC Canonical Transaction Mapper (Task 4, module 5) — validated against
 * the real (redacted) HDFC Freedom statement, end-to-end from PDF text
 * items through every parser module built in Task 4.
 */

import { describe, expect, it } from "vitest";
import { detectHdfcTransactionTableRegions } from "../src/parsing/hdfc/hdfc-table-detector";
import { extractHdfcRawTransactionRows } from "../src/parsing/hdfc/hdfc-row-extractor";
import { extractHdfcTransactionFields } from "../src/parsing/hdfc/hdfc-field-extractor";
import { mapHdfcFieldsToWorkspaceTransactions } from "../src/parsing/hdfc/hdfc-canonical-mapper";
import { WorkspaceTransactionSchema } from "../src/workspace/statement-workspace-model";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const pages = loadRealStatementPages(hdfcFreedomItems as never);

function runFullPipeline(accountId?: string) {
  const regions = detectHdfcTransactionTableRegions(pages);
  const rawRows = extractHdfcRawTransactionRows(regions);
  const fields = rawRows.map(extractHdfcTransactionFields);
  return mapHdfcFieldsToWorkspaceTransactions(fields, { accountId });
}

describe("mapHdfcFieldsToWorkspaceTransactions — end-to-end against the real HDFC Freedom statement", () => {
  const transactions = runFullPipeline("acct-hdfc-freedom-test");

  it("produces exactly 19 WorkspaceTransaction objects, each schema-valid", () => {
    expect(transactions).toHaveLength(19);
    for (const t of transactions) {
      const result = WorkspaceTransactionSchema.safeParse(t);
      if (!result.success) console.error(result.error.format());
      expect(result.success).toBe(true);
    }
  });

  it("assigns sequential sourceLineIndex/originalRowNumber matching document order", () => {
    transactions.forEach((t, i) => {
      expect(t.sourceLineIndex).toBe(i);
      expect(t.originalRowNumber).toBe(i + 1);
    });
  });

  it("total debit/credit across the mapped transactions still matches the statement's own printed totals", () => {
    const totalDebit = transactions.filter((t) => t.direction.value === "debit").reduce((sum, t) => sum + t.amount.value, 0);
    const totalCredit = transactions.filter((t) => t.direction.value === "credit").reduce((sum, t) => sum + t.amount.value, 0);
    expect(totalDebit).toBeCloseTo(10006.61, 2);
    expect(totalCredit).toBeCloseTo(3911.0, 2);
  });

  it("performs no categorization, merchant normalization, or duplicate detection — every such placeholder is untouched", () => {
    for (const t of transactions) {
      expect(t.suggestedCategory).toBeNull();
      expect(t.suggestedPerson).toBeNull();
      expect(t.suggestedTags).toEqual([]);
      expect(t.expenseType).toBeNull();
      expect(t.transferDetected).toBe(false);
      expect(t.recurringDetected).toBe(false);
      expect(t.subscriptionDetected).toBe(false);
      expect(t.duplicateCandidateOf).toBeNull();
      expect(t.warnings).toEqual([]);
    }
  });

  it("assigns the caller-supplied account directly (a tag, not an inference) to every row", () => {
    for (const t of transactions) {
      expect(t.suggestedAccount).toEqual({ value: "acct-hdfc-freedom-test", confidence: 1, source: "account_assignment" });
    }
  });

  it("leaves suggestedAccount null when no accountId is supplied", () => {
    const withoutAccount = runFullPipeline();
    for (const t of withoutAccount) expect(t.suggestedAccount).toBeNull();
  });

  it("every row's needsReview is false — every real row extracted cleanly", () => {
    for (const t of transactions) expect(t.needsReview).toBe(false);
  });

  it("preserves the reconstructed merchant/description text exactly from Module 3/4", () => {
    const emiRow = transactions.find((t) => t.merchantRaw.value.includes("RONY GEORGEERNAKULAM"));
    expect(emiRow?.merchantRaw.value).toBe("EMI RONY GEORGEERNAKULAM");
    expect(emiRow?.description.value).toBeNull();
  });

  it("is deterministic — running the full pipeline twice produces identical output", () => {
    const again = runFullPipeline("acct-hdfc-freedom-test");
    expect(again).toEqual(transactions);
  });

  // --- Module 5 independent validation (real-data checks, not trusting the mapper's own claims) ---

  it("maps 17 domestic + 2 international rows (via sourcePage/originalRawText — no section field on WorkspaceTransaction itself, cross-checked against Module 2/3's own region counts)", () => {
    const regions = detectHdfcTransactionTableRegions(pages);
    const rawRows = extractHdfcRawTransactionRows(regions);
    expect(rawRows.filter((r) => r.sectionType === "domestic")).toHaveLength(17);
    expect(rawRows.filter((r) => r.sectionType === "international")).toHaveLength(2);
    expect(transactions).toHaveLength(rawRows.length);
  });

  it("produces exactly one WorkspaceTransaction per Module 4 extracted-fields row — no duplication, no drops", () => {
    const regions = detectHdfcTransactionTableRegions(pages);
    const rawRows = extractHdfcRawTransactionRows(regions);
    const extracted = rawRows.map(extractHdfcTransactionFields);
    expect(transactions).toHaveLength(extracted.length);
    // 1:1 positional correspondence — every transaction's merchant/amount must trace back to its own row, not a shifted/duplicated one.
    transactions.forEach((t, i) => {
      expect(t.merchantRaw.value).toBe(extracted[i]!.merchant.value);
      expect(t.amount.value).toBe(extracted[i]!.amount.value ?? 0);
    });
  });

  it("amount precision is preserved to the paisa (2 decimal places) — no floating-point drift introduced by the mapper", () => {
    const expectedAmounts = [
      1361.24, 28.26, 7.2, 6000.0, 189.0, 378.0, 6.62, 62.3, 3911.0, 504.17, 11.0, 79.0, 1.38, 500.0, 695.0, 152.0, 30.0, 1.19, 0.25,
    ];
    expect(transactions.map((t) => t.amount.value)).toEqual(expectedAmounts);
  });

  it("direction is derived correctly: exactly the CREDIT CARD PAYMENT row is credit, every other row is debit", () => {
    const creditRows = transactions.filter((t) => t.direction.value === "credit");
    expect(creditRows).toHaveLength(1);
    expect(creditRows[0]!.merchantRaw.value).toContain("CREDIT CARD PAYMENT");
    expect(transactions.filter((t) => t.direction.value === "debit")).toHaveLength(18);
  });

  it("value date is present as a field (optional on the schema) and correctly unavailable for every row on this bank's layout", () => {
    for (const t of transactions) {
      expect(t.valueDate).toBeDefined();
      expect(t.valueDate!.value).toBeNull();
      expect(t.valueDate!.source).toBe("unavailable");
    }
  });

  it("transaction date mapping is correct against every real row's known value", () => {
    const expectedDates = [
      "2026-06-19T22:16:00.000Z",
      "2026-06-19T00:00:00.000Z",
      "2026-06-19T00:00:00.000Z",
      "2026-06-25T12:40:00.000Z",
      "2026-06-25T04:24:00.000Z",
      "2026-06-30T04:51:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T16:21:00.000Z",
      "2026-07-06T21:36:00.000Z",
      "2026-07-09T00:48:00.000Z",
      "2026-07-14T09:24:00.000Z",
      "2026-07-14T02:20:00.000Z",
      "2026-07-16T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    ];
    expect(transactions.map((t) => t.date.value?.toISOString())).toEqual(expectedDates);
  });

  it("reference number mapping is preserved exactly (value, and unavailable rows stay unavailable)", () => {
    const withRef = transactions.filter((t) => t.referenceNumber.value != null);
    expect(withRef).toHaveLength(11);
    const specific = transactions.find((t) => t.merchantRaw.value.includes("2717151193919"));
    expect(specific?.referenceNumber.value).toBe("09999999980619002660882");
  });

  it("field provenance (page, boundingBox, extractionMethod) survives the mapping for date/amount/direction/merchant/referenceNumber — none is silently dropped", () => {
    const regions = detectHdfcTransactionTableRegions(pages);
    const rawRows = extractHdfcRawTransactionRows(regions);
    const extracted = rawRows.map(extractHdfcTransactionFields);

    transactions.forEach((t, i) => {
      const e = extracted[i]!;
      expect(t.date.page).toBe(e.transactionDate.page);
      expect(t.date.boundingBox).toEqual(e.transactionDate.boundingBox);
      expect(t.amount.page).toBe(e.amount.page);
      expect(t.amount.boundingBox).toEqual(e.amount.boundingBox);
      expect(t.merchantRaw.page).toBe(e.merchant.page);
      expect(t.merchantRaw.boundingBox).toEqual(e.merchant.boundingBox);
      expect(t.referenceNumber.boundingBox).toEqual(e.referenceNumber.boundingBox);
      expect(t.referenceNumber.extractionMethod).toBe(e.referenceNumber.extractionMethod);
    });
  });

  it("direction's provenance is whichever of debit/credit actually won for that row, not fabricated", () => {
    const regions = detectHdfcTransactionTableRegions(pages);
    const rawRows = extractHdfcRawTransactionRows(regions);
    const extracted = rawRows.map(extractHdfcTransactionFields);

    transactions.forEach((t, i) => {
      const e = extracted[i]!;
      const winningField = t.direction.value === "credit" ? e.credit : e.debit;
      expect(t.direction.page).toBe(winningField.page);
      expect(t.direction.boundingBox).toEqual(winningField.boundingBox);
      expect(t.direction.confidence).toBe(winningField.confidence);
      expect(t.direction.source).toBe(winningField.source);
    });
  });

  it("page numbers on every transaction correctly reflect which physical page the row came from", () => {
    const domesticPage1Count = transactions.filter((t) => t.sourcePage === 1).length;
    const page2Count = transactions.filter((t) => t.sourcePage === 2).length;
    expect(domesticPage1Count).toBe(5);
    expect(page2Count).toBe(14); // 12 domestic + 2 international, both on page 2
    expect(transactions.some((t) => t.sourcePage === 3 || t.sourcePage === 4)).toBe(false);
  });

  it("confidence values are unchanged (not recomputed/rescaled) from Module 4's own per-field confidence for date/amount/merchant", () => {
    const regions = detectHdfcTransactionTableRegions(pages);
    const rawRows = extractHdfcRawTransactionRows(regions);
    const extracted = rawRows.map(extractHdfcTransactionFields);
    transactions.forEach((t, i) => {
      const e = extracted[i]!;
      expect(t.date.confidence).toBe(e.transactionDate.confidence);
      expect(t.amount.confidence).toBe(e.amount.confidence);
      expect(t.merchantRaw.confidence).toBe(e.merchant.confidence);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration test: PDF items → every Task 4 module → WorkspaceTransaction[]
// ---------------------------------------------------------------------------

describe("Full HDFC parsing pipeline (PDF → Metadata/Table/Row/Field/Canonical Mapper) — end-to-end against the real statement", () => {
  it("reproduces the real HDFC statement's exact transaction structure with no data loss between stages", () => {
    const regions = detectHdfcTransactionTableRegions(pages);
    const rawRows = extractHdfcRawTransactionRows(regions);
    const extracted = rawRows.map(extractHdfcTransactionFields);
    const mapped = mapHdfcFieldsToWorkspaceTransactions(extracted, { accountId: "acct-e2e" });

    // Row counts must match at every single stage boundary — proves no stage silently drops or duplicates a row.
    expect(rawRows).toHaveLength(19);
    expect(extracted).toHaveLength(19);
    expect(mapped).toHaveLength(19);

    const domestic = rawRows.filter((r) => r.sectionType === "domestic");
    const international = rawRows.filter((r) => r.sectionType === "international");
    expect(domestic).toHaveLength(17);
    expect(international).toHaveLength(2);

    const totalDebit = mapped.filter((t) => t.direction.value === "debit").reduce((sum, t) => sum + t.amount.value, 0);
    const totalCredit = mapped.filter((t) => t.direction.value === "credit").reduce((sum, t) => sum + t.amount.value, 0);
    expect(totalDebit).toBeCloseTo(10006.61, 2);
    expect(totalCredit).toBeCloseTo(3911.0, 2);

    for (const t of mapped) {
      const result = WorkspaceTransactionSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  it("is fully deterministic end-to-end: running the whole pipeline twice from raw PDF items produces byte-identical output", () => {
    function runOnce() {
      const regions = detectHdfcTransactionTableRegions(pages);
      const rawRows = extractHdfcRawTransactionRows(regions);
      const extracted = rawRows.map(extractHdfcTransactionFields);
      return mapHdfcFieldsToWorkspaceTransactions(extracted, { accountId: "acct-e2e" });
    }
    expect(runOnce()).toEqual(runOnce());
  });
});
