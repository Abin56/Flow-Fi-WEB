/**
 * SBI Card Statement Metadata Extractor — the SBI-specific counterpart to
 * `../hdfc/hdfc-metadata-extractor.ts`, following the same discipline: built
 * and validated directly against a real, redacted SBI Card statement
 * (functions/tests/fixtures/real-statements/sbi-card-2026-07.items.json)
 * rather than assumed from general knowledge. Every anchor label string
 * below is copied verbatim from that real document's extracted text items.
 *
 * Real-document findings that shaped this module:
 *  - SBI Card's own GSTIN footer ("GSTIN of SBI Card : ...") is the bank
 *    detection anchor, mirroring HDFC's "<Bank> Credit Cards GSTIN:" — a
 *    different exact string, so `isHdfcStatement` never matches an SBI
 *    Card statement and vice versa (verified against the real fixture).
 *  - Every summary figure (Total/Minimum Amount Due, Credit Limit,
 *    Available Credit Limit, Previous Balance, Total Outstanding) is a
 *    "label above, value below, same column" box — the exact same layout
 *    convention `valueBelowLabel` (page-layout.ts) already handles for
 *    HDFC, just with SBI's own label strings and vertical gaps (~15-30pt,
 *    still inside `valueBelowLabel`'s default 12-40pt window).
 *  - No distinct "Closing Balance" label exists, same absence HDFC has —
 *    but unlike HDFC, SBI Card DOES print a genuinely distinct "Total
 *    Outstanding" figure (separate from "*Total Amount Due"), which is the
 *    better analog for `closingBalance`: the statement's own footnote
 *    explains "the difference...between Total Amount Due and Total
 *    Outstanding is the balance on Flexipay/Encash/Installments" — i.e.
 *    Total Outstanding is the true full balance, TAD is just what's due
 *    *this* cycle.
 *  - No reward-points, cashback, GST-total, or late-fee summary figure was
 *    found on this card product's first two pages (the only pages this
 *    module reads) — genuinely unavailable, not a parsing gap, same
 *    "absent on this product" caveat HDFC's module documents for its own
 *    missing fields.
 *  - No card network (Visa/Mastercard/RuPay) or product-name text (e.g.
 *    "SBI Card ELITE") is extractable on this statement — likely
 *    logo-only, same as HDFC's finding.
 *  - Deterministic parsing only — no AI/OCR/LLM.
 */

import type { BillingSummary, CardInfo, ExtractedField, ExtractedFieldSource, StatementInfo } from "../../workspace/statement-workspace-model";
import type { PdfPageText } from "../../pdf/pdf-document-provider";
import { groupPagesIntoRows, parseAmount, valueBelowLabel, valueRightOfLabel, type LayoutRow } from "../page-layout";

function field<T>(value: T, confidence: number, source: ExtractedFieldSource = "exact_match"): ExtractedField<T> {
  return { value, confidence, source };
}

function unavailable<T>(): ExtractedField<T | null> {
  return { value: null, confidence: 0, source: "unavailable" };
}

/** SBI Card prints dates as "17 Jul 2026" (summary box) — parsed as UTC, same convention as every other bank module in this parser. */
function parseSbiLongDate(raw: string): Date | null {
  const match = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = months.indexOf(match[2]!);
  if (monthIndex === -1) return null;
  return new Date(Date.UTC(Number(match[3]), monthIndex, Number(match[1])));
}

/** "for Statement Period: 18 Jun 26 to 17 Jul 26" — the short two-digit-year form, distinct from the summary box's four-digit-year dates so the two never get parsed with the wrong pattern. */
function parseBillingPeriodLine(raw: string): [Date | null, Date | null] {
  const match = /for Statement Period:\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})\s+to\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})/.exec(raw);
  if (!match) return [null, null];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const toDate = (day: string, mon: string, yy: string): Date | null => {
    const monthIndex = months.indexOf(mon);
    if (monthIndex === -1) return null;
    return new Date(Date.UTC(2000 + Number(yy), monthIndex, Number(day)));
  };
  return [toDate(match[1]!, match[2]!, match[3]!), toDate(match[4]!, match[5]!, match[6]!)];
}

