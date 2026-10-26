/**
 * Universal Layout Analyzer — bank-independent transaction-table reader for
 * the generic fallback tier (`generic-statement-extractor.ts`). Pure and
 * deterministic: input is `PdfPageText[]` (pdf.js text items with page
 * coordinates), output is plain candidate transactions plus the rows it
 * deliberately skipped. No network, no OCR, no AI, no cost.
 *
 * Two modes, picked document-wide:
 *  - "table": a header row (Date | Description | Debit | Credit / Amount /
 *    Dr-Cr ...) is detected dynamically from its labels; every later row is
 *    assigned to columns by x-geometry. The header carries across page breaks
 *    and re-arms on repeated headers.
 *  - "token_shape": no recognizable header anywhere — falls back to the
 *    original "a row with a date token and a decimal amount token" heuristic,
 *    but with the same exclusion, continuation and ambiguity rules.
 *
 * Nothing here ever invents a value: a row whose amount, date or direction
 * cannot be read is either skipped (recorded in `skipped`) or carries an
 * explicit warning and a low field confidence. Direction is only "certain"
 * when a column or an explicit Dr/Cr marker says so.
 */

import type { PdfPageText, PdfPageTextItem } from "../../pdf/pdf-document-provider";
import { groupPagesIntoRows, type LayoutRow } from "../page-layout";

export type AnalyzedDirection = "debit" | "credit";
export type DirectionBasis = "column" | "marker" | "sign" | "keyword" | "none" | "conflict";

export interface AnalyzerWarning {
  code: string;
  message: string;
}

export interface AnalyzedTransaction {
  page: number;
  date: Date;
  dateItem: PdfPageTextItem;
  dateOrderAssumed: boolean;
  dateInDateColumn: boolean;
  description: string;
  amount: number;
  amountItem: PdfPageTextItem;
  amountBasis: "debit_column" | "credit_column" | "amount_column" | "token_shape" | "ambiguous";
  direction: AnalyzedDirection;
  directionBasis: DirectionBasis;
  /** ISO code only when the amount text printed a currency symbol/code. */
  explicitCurrency: string | null;
  mode: "table" | "token_shape";
  rawText: string;
  warnings: AnalyzerWarning[];
  /** y of the last physical line merged into this row, for continuation gap checks. */
  lastY: number;
  descriptionX: number;
}

export interface SkippedRow {
  page: number;
  text: string;
  reason: string;
}

export interface LayoutAnalysis {
  mode: "table" | "token_shape" | "none";
  transactions: AnalyzedTransaction[];
  skipped: SkippedRow[];
  tablesDetected: number;
  documentCurrency: string | null;
}

/** Minimum rows before a mode is believed — one stray dated row in prose is not a table. */
export const MIN_TRANSACTION_ROWS = 3;

// ───────────────────────────── dates ─────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const TIME_TAIL = String.raw`(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)?`;
const DATE_NAMED = new RegExp(String.raw`^(\d{1,2})[\s-]+([A-Za-z]{3,9})[,.]?[\s-]*(\d{4}|\d{2})(?!\d)` + TIME_TAIL);
const DATE_NUMERIC = new RegExp(String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)` + TIME_TAIL);
const DATE_ISO = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})(?!\d)` + TIME_TAIL);

export type DateOrder = "dmy" | "mdy";

