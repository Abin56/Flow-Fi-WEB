/**
 * HDFC Statement Metadata Extractor — Task 4 module 1
 * (docs/parser-pipeline-design.md v3 §10; ADR-006).
 *
 * Built and validated directly against a real, redacted HDFC Freedom Credit
 * Card statement (functions/tests/fixtures/real-statements/hdfc-freedom-2026-07.items.json)
 * per the user's explicit requirement — no assumptions about generic HDFC
 * formatting. Every anchor label string below is copied verbatim from that
 * real document's extracted text items, not guessed from general knowledge.
 *
 * Real-document findings that shaped this module (documented here so a
 * future reader doesn't "fix" what looks like a gap but is actually a real
 * absence on this card product):
 *  - No distinct "Statement Number" field exists on this card layout at all
 *    (only Credit Card No. / Alternate Account Number / CKYC ID) — always
 *    extracted as unavailable, not a bug.
 *  - No card network (Visa/Mastercard/RuPay) text is extractable — likely
 *    logo-only in the real PDF.
 *  - No "Cashback" or "Late Fee" line items exist on this card product.
 *  - The printed "₹" glyph decodes as a bare "C" text run in this PDF's
 *    font (no ToUnicode mapping for it) — filtered out by
 *    `page-layout.ts`'s `valueBelowLabel`, never parsed as part of a value.
 *  - Deterministic parsing only — no AI/OCR/LLM.
 */

import type { BillingSummary, CardInfo, ExtractedField, ExtractedFieldSource, StatementInfo } from "../../workspace/statement-workspace-model";
import type { PdfPageText } from "../../pdf/pdf-document-provider";
import { findRowByLabel, groupPagesIntoRows, parseAmount, valueBelowLabel, valueRightOfLabel, type LayoutRow } from "../page-layout";

function field<T>(value: T, confidence: number, source: ExtractedFieldSource = "exact_match"): ExtractedField<T> {
  return { value, confidence, source };
}

function unavailable<T>(): ExtractedField<T | null> {
  return { value: null, confidence: 0, source: "unavailable" };
}