function amountField(rows: LayoutRow[], label: string, confidence: number): ExtractedField<number | null> {
  const raw = valueBelowLabel(rows, label);
  if (raw == null) return unavailable();
  const amount = parseAmount(raw);
  if (amount == null) return unavailable();
  return field(amount, confidence);
}

export interface SbiMetadataExtractionResult {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
}

/** Bank/card template detection: true only when the statement prints "GSTIN of SBI Card : ...", the anchor this whole module is built against. */
export function isSbiStatement(pages: PdfPageText[]): boolean {
  return pages.some((page) => page.items.some((item) => /^GSTIN of SBI Card\s*:/.test(item.str.trim())));
}

export function extractSbiMetadata(pages: PdfPageText[]): SbiMetadataExtractionResult {
  const rows = groupPagesIntoRows(pages);
  const allItems = pages.flatMap((page) => page.items);

  const bankName = isSbiStatement(pages) ? field("SBI Card", 0.98) : unavailable<string>();
  // No distinct card-product title (e.g. "SBI Card ELITE") found on this statement's first pages — genuinely absent, not a parsing miss (see module comment).
  const cardName = unavailable<string>();

  const cardNumberRaw = valueBelowLabel(rows, "Credit Card Number");
  const cardLast4Match = cardNumberRaw ? /(\d{2})$/.exec(cardNumberRaw) : null;
  const cardLast4 = cardLast4Match ? field(cardLast4Match[1]!, 0.99) : unavailable<string>();

  const statementDateRaw = valueBelowLabel(rows, "Statement Date");
  const statementDate = statementDateRaw ? field(parseSbiLongDate(statementDateRaw), 0.98) : unavailable<Date>();

  const dueDateRaw = valueBelowLabel(rows, "Payment Due Date");
  const dueDate = dueDateRaw ? field(parseSbiLongDate(dueDateRaw), 0.97) : unavailable<Date>();

  const billingPeriodItem = allItems.find((item) => /^for Statement Period:/.test(item.str.trim()));
  const [billingStart, billingEnd] = billingPeriodItem ? parseBillingPeriodLine(billingPeriodItem.str.trim()) : [null, null];

  const statementInfo: StatementInfo = {
    // No distinct statement/reference number distinguishable from the GST invoice's own "STMT No." on this
    // card product's layout in a way that's meaningfully different from provenance already captured elsewhere.
    statementNumber: unavailable<string>(),
    statementDate,
    billingPeriodStart: billingStart ? field(billingStart, 0.95, "pattern_match") : unavailable<Date>(),
    billingPeriodEnd: billingEnd ? field(billingEnd, 0.95, "pattern_match") : unavailable<Date>(),
    paymentDueDate: dueDate,
  };

  const cardInfo: CardInfo = {
    bankName,
    cardName,
    cardLast4,
    network: unavailable<string>(),
  };

  const previousBalance = amountField(rows, "Previous Balance", 0.93);
  const totalOutstanding = amountField(rows, "Total Outstanding", 0.95);
  const totalAmountDue = amountField(rows, "*Total Amount Due", 0.98);
  const minimumDue = amountField(rows, "**Minimum Amount Due", 0.97);
  const creditLimit = amountField(rows, "Credit Limit", 0.96);
  const availableCreditLimit = amountField(rows, "Available Credit Limit", 0.95);

  const billingSummary: BillingSummary = {
    openingBalance: previousBalance,
    // "Total Outstanding" (includes not-yet-due Flexipay/Installment balances) is the true closing-balance
    // analog on this card product — distinct from "*Total Amount Due" (just this cycle's due amount), see
    // module comment.
    closingBalance: totalOutstanding,
    minimumDue,
    totalDue: totalAmountDue,
    creditLimit,
    availableCredit: availableCreditLimit,
    // Not found on this card product's statement pages — genuinely absent, not a parsing gap (see module comment).
    rewardPointsEarned: unavailable<number>(),
    cashback: unavailable<number>(),
    interestCharged: unavailable<number>(),
    gst: unavailable<number>(),
    lateFee: unavailable<number>(),
  };

  return { statementInfo, cardInfo, billingSummary };
}

// Re-exported so the transaction extractor doesn't need its own separate import of the same row-grouping utility.
export { groupPagesIntoRows, valueRightOfLabel };