function buildDate(year: number, month: number, day: number): Date | null {
  if (year < 1990 || year > 2100 || month < 0 || month > 11 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

function fullYear(raw: string): number {
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

export interface ParsedDate {
  date: Date;
  rest: string;
  /** True when a numeric DD/MM vs MM/DD reading was a coin flip resolved by the day-first default. */
  orderAmbiguous: boolean;
}

/** Reads a date at the START of `text`; anything after it (time, description) comes back as `rest`. */
export function parseDatePrefix(text: string, order: DateOrder = "dmy"): ParsedDate | null {
  const str = text.trim();
  let m = DATE_NAMED.exec(str);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (month === undefined) return null;
    const date = buildDate(fullYear(m[3]!), month, Number(m[1]));
    return date ? { date, rest: str.slice(m[0].length).trim(), orderAmbiguous: false } : null;
  }
  m = DATE_ISO.exec(str);
  if (m) {
    const date = buildDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return date ? { date, rest: str.slice(m[0].length).trim(), orderAmbiguous: false } : null;
  }
  m = DATE_NUMERIC.exec(str);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [day, month] = order === "dmy" ? [a, b] : [b, a];
    const date = buildDate(fullYear(m[3]!), month - 1, day);
    return date ? { date, rest: str.slice(m[0].length).trim(), orderAmbiguous: a <= 12 && b <= 12 && a !== b } : null;
  }
  return null;
}

/** Looks for a numeric date with a part > 12 to learn whether the document is day-first or month-first. */
function inferDateOrder(rows: LayoutRow[]): { order: DateOrder; evidence: boolean } {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const row of rows) {
    for (const item of row.items) {
      const m = DATE_NUMERIC.exec(item.str.trim());
      if (!m) continue;
      if (Number(m[1]) > 12) dayFirst++;
      else if (Number(m[2]) > 12) monthFirst++;
    }
  }
  if (monthFirst > dayFirst) return { order: "mdy", evidence: true };
  return { order: "dmy", evidence: dayFirst > 0 };
}

// ───────────────────────────── amounts ─────────────────────────────

