/**
 * Local real-statement validation helpers (used by `scripts/validate-real-statement.mjs`; never imported by any
 * Cloud Function entry point). Pure functions over `PdfPageText[]` — no Firestore, no Storage, no network, so
 * validating a real statement can never import a transaction or touch production data.
 *
 * Three jobs:
 *  1. `summarizeExtraction` — what the parser would produce for these pages, with ambiguity counts.
 *  2. `compareWithExpected` — diff that against figures the owner read off the source PDF.
 *  3. `redactPages` — a layout-preserving, identifier-free snapshot safe to keep as a regression fixture.
 */

import type { PdfPageText } from "../pdf/pdf-document-provider";
import { BANK_STATEMENT_EXTRACTORS, type BankStatementExtractor } from "../pipeline/multi-bank-credit-card-statement-pipeline";
import { hasUsableTextLayer, parseAmountToken, parseDatePrefix } from "../parsing/generic/layout-analyzer";

export interface RowSummary {
  page: number;
  date: string; // YYYY-MM-DD
  amount: number;
  direction: "debit" | "credit";
  confidence: number;
  /** Warning codes other than the blanket "generic_fallback_extraction". */
  flags: string[];
  /** Why the direction was chosen (column / marker / sign / keyword / none / conflict), when the generic tier says. */
  directionBasis: string | null;
}

export interface ValidationSummary {
  pageCount: number;
  usableTextLayer: boolean;
  extractor: string | null;
  rowCount: number;
  debitCount: number;
  creditCount: number;
  totalDebits: number;
  totalCredits: number;
  flaggedRowCount: number;
  lowConfidenceRowCount: number;
  directionBasisCounts: Record<string, number>;
  flagCounts: Record<string, number>;
  rows: RowSummary[];
}