/** HDFC prints dates as "19 Jul, 2026" — parsed as UTC to stay consistent with the rest of the canonical model (never local-timezone-dependent). */
function parseHdfcDate(raw: string): Date | null {
  const match = /^(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = months.indexOf(match[2]!);
  if (monthIndex === -1) return null;
  return new Date(Date.UTC(Number(match[3]), monthIndex, Number(match[1])));
}

/** "20 Jun, 2026 - 19 Jul, 2026" → [start, end]. */
function parseBillingPeriod(raw: string): [Date | null, Date | null] {
  const parts = raw.split(/\s*-\s*/);
  if (parts.length !== 2) return [null, null];
  return [parseHdfcDate(parts[0]!), parseHdfcDate(parts[1]!)];
}

function amountField(rows: LayoutRow[], label: string, confidence: number): ExtractedField<number | null> {
  const raw = valueBelowLabel(rows, label);
  if (raw == null) return unavailable();
  const amount = parseAmount(raw);
  if (amount == null) return unavailable();
  return field(amount, confidence);
}

export interface HdfcMetadataExtractionResult {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
}

/**
 * Bank/card template detection for this parser: true only when the
 * statement's own footer prints "<Bank> Credit Cards GSTIN: ...", the
 * anchor this whole module is built against. Real Table Detector/bank
 * dispatch (Task 4 module 2+) will use this as one of its signals.
 */
export function isHdfcStatement(pages: PdfPageText[]): boolean {
  return pages.some((page) => page.items.some((item) => /^HDFC Bank Credit Cards GSTIN:/.test(item.str.trim())));
}

export function extractHdfcMetadata(pages: PdfPageText[]): HdfcMetadataExtractionResult {
  // Rows are grouped per page and tagged with their page number
  // (page-layout.ts) — two real bugs were caught building this module
  // against the real statement: (1) grouping raw items across pages before
  // row-detection merges unrelated rows that share a similar page-local y;
  // (2) even with per-page grouping, `valueBelowLabel`'s "row below"
  // search must also stay confined to the label's own page, or it can
  // match a same-x, similar-y item from a completely different page (e.g.
  // a page-3 transaction amount instead of the real page-1 due date).
  const rows = groupPagesIntoRows(pages);
  const allItems = pages.flatMap((page) => page.items);

  const bankNameMatch = allItems.map((item) => /^(.+?) Credit Cards GSTIN:/.exec(item.str.trim())).find((m) => m != null);
  const bankName = bankNameMatch ? field(bankNameMatch[1]!, 0.98) : unavailable<string>();

  const cardTitleMatch = allItems.map((item) => /^(.+?) Credit Card Statement$/.exec(item.str.trim())).find((m) => m != null);
  const cardName = cardTitleMatch ? field(`${cardTitleMatch[1]} Credit Card`, 0.9, "pattern_match") : unavailable<string>();

  const cardNumberRaw = valueRightOfLabel(rows, "Credit Card No.");
  const cardLast4Match = cardNumberRaw ? /(\d{4})$/.exec(cardNumberRaw) : null;
  const cardLast4 = cardLast4Match ? field(cardLast4Match[1]!, 0.99) : unavailable<string>();

  const statementDateRaw = valueRightOfLabel(rows, "Statement Date");
  const statementDate = statementDateRaw ? field(parseHdfcDate(statementDateRaw), 0.98) : unavailable<Date>();

  const billingPeriodRaw = valueRightOfLabel(rows, "Billing Period");
  const [billingStart, billingEnd] = billingPeriodRaw ? parseBillingPeriod(billingPeriodRaw) : [null, null];

  const dueDateRaw = valueBelowLabel(rows, "DUE DATE");
  const dueDate = dueDateRaw ? field(parseHdfcDate(dueDateRaw), 0.97) : unavailable<Date>();

  const statementInfo: StatementInfo = {
    // Not present on this HDFC card product's layout at all (see module comment) — genuinely absent, not a parsing miss.
    statementNumber: unavailable<string>(),
    statementDate,
    billingPeriodStart: billingStart ? field(billingStart, 0.96) : unavailable<Date>(),
    billingPeriodEnd: billingEnd ? field(billingEnd, 0.96) : unavailable<Date>(),
    paymentDueDate: dueDate,
  };

  const cardInfo: CardInfo = {
    bankName,
    cardName,
    cardLast4,
    // No network (Visa/Mastercard/RuPay) text is extractable on this statement — likely logo-only.
    network: unavailable<string>(),
  };

  const previousStatementDues = amountField(rows, "PREVIOUS STATEMENT DUES", 0.95);
  const totalAmountDue = amountField(rows, "TOTAL AMOUNT DUE", 0.98);
  const minimumDue = amountField(rows, "MINIMUM DUE", 0.97);
  const creditLimit = amountField(rows, "TOTAL CREDIT LIMIT", 0.96);
  const availableCreditLimit = amountField(rows, "AVAILABLE CREDIT LIMIT", 0.95);
  const rewardPointsEarned = amountField(rows, "Earned", 0.85);
  const financeCharges = amountField(rows, "FINANCE CHARGES", 0.95);
  const totalGst = amountField(rows, "TOTAL GST", 0.9);

  const billingSummary: BillingSummary = {
    openingBalance: previousStatementDues,
    // No distinct "Closing Balance" label exists on this statement — Total Amount Due is the equivalent (confirmed by reconciling opening + purchases - payments against it during this module's investigation).
    closingBalance: totalAmountDue,
    minimumDue,
    totalDue: totalAmountDue,
    creditLimit,
    availableCredit: availableCreditLimit,
    rewardPointsEarned,
    // Not present on this card product.
    cashback: unavailable<number>(),
    interestCharged: financeCharges,
    gst: totalGst,
    // Not present on this card product.
    lateFee: unavailable<number>(),
  };

  return { statementInfo, cardInfo, billingSummary };
}

// Re-exported for the Row Extractor (Task 4 module 3), which needs the same row-finding utility to identify the "Domestic Transactions" / "International Transactions" table anchors.
export { findRowByLabel, groupPagesIntoRows };