const CURRENCY_PREFIX = /^(₹|Rs\.?|INR|USD|\$|EUR|€|GBP|£)\s*/i;
const AMOUNT_CORE = /^(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?$/;
const DIRECTION_MARKER = /^(DR|CR)\.?$/i;

function currencyCode(raw: string): string {
  const u = raw.replace(/\.$/, "").toUpperCase();
  if (u === "₹" || u === "RS" || u === "INR") return "INR";
  if (u === "$" || u === "USD") return "USD";
  if (u === "€" || u === "EUR") return "EUR";
  return "GBP";
}

export interface ParsedAmount {
  value: number;
  negative: boolean;
  /** Dr/Cr printed inside the same token, e.g. "1,234.56 Cr". */
  suffixMarker: "DR" | "CR" | null;
  currency: string | null;
  hasDecimals: boolean;
}

/** Parses an Indian-format amount token (1,23,456.78 / ₹500 / (200.00) / 99.00 CR / -45.50). Null when it is not purely an amount. */
export function parseAmountToken(raw: string): ParsedAmount | null {
  let s = raw.trim();
  if (s.length === 0) return null;
  let currency: string | null = null;
  let negative = false;
  let suffixMarker: "DR" | "CR" | null = null;

  const suffix = /\s*(CR|DR)\.?$/i.exec(s);
  if (suffix) {
    suffixMarker = suffix[1]!.toUpperCase() as "DR" | "CR";
    s = s.slice(0, suffix.index).trim();
  }
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-") || s.startsWith("−")) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  const cur = CURRENCY_PREFIX.exec(s);
  if (cur) {
    currency = currencyCode(cur[1]!);
    s = s.slice(cur[0].length).trim();
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }
  if (!AMOUNT_CORE.test(s)) return null;
  const value = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return { value, negative, suffixMarker, currency, hasDecimals: s.includes(".") };
}

// ───────────────────────────── classification ─────────────────────────────

/** Rows that are statement summary/metadata even when they carry a date or an amount — never transactions. */
const SUMMARY_PATTERN = new RegExp(
  String.raw`\b(opening balance|closing balance|previous balance|total (amount )?(payable|due)|minimum (amount )?(payment )?due|min\.? (amount )?due|total (debits?|credits?|purchases?|payments?|dues?|charges)|credit limit|available (credit|cash)( limit)?|statement (date|period|summary)|payment due date|due date|billing (period|cycle)|grand total|sub ?total|brought forward|carried forward|reward points?( balance| summary| earned| summary)?|account summary|payment (instructions?|modes?|options?))\b`,
  "i",
);
/** Page furniture — never description text and never a row; also breaks continuation merging. */
const FOOTER_PATTERN = /\b(page\s*\d+\s*(of|\/)\s*\d+|continued on|continued from|customer care|registered office|computer generated|www\.|https?:\/\/|toll[- ]?free)\b/i;
const CREDIT_KEYWORDS = /\b(payment received|payment - thank|payment thank|credit|reversal|reversed|refund|cashback|cash back|waiver|waived)\b/i;

type ColumnKind = "date" | "desc" | "debit" | "credit" | "amount" | "drcr" | "ignore";

function classifyHeaderCell(text: string): ColumnKind | null {
  const t = text.toLowerCase().replace(/[().:]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length === 0) return null;
  if (/^(dr ?\/ ?cr|cr ?\/ ?dr|dr or cr|cr or dr|type|indicator|debit ?\/ ?credit|credit ?\/ ?debit)$/.test(t)) return "drcr";
  if (/balance|points?|reward|forex|foreign|exchange|currency|^ref\b|reference|cheque|chq|\bgst\b/.test(t)) return "ignore";
  if (/^(transaction |txn |trans |posting |post |purchase |value |tran )?date( of (transaction|purchase|txn))?$|^dt$/.test(t)) return "date";
  if (/^(debit|debits|dr|withdrawals?|spent|debit amount|amount debited|purchases?|charges)( amount| amt)?( rs| inr)?$/.test(t)) return "debit";
  if (/^(credit|credits|cr|deposits?|payments?|credit amount|amount credited|payments? ?\/ ?credits?|payments? (received|credits?))( amount| amt)?( rs| inr)?$/.test(t)) return "credit";
  if (/^(amount|amt|rs|inr|₹)( |$)|^amount\b|\bamount\b/.test(t)) return "amount";
  if (/description|particulars|narration|details|merchant|remarks|beneficiary|transaction$/.test(t)) return "desc";
  return null;
}

interface HeaderColumn {
  kind: ColumnKind;
  left: number;
  right: number;
  center: number;
}

interface TableHeader {
  columns: HeaderColumn[];
  dateColumn: HeaderColumn;
  hasDebit: boolean;
  hasCredit: boolean;
  hasAmount: boolean;
}

/** Merges header words that are visually one label ("Transaction" + "Date"), then classifies each label. */
function detectHeader(row: LayoutRow): TableHeader | null {
  const items = row.items.filter((i) => i.str.trim().length > 0);
  if (items.length < 3) return null;
  // A data row (one that starts with a real date) is never a header.
  if (items.some((i) => parseDatePrefix(i.str) != null)) return null;

  const cells: { text: string; left: number; right: number }[] = [];
  for (const item of items) {
    const last = cells[cells.length - 1];
    if (last && item.x - last.right < 8) {
      last.text += ` ${item.str.trim()}`;
      last.right = item.x + item.width;
    } else {
      cells.push({ text: item.str.trim(), left: item.x, right: item.x + item.width });
    }
  }

  const columns: HeaderColumn[] = [];
  for (const cell of cells) {
    const kind = classifyHeaderCell(cell.text);
    if (kind) columns.push({ kind, left: cell.left, right: cell.right, center: (cell.left + cell.right) / 2 });
  }
  const dateColumn = columns.find((c) => c.kind === "date");
  const hasDebit = columns.some((c) => c.kind === "debit");
  const hasCredit = columns.some((c) => c.kind === "credit");
  const hasAmount = columns.some((c) => c.kind === "amount");
  if (!dateColumn || !(hasAmount || hasDebit || hasCredit)) return null;
  return { columns, dateColumn, hasDebit, hasCredit, hasAmount };
}

function intervalDistance(item: PdfPageTextItem, column: HeaderColumn): number {
  const left = item.x;
  const right = item.x + item.width;
  if (right < column.left) return column.left - right;
  if (left > column.right) return left - column.right;
  return 0;
}

const MAX_COLUMN_DISTANCE = 40;
const MAX_CONTINUATION_GAP = 22;

function nearestColumn(item: PdfPageTextItem, header: TableHeader): HeaderColumn | null {
  let best: HeaderColumn | null = null;
  let bestDistance = Infinity;
  const itemCenter = item.x + item.width / 2;
  for (const column of header.columns) {
    const distance = intervalDistance(item, column);
    if (distance > MAX_COLUMN_DISTANCE) continue;
    if (
      distance < bestDistance ||
      (distance === bestDistance && best && Math.abs(itemCenter - column.center) < Math.abs(itemCenter - best.center))
    ) {
      best = column;
      bestDistance = distance;
    }
  }
  return best;
}

function rowText(items: PdfPageTextItem[]): string {
  return items.map((i) => i.str.trim()).filter((s) => s.length > 0).join(" ");
}

function joinDescription(parts: string[]): string {
  return parts.map((p) => p.trim()).filter((p) => p.length > 0).join(" ").replace(/\s+/g, " ").trim();
}

// ───────────────────────────── row builders ─────────────────────────────

interface MoneyItem {
  item: PdfPageTextItem;
  parsed: ParsedAmount;
  kind: "debit" | "credit" | "amount";
}

function directionFromMarkers(markerItems: PdfPageTextItem[], money: ParsedAmount): "debit" | "credit" | null {
  if (money.suffixMarker) return money.suffixMarker === "CR" ? "credit" : "debit";
  const markerItem = markerItems.find((i) => DIRECTION_MARKER.test(i.str.trim()));
  if (markerItem) return /^CR/i.test(markerItem.str.trim()) ? "credit" : "debit";
  return null;
}

function buildTableRow(
  row: LayoutRow,
  header: TableHeader,
  order: { order: DateOrder; evidence: boolean },
): { txn: AnalyzedTransaction } | { skip: string } {
  const items = row.items.filter((i) => i.str.trim().length > 0);

  // Date: the leftmost item that parses as a date AND sits in/near the date column.
  let dateItem: PdfPageTextItem | null = null;
  let parsedDate: ParsedDate | null = null;
  for (const item of items) {
    const parsed = parseDatePrefix(item.str, order.order);
    if (parsed && intervalDistance(item, header.dateColumn) <= MAX_COLUMN_DISTANCE) {
      dateItem = item;
      parsedDate = parsed;
      break;
    }
  }
  if (!dateItem || !parsedDate) return { skip: "no_date_in_date_column" };

  const money: MoneyItem[] = [];
  const drcrItems: PdfPageTextItem[] = [];
  const descParts: string[] = [];
  let descriptionX = Infinity;
  if (parsedDate.rest) descParts.push(parsedDate.rest);

  for (const item of items) {
    if (item === dateItem) continue;
    const text = item.str.trim();
    const column = nearestColumn(item, header);
    if (DIRECTION_MARKER.test(text)) {
      drcrItems.push(item);
      continue;
    }
    const parsed = parseAmountToken(text);
    if (parsed && column && (column.kind === "debit" || column.kind === "credit" || column.kind === "amount")) {
      money.push({ item, parsed, kind: column.kind });
      continue;
    }
    if (parsed && column && (column.kind === "ignore" || column.kind === "drcr")) {
      if (column.kind === "drcr") drcrItems.push(item);
      continue; // balance / points / reference value — not part of the transaction amount
    }
    if (column?.kind === "drcr") {
      drcrItems.push(item);
      continue;
    }
    if (column?.kind === "ignore" && !parsed) continue;
    descParts.push(text);
    descriptionX = Math.min(descriptionX, item.x);
  }

  const warnings: AnalyzerWarning[] = [];
  // Drop printed zeros ("0.00" in the unused Debit/Credit cell) — they are layout fillers, not amounts.
  const nonZero = money.filter((m) => m.parsed.value !== 0);
  if (nonZero.length === 0) return { skip: money.length > 0 ? "zero_amount" : "no_amount" };

  const debits = nonZero.filter((m) => m.kind === "debit");
  const credits = nonZero.filter((m) => m.kind === "credit");

  let chosen: MoneyItem;
  let amountBasis: AnalyzedTransaction["amountBasis"];
  let direction: AnalyzedDirection;
  let basis: DirectionBasis;

  if (nonZero.length > 1) {
    // Two non-zero money cells in one row (debit+credit both filled, or several amount cells): we cannot know which is the posted amount.
    chosen = nonZero[0]!;
    amountBasis = "ambiguous";
    direction = chosen.kind === "credit" ? "credit" : "debit";
    basis = "conflict";
    warnings.push({ code: "multiple_amounts_in_row", message: `This row has ${nonZero.length} non-zero amounts; the amount and direction could not be determined reliably.` });
  } else {
    chosen = nonZero[0]!;
    if (debits.length === 1) {
      amountBasis = "debit_column";
      direction = "debit";
      basis = "column";
    } else if (credits.length === 1) {
      amountBasis = "credit_column";
      direction = "credit";
      basis = "column";
    } else {
      amountBasis = "amount_column";
      const marker = directionFromMarkers(drcrItems, chosen.parsed);
      const description = joinDescription(descParts);
      if (marker) {
        direction = marker;
        basis = "marker";
      } else if (chosen.parsed.negative) {
        direction = "credit";
        basis = "sign";
        warnings.push({ code: "direction_from_sign", message: "Direction inferred from a negative amount; confirm whether this is a credit/refund." });
      } else if (CREDIT_KEYWORDS.test(description)) {
        direction = "credit";
        basis = "keyword";
        warnings.push({ code: "direction_from_description", message: "Direction inferred only from the description wording; please confirm." });
      } else {
        direction = "debit";
        basis = "none";
        warnings.push({ code: "direction_not_stated", message: "The statement does not state whether this row is a debit or a credit; defaulted to debit — please confirm." });
      }
    }
    // An explicit Dr/Cr marker that contradicts the column is a conflict, never silently resolved.
    if (basis === "column") {
      const marker = directionFromMarkers(drcrItems, chosen.parsed);
      if (marker && marker !== direction) {
        basis = "conflict";
        warnings.push({ code: "direction_conflict", message: "The column and the Dr/Cr marker disagree on direction." });
      }
    }
  }

  const description = joinDescription(descParts);
  if (description.length === 0) warnings.push({ code: "missing_description", message: "No merchant/description text was found on this row." });
  if (order.evidence === false && parsedDate.orderAmbiguous) {
    warnings.push({ code: "date_order_assumed", message: "Day/month order could not be confirmed from the statement; read as day-first (DD/MM)." });
  }

  return {
    txn: {
      page: row.page,
      date: parsedDate.date,
      dateItem,
      dateOrderAssumed: order.evidence === false && parsedDate.orderAmbiguous,
      dateInDateColumn: true,
      description,
      amount: chosen.parsed.value,
      amountItem: chosen.item,
      amountBasis,
      direction,
      directionBasis: basis,
      explicitCurrency: chosen.parsed.currency,
      mode: "table",
      rawText: rowText(items),
      warnings,
      lastY: row.y,
      descriptionX: Number.isFinite(descriptionX) ? descriptionX : dateItem.x + dateItem.width,
    },
  };
}

function buildTokenRow(row: LayoutRow, order: { order: DateOrder; evidence: boolean }): { txn: AnalyzedTransaction } | { skip: string } {
  const items = row.items.filter((i) => i.str.trim().length > 0);
  if (items.length < 2) return { skip: "too_few_items" };

  let dateItem: PdfPageTextItem | null = null;
  let parsedDate: ParsedDate | null = null;
  for (const item of items) {
    const parsed = parseDatePrefix(item.str, order.order);
    if (parsed) {
      dateItem = item;
      parsedDate = parsed;
      break;
    }
  }
  if (!dateItem || !parsedDate) return { skip: "no_date" };

  // Token-shape mode has no column evidence, so it requires printed decimals — bare integers are far too often reference numbers.
  const amounts: { item: PdfPageTextItem; parsed: ParsedAmount }[] = [];
  const markers: PdfPageTextItem[] = [];
  const descParts: string[] = parsedDate.rest ? [parsedDate.rest] : [];
  let descriptionX = Infinity;
  for (const item of items) {
    if (item === dateItem) continue;
    const text = item.str.trim();
    if (DIRECTION_MARKER.test(text)) {
      markers.push(item);
      continue;
    }
    const parsed = parseAmountToken(text);
    if (parsed && parsed.hasDecimals) {
      amounts.push({ item, parsed });
      continue;
    }
    descParts.push(text);
    descriptionX = Math.min(descriptionX, item.x);
  }

  const nonZero = amounts.filter((a) => a.parsed.value !== 0);
  if (nonZero.length === 0) return { skip: amounts.length > 0 ? "zero_amount" : "no_amount" };

  const warnings: AnalyzerWarning[] = [];
  const chosen = nonZero[nonZero.length - 1]!;
  let direction: AnalyzedDirection;
  let basis: DirectionBasis;
  let amountBasis: AnalyzedTransaction["amountBasis"] = "token_shape";
  const description = joinDescription(descParts);

  if (nonZero.length > 1) {
    amountBasis = "ambiguous";
    direction = "debit";
    basis = "conflict";
    warnings.push({ code: "multiple_amounts_in_row", message: `This row has ${nonZero.length} amounts (e.g. amount and balance); the last one was read — please confirm amount and direction.` });
  } else {
    const marker = directionFromMarkers(markers, chosen.parsed);
    if (marker) {
      direction = marker;
      basis = "marker";
    } else if (chosen.parsed.negative) {
      direction = "credit";
      basis = "sign";
      warnings.push({ code: "direction_from_sign", message: "Direction inferred from a negative amount; confirm whether this is a credit/refund." });
    } else if (CREDIT_KEYWORDS.test(description)) {
      direction = "credit";
      basis = "keyword";
      warnings.push({ code: "direction_from_description", message: "Direction inferred only from the description wording; please confirm." });
    } else {
      direction = "debit";
      basis = "none";
      warnings.push({ code: "direction_not_stated", message: "The statement does not state whether this row is a debit or a credit; defaulted to debit — please confirm." });
    }
  }
  if (description.length === 0) warnings.push({ code: "missing_description", message: "No merchant/description text was found on this row." });
  if (order.evidence === false && parsedDate.orderAmbiguous) {
    warnings.push({ code: "date_order_assumed", message: "Day/month order could not be confirmed from the statement; read as day-first (DD/MM)." });
  }

  return {
    txn: {
      page: row.page,
      date: parsedDate.date,
      dateItem,
      dateOrderAssumed: order.evidence === false && parsedDate.orderAmbiguous,
      dateInDateColumn: false,
      description,
      amount: chosen.parsed.value,
      amountItem: chosen.item,
      amountBasis,
      direction,
      directionBasis: basis,
      explicitCurrency: chosen.parsed.currency,
      mode: "token_shape",
      rawText: rowText(items),
      warnings,
      lastY: row.y,
      descriptionX: Number.isFinite(descriptionX) ? descriptionX : dateItem.x + dateItem.width,
    },
  };
}

/** Appends a wrapped description line to the previous transaction when it is a plain-text line just below it. */
function tryContinuation(prev: AnalyzedTransaction | null, row: LayoutRow): boolean {
  if (!prev || prev.page !== row.page) return false;
  const items = row.items.filter((i) => i.str.trim().length > 0);
  if (items.length === 0) return false;
  const gap = prev.lastY - row.y;
  if (gap <= 0 || gap > MAX_CONTINUATION_GAP) return false;
  if (items[0]!.x < prev.descriptionX - 6) return false; // starts left of the description column — not a wrap of it
  if (items.some((i) => parseAmountToken(i.str) != null && parseAmountToken(i.str)!.hasDecimals)) return false;
  const text = rowText(items);
  if (SUMMARY_PATTERN.test(text) || FOOTER_PATTERN.test(text)) return false;
  prev.description = joinDescription([prev.description, text]);
  prev.rawText = `${prev.rawText} ${text}`;
  prev.lastY = row.y;
  prev.warnings = prev.warnings.filter((w) => w.code !== "missing_description");
  return true;
}

/** True when the document has enough real text for layout analysis; false means "scanned / image-only". */
export function hasUsableTextLayer(pages: PdfPageText[]): boolean {
  if (pages.length === 0) return false;
  let alnum = 0;
  for (const page of pages) {
    for (const item of page.items) alnum += (item.str.match(/[A-Za-z0-9]/g) ?? []).length;
  }
  return alnum / pages.length >= 15;
}

function detectDocumentCurrency(pages: PdfPageText[]): string | null {
  for (const page of pages) {
    for (const item of page.items) {
      if (/₹|\bRs\.?(?=\s|\d|$)|\bINR\b/.test(item.str)) return "INR";
    }
  }
  return null;
}

function analyzeTable(rows: LayoutRow[], order: { order: DateOrder; evidence: boolean }) {
  const transactions: AnalyzedTransaction[] = [];
  const skipped: SkippedRow[] = [];
  let header: TableHeader | null = null;
  let inTable = false;
  let prev: AnalyzedTransaction | null = null;
  let tablesDetected = 0;
  let lastHeaderSignature = "";

  for (const row of rows) {
    const found = detectHeader(row);
    if (found) {
      header = found;
      inTable = true;
      prev = null;
      const signature = found.columns.map((c) => c.kind).join(",");
      if (signature !== lastHeaderSignature) tablesDetected++;
      lastHeaderSignature = signature;
      continue;
    }
    if (!header || !inTable) continue;

    const items = row.items.filter((i) => i.str.trim().length > 0);
    if (items.length === 0) continue;
    const text = rowText(items);

    if (FOOTER_PATTERN.test(text)) {
      prev = null;
      continue;
    }
    if (SUMMARY_PATTERN.test(text)) {
      skipped.push({ page: row.page, text, reason: "summary_row" });
      prev = null;
      // A summary line with no date ends the table; a dated one (e.g. "Opening balance") is just excluded.
      if (!items.some((i) => parseDatePrefix(i.str, order.order) != null)) inTable = false;
      continue;
    }

    const built = buildTableRow(row, header, order);
    if ("txn" in built) {
      transactions.push(built.txn);
      prev = built.txn;
      continue;
    }
    if (built.skip === "no_date_in_date_column") {
      if (tryContinuation(prev, row)) continue;
      const hasMoney = items.some((i) => {
        const p = parseAmountToken(i.str);
        return p != null && p.hasDecimals;
      });
      skipped.push({ page: row.page, text, reason: hasMoney ? "amount_without_date" : "undated_text" });
      prev = null;
      continue;
    }
    skipped.push({ page: row.page, text, reason: built.skip });
    prev = null;
  }
  return { transactions, skipped, tablesDetected };
}

function analyzeTokenShape(rows: LayoutRow[], order: { order: DateOrder; evidence: boolean }) {
  const transactions: AnalyzedTransaction[] = [];
  const skipped: SkippedRow[] = [];
  let prev: AnalyzedTransaction | null = null;

  for (const row of rows) {
    const items = row.items.filter((i) => i.str.trim().length > 0);
    if (items.length === 0) continue;
    const text = rowText(items);
    if (FOOTER_PATTERN.test(text)) {
      prev = null;
      continue;
    }
    if (SUMMARY_PATTERN.test(text)) {
      if (items.some((i) => parseDatePrefix(i.str, order.order) != null)) skipped.push({ page: row.page, text, reason: "summary_row" });
      prev = null;
      continue;
    }
    const built = buildTokenRow(row, order);
    if ("txn" in built) {
      transactions.push(built.txn);
      prev = built.txn;
      continue;
    }
    if (built.skip === "no_date" && tryContinuation(prev, row)) continue;
    if (built.skip !== "no_date" && built.skip !== "too_few_items") skipped.push({ page: row.page, text, reason: built.skip });
    prev = null;
  }
  return { transactions, skipped };
}

export function analyzeStatementLayout(pages: PdfPageText[]): LayoutAnalysis {
  const rows = groupPagesIntoRows(pages);
  const order = inferDateOrder(rows);
  const documentCurrency = detectDocumentCurrency(pages);

  const table = analyzeTable(rows, order);
  if (table.transactions.length >= MIN_TRANSACTION_ROWS) {
    return { mode: "table", transactions: table.transactions, skipped: table.skipped, tablesDetected: table.tablesDetected, documentCurrency };
  }
  const token = analyzeTokenShape(rows, order);
  if (token.transactions.length >= MIN_TRANSACTION_ROWS) {
    return { mode: "token_shape", transactions: token.transactions, skipped: token.skipped, tablesDetected: 0, documentCurrency };
  }
  return { mode: "none", transactions: [], skipped: [...table.skipped, ...token.skipped], tablesDetected: table.tablesDetected, documentCurrency };
}