/** An amount worth keeping in a fixture: has printed decimals, or is a short integer. A long bare digit run (card / account / phone / reference number) parses as an "amount" too and must NOT be mistaken for one. */
function isSafeAmountText(text: string): boolean {
  const parsed = parseAmountToken(text);
  return parsed != null && (parsed.hasDecimals || text.replace(/D/g, "").length <= 8);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function summarizeExtraction(pages: PdfPageText[], extractors: BankStatementExtractor[] = BANK_STATEMENT_EXTRACTORS): ValidationSummary {
  const usableTextLayer = hasUsableTextLayer(pages);
  const empty: ValidationSummary = {
    pageCount: pages.length,
    usableTextLayer,
    extractor: null,
    rowCount: 0,
    debitCount: 0,
    creditCount: 0,
    totalDebits: 0,
    totalCredits: 0,
    flaggedRowCount: 0,
    lowConfidenceRowCount: 0,
    directionBasisCounts: {},
    flagCounts: {},
    rows: [],
  };
  if (!usableTextLayer) return empty;

  const extractor = extractors.find((candidate) => candidate.isMatch(pages));
  if (!extractor) return empty;
  const result = extractor.extract(pages, {});

  const rows: RowSummary[] = [];
  for (const t of result.transactions) {
    // A row with no readable date is reported as a flag, never given an invented date.
    const date = t.date.value ? isoDay(t.date.value) : "unknown";
    const flags = t.warnings.map((w) => w.code).filter((code) => code !== "generic_fallback_extraction");
    if (!t.date.value) flags.push("date_missing");
    rows.push({
      page: t.sourcePage,
      date,
      amount: t.amount.value,
      direction: t.direction.value,
      confidence: round2(t.confidence),
      flags,
      directionBasis: t.direction.extractionMethod?.startsWith("direction:") ? t.direction.extractionMethod.slice("direction:".length) : null,
    });
  }

  const directionBasisCounts: Record<string, number> = {};
  const flagCounts: Record<string, number> = {};
  for (const r of rows) {
    if (r.directionBasis) directionBasisCounts[r.directionBasis] = (directionBasisCounts[r.directionBasis] ?? 0) + 1;
    for (const f of r.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  }

  return {
    pageCount: pages.length,
    usableTextLayer,
    extractor: extractor.bankId,
    rowCount: rows.length,
    debitCount: rows.filter((r) => r.direction === "debit").length,
    creditCount: rows.filter((r) => r.direction === "credit").length,
    totalDebits: round2(rows.filter((r) => r.direction === "debit").reduce((s, r) => s + r.amount, 0)),
    totalCredits: round2(rows.filter((r) => r.direction === "credit").reduce((s, r) => s + r.amount, 0)),
    flaggedRowCount: rows.filter((r) => r.flags.length > 0).length,
    lowConfidenceRowCount: rows.filter((r) => r.confidence < 0.5).length,
    directionBasisCounts,
    flagCounts,
    rows,
  };
}

// ───────────────────────────── comparison against figures read off the PDF ─────────────────────────────

export interface ExpectedStatement {
  /** Rows the owner read off the source PDF — date, amount, direction only (no merchant text needed). */
  rows?: { date: string; amount: number; direction: "debit" | "credit" }[];
  rowCount?: number;
  /** The statement's own printed totals (e.g. "Purchases/Debit", "Payments/Credits received"). */
  totalDebits?: number;
  totalCredits?: number;
}

export interface ComparisonReport {
  pass: boolean;
  problems: string[];
  missing: { date: string; amount: number; direction: string }[];
  extra: { date: string; amount: number; direction: string; flags: string[] }[];
  directionMismatches: { date: string; amount: number; expected: string; actual: string; basis: string | null }[];
  /** Mismatches the parser already flagged for manual review — still a failure of extraction, but not a silent one. */
  flaggedAmongProblems: number;
}

const keyOf = (date: string, amount: number) => `${date}|${amount.toFixed(2)}`;

export function compareWithExpected(summary: ValidationSummary, expected: ExpectedStatement): ComparisonReport {
  const problems: string[] = [];
  const missing: ComparisonReport["missing"] = [];
  const extra: ComparisonReport["extra"] = [];
  const directionMismatches: ComparisonReport["directionMismatches"] = [];

  if (expected.rowCount != null && expected.rowCount !== summary.rowCount) {
    problems.push(`row count: expected ${expected.rowCount}, extracted ${summary.rowCount}`);
  }
  if (expected.totalDebits != null && Math.abs(expected.totalDebits - summary.totalDebits) > 0.005) {
    problems.push(`total debits: expected ${expected.totalDebits.toFixed(2)}, extracted ${summary.totalDebits.toFixed(2)}`);
  }
  if (expected.totalCredits != null && Math.abs(expected.totalCredits - summary.totalCredits) > 0.005) {
    problems.push(`total credits: expected ${expected.totalCredits.toFixed(2)}, extracted ${summary.totalCredits.toFixed(2)}`);
  }

  if (expected.rows) {
    const pool = new Map<string, RowSummary[]>();
    for (const r of summary.rows) {
      const k = keyOf(r.date, r.amount);
      pool.set(k, [...(pool.get(k) ?? []), r]);
    }
    for (const exp of expected.rows) {
      const k = keyOf(exp.date, exp.amount);
      const candidates = pool.get(k) ?? [];
      // Prefer an extracted row whose direction agrees, so a credit and a debit of the same amount on one day pair correctly.
      const idx = candidates.findIndex((c) => c.direction === exp.direction);
      const hit = idx >= 0 ? candidates.splice(idx, 1)[0]! : candidates.shift();
      if (!hit) {
        missing.push({ date: exp.date, amount: exp.amount, direction: exp.direction });
      } else if (hit.direction !== exp.direction) {
        directionMismatches.push({ date: exp.date, amount: exp.amount, expected: exp.direction, actual: hit.direction, basis: hit.directionBasis });
      }
    }
    for (const leftovers of pool.values()) for (const r of leftovers) extra.push({ date: r.date, amount: r.amount, direction: r.direction, flags: r.flags });

    if (missing.length > 0) problems.push(`${missing.length} expected row(s) not extracted`);
    if (extra.length > 0) problems.push(`${extra.length} extracted row(s) not in the source`);
    if (directionMismatches.length > 0) problems.push(`${directionMismatches.length} row(s) with the wrong debit/credit direction`);
  }

  const flaggedAmongProblems = extra.filter((e) => e.flags.length > 0).length + directionMismatches.filter((m) => m.basis === "none" || m.basis === "conflict" || m.basis === "keyword" || m.basis === "sign").length;
  return { pass: problems.length === 0, problems, missing, extra, directionMismatches, flaggedAmongProblems };
}

// ───────────────────────────── redaction ─────────────────────────────

export interface RedactedPage {
  pageNumber: number;
  items: { str: string; x: number; y: number; width: number; height: number }[];
}

/** Words that are statement furniture, never identifying — kept verbatim so headers, summary rows and direction hints still parse. */
const STRUCTURAL_WORDS = new Set(
  `date dt transaction txn trans posting post purchase value tran of description particulars narration details merchant remarks beneficiary
   debit debits dr credit credits cr amount amt rs inr type indicator balance opening closing previous total due minimum min payable payment payments
   received thank you limit available cash statement period summary billing cycle grand sub brought carried forward reward points point earned
   page continued next on from and the refund reversal reversed cashback waiver waived emi fee fees gst igst cgst sgst interest finance charges
   charge late tax purchases domestic international instructions mode modes options account card no number ref reference`
    .split(/\s+/)
    .filter(Boolean),
);

function isStructuralText(str: string): boolean {
  const words = str.toLowerCase().split(/[^a-z0-9₹]+/).filter(Boolean);
  if (words.length === 0) return true; // pure punctuation / currency glyphs
  return words.every((w) => STRUCTURAL_WORDS.has(w));
}

/**
 * Layout-preserving redaction: every item keeps its exact x/y/width/height, but any text that is not a date, an
 * amount, a Dr/Cr marker or known statement furniture becomes `MERCHANT n` (names, addresses, card/account numbers,
 * emails, phone numbers, merchants, references all fall in that bucket). Dates and amounts are kept — they are
 * what the regression needs — so review the output before committing it (see tests/fixtures/real-statements/README.md).
 */
export function redactPages(pages: PdfPageText[]): RedactedPage[] {
  let counter = 0;
  const placeholder = () => `MERCHANT ${++counter}`;
  return pages.map((page) => ({
    pageNumber: page.pageNumber,
    items: page.items.map((item) => {
      const str = item.str;
      const trimmed = str.trim();
      let out: string;
      const date = trimmed.length > 0 ? parseDatePrefix(trimmed) : null;
      if (trimmed.length === 0) out = str;
      else if (isSafeAmountText(trimmed) || /^(DR|CR)\.?$/i.test(trimmed)) out = str;
      else if (date) out = date.rest.length === 0 ? str : `${trimmed.slice(0, trimmed.length - date.rest.length).trim()} ${placeholder()}`;
      else if (isStructuralText(trimmed)) out = str;
      else out = placeholder();
      return { str: out, x: item.x, y: item.y, width: item.width, height: item.height };
    }),
  }));
}

/** True when the redacted snapshot parses to exactly the same rows (date, amount, direction) as the original — i.e. redaction removed identifiers without changing what the parser sees. */
export function redactionPreservesParse(original: PdfPageText[], redacted: RedactedPage[]): { same: boolean; originalRows: number; redactedRows: number } {
  const asPages: PdfPageText[] = redacted.map((p) => ({ pageNumber: p.pageNumber, text: p.items.map((i) => i.str).join(" "), items: p.items }));
  const a = summarizeExtraction(original);
  const b = summarizeExtraction(asPages);
  const sig = (s: ValidationSummary) => s.rows.map((r) => `${r.date}|${r.amount.toFixed(2)}|${r.direction}`).join(";");
  return { same: a.rowCount === b.rowCount && sig(a) === sig(b), originalRows: a.rowCount, redactedRows: b.rowCount };
}

/** Rough PII scan of a redacted snapshot: strings that still look like emails, long digit runs or masked card numbers. */
export function findResidualIdentifiers(redacted: RedactedPage[]): string[] {
  const hits: string[] = [];
  for (const page of redacted) {
    for (const item of page.items) {
      const s = item.str;
      if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s)) hits.push(`page ${page.pageNumber}: email-like text`);
      else if (/\d{9,}/.test(s.replace(/[,\s.]/g, "")) && !isSafeAmountText(s.trim())) hits.push(`page ${page.pageNumber}: long digit run`);
      else if (/[xX*]{2,}\s*\d{2,4}/.test(s)) hits.push(`page ${page.pageNumber}: masked card/account number`);
    }
  }
  return hits;
}
