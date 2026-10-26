/**
 * Smart Capture Studio — local, dependency-free extraction of transaction
 * candidates from a statement table the user copied (or OCR'd) as text.
 *
 * Deliberately conservative: every row it returns is a *candidate* that must
 * be reviewed. Anything it can't read with certainty (no Cr/Dr marker on a
 * refund-looking line, several amounts on one line, a date with no year…) is
 * flagged with an `issue` instead of being silently guessed, and the review
 * screen refuses to continue while an included row still has one.
 *
 * Pure: no Firestore, no network, no React — the whole paste never leaves the
 * browser.
 */

export type CaptureDirection = "debit" | "credit";

export type CaptureRowKind = "purchase" | "refund" | "payment" | "interest" | "tax" | "fee" | "emi" | "cashback";

/** Needs an explicit user decision before the row may continue — never auto-resolved. */
export type CaptureIssueCode =
  | "no_amount"
  | "multiple_amounts"
  | "direction_unclear"
  | "no_date"
  | "year_assumed"
  | "amount_without_decimals"
  // OCR-only (see ocr-review.ts)
  | "ocr_unverified"
  | "low_confidence_date"
  | "low_confidence_amount"
  | "low_confidence_direction"
  | "direction_inferred"
  | "partial_line"
  | "merged_lines"
  | "decimal_missing"
  // Any source: same date + merchant + amount appears more than once (never auto-merged)
  | "possible_repeat";

export type CaptureField = "date" | "amount" | "direction";

/**
 * A column of the source table, identified by what its cell *contains* (a date, a money amount, a Cr/Dr marker, other
 * text) or by what its header says — never by where it sits. `debit`/`credit` exist only for headers that split them.
 */
export type SourceField = "date" | "merchant" | "amount" | "direction" | "debit" | "credit";

export interface CaptureIssue {
  code: CaptureIssueCode;
  message: string;
  /** Blocking issues stop the row from continuing until the user edits or confirms it. */
  blocking: boolean;
  /**
   * Strict issues belong to one field and are NOT cleared by the row-level "Values are correct" confirm — only by
   * editing that field or confirming that field individually (low-confidence OCR dates/amounts).
   */
  strict?: boolean;
  /** Cleared only by confirming the field — choosing or typing a value alone never clears it. */
  confirmOnly?: boolean;
  field?: CaptureField;
}

/** Where an OCR row came from on the (cropped) screenshot — only set for OCR captures. */
export interface CaptureOcrInfo {
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Lowest confidence among the row's date/amount/marker words (0–100). */
  minConfidence: number;
  /** Date/amount words read with low confidence, for highlighting. */
  lowConfidenceWords: string[];
}

export interface CaptureRow {
  id: string;
  /** 0-based line indices in the original paste this row was built from (inclusive). */
  lineStart: number;
  lineEnd: number;
  sourceText: string;
  date: Date | null;
  description: string;
  amount: number | null;
  direction: CaptureDirection | null;
  kind: CaptureRowKind;
  referenceNumber: string | null;
  /** Every amount-looking token found on the row, for the "which one?" picker. */
  amountCandidates: number[];
  /** Short cells from other narrow columns (country "IN", currency, points) kept out of the description. */
  extraColumns: string[];
  issues: CaptureIssue[];
  /** Informational notes (e.g. why the row starts excluded) — never blocking. */
  notes: string[];
  confidence: "high" | "medium" | "low";
  /** Suggested starting value for the include checkbox — EMI/payment rows start excluded. */
  suggestedInclude: boolean;
  /** Present only for rows extracted from a screenshot. */
  ocr?: CaptureOcrInfo;
  /**
   * Left-to-right order of the fields in this row's source line — only when every field was identified from its own
   * contents and the cells were separated unambiguously. Absent = order unknown. Display metadata only: no value is
   * ever derived from it.
   */
  sourceOrder?: SourceField[];
}

export type IgnoredReason = "summary" | "header" | "no_transaction";

export interface IgnoredLine {
  lineIndex: number;
  text: string;
  reason: IgnoredReason;
}

export interface CaptureParseResult {
  rows: CaptureRow[];
  ignored: IgnoredLine[];
  /** Original text split into lines — kept so review can show the source beside the rows. */
  lines: string[];
  /** Whether the paste itself establishes the "Cr marks credits" convention. */
  hasCreditMarkers: boolean;
  /** Column order named by the statement's own header line (last one wins), when its cells were separable. */
  headerOrder?: SourceField[];
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

// OCR often reads the letter O as a zero ("0ct", "N0v"). Those spellings are accepted, but the date is then marked
// `repaired` and must be confirmed by the user — never taken silently.
const MONTH_NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|[o0]ct|n[o0]v|dec)[a-z]*";

type ParsedDate = { y: number | null; mo: number; d: number; repaired?: boolean };

function month(raw: string): { mo: number; repaired: boolean } {
  const lower = raw.toLowerCase();
  return { mo: MONTHS[lower.replace(/0/g, "o")] ?? -1, repaired: lower.includes("0") };
}

// Order matters: the first pattern that matches at the start of the line wins.
const DATE_PATTERNS: { re: RegExp; parse: (m: RegExpMatchArray) => ParsedDate }[] = [
  // 2026-10-05
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})\b/, parse: (m) => ({ y: +m[1], mo: +m[2] - 1, d: +m[3] }) },
  // 05/10/2026, 05-10-26, 05.10.2026 — Indian statements are always day-first.
  { re: /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/, parse: (m) => ({ y: normalizeYear(+m[3]), mo: +m[2] - 1, d: +m[1] }) },
  // 05 Oct 2026, 05-Oct-26, 5 October, 2026 (and OCR's run-together "050ct26")
  { re: new RegExp(`^(\\d{1,2})[\\s.-]*${MONTH_NAME}[\\s.,-]*(\\d{4}|\\d{2})\\b`, "i"), parse: (m) => ({ y: normalizeYear(+m[3]), ...month(m[2]), d: +m[1] }) },
  // Oct 05, 2026
  { re: new RegExp(`^${MONTH_NAME}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i"), parse: (m) => ({ y: +m[3], ...month(m[1]), d: +m[2] }) },
  // 05 Oct (no year)
  { re: new RegExp(`^(\\d{1,2})[\\s-]*${MONTH_NAME}\\b`, "i"), parse: (m) => ({ y: null, ...month(m[2]), d: +m[1] }) },
];

function normalizeYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

interface DateMatch {
  y: number | null;
  mo: number;
  d: number;
  length: number;
  /** The month was spelled with a zero for the letter O (OCR) — needs confirmation. */
  repaired: boolean;
}

export function matchLeadingDate(text: string): DateMatch | null {
  // OCR may read the table's left border as "|" before the date.
  const lead = text.match(/^[|\s]*/)?.[0].length ?? 0;
  const body = text.slice(lead);
  for (const { re, parse } of DATE_PATTERNS) {
    const m = body.match(re);
    if (!m) continue;
    const parsed = parse(m);
    if (parsed.mo < 0 || parsed.mo > 11 || parsed.d < 1 || parsed.d > 31) continue;
    return { y: parsed.y, mo: parsed.mo, d: parsed.d, repaired: parsed.repaired ?? false, length: lead + m[0].length };
  }
  return null;
}

function buildDate(y: number, mo: number, d: number): Date | null {
  const date = new Date(y, mo, d, 12, 0, 0, 0);
  // Reject roll-overs like 31/02.
  return date.getMonth() === mo && date.getDate() === d ? date : null;
}

const SUMMARY_PATTERNS = [
  /\btotal\b/i,
  /\bopening balance\b/i,
  /\bclosing balance\b/i,
  /\bprevious (statement )?balance\b/i,
  /\b(available )?(credit|cash) limit\b/i,
  /\bavailable limit\b/i,
  /\bminimum (amount )?due\b/i,
  /\b(payment )?due date\b/i,
  /\btotal (amount )?due\b/i,
  /\bstatement (date|period)\b/i,
  /\breward points?\b/i,
  /\bpoints (earned|redeemed)\b/i,
  /\bbalance (b\/f|c\/f|brought|carried)\b/i,
  /\bpage \d+ of \d+\b/i,
];

const HEADER_HINTS = /\b(date|transaction details|description|narration|particulars|merchant)\b/i;
const HEADER_AMOUNT_HINTS = /\b(amount|debit|credit|withdrawal|deposit|dr|cr)\b/i;

function isSummaryLine(text: string): boolean {
  return SUMMARY_PATTERNS.some((re) => re.test(text));
}

function isHeaderLine(text: string): boolean {
  if (matchLeadingDate(text.trim())) return false;
  if (findAmounts(text).length > 0) return false;
  return HEADER_HINTS.test(text) && HEADER_AMOUNT_HINTS.test(text);
}

/** Header → which tab-separated column holds debits vs credits (bank-style two-column tables). */
interface ColumnLayout {
  debitIndex: number;
  creditIndex: number;
}

function columnLayoutFromHeader(text: string): ColumnLayout | null {
  if (!text.includes("\t")) return null;
  const cells = text.split("\t").map((c) => c.trim().toLowerCase());
  const debitIndex = cells.findIndex((c) => /^(debit|dr|withdrawals?|debit amount|amount \(dr\))/.test(c));
  const creditIndex = cells.findIndex((c) => /^(credit|cr|deposits?|credit amount|amount \(cr\))/.test(c));
  return debitIndex >= 0 && creditIndex >= 0 ? { debitIndex, creditIndex } : null;
}

interface AmountToken {
  value: number;
  index: number;
  length: number;
  marker: CaptureDirection | null;
  negative: boolean;
  hasDecimals: boolean;
  /**
   * A bare integer immediately followed by a C/D marker at the end of the line ("43461 D") — the shape of an amount
   * whose decimal point OCR dropped. Never trusted as-is: the row asks the user to pick 434.61 vs 43,461.00.
   */
  missingDecimal?: boolean;
}

// An amount is trusted only when it *looks* like money: two decimals, Indian/Western comma grouping, or an explicit
// currency/Cr/Dr marker. Bare integers (reward points, reference numbers, quantities) are not amounts.
// The Cr/Dr (or single-letter C/D) marker may sit in its own column — any run of spaces/tabs, or an OCR-read table
// rule "|", may separate it from the amount.
const AMOUNT_RE =
  /(?<![\w.,/])(\()?(-|\+)?\s?(?:(₹|rs\.?|inr)\s?)?(-)?((?:\d{1,3}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(\))?(?:[ \t|]*(cr|dr|c|d)\b)?(?![\w/])/gi;

export function findAmounts(text: string): AmountToken[] {
  const tokens: AmountToken[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [, openParen, sign, currency, innerMinus, digits, closeParen, markerRaw] = m;
    const hasDecimals = /\.\d{2}$/.test(digits);
    const hasGrouping = digits.includes(",");
    const marker = markerRaw ? (markerRaw.toLowerCase().startsWith("c") ? "credit" : "debit") : null;
    // Single-letter C/D markers only count right after a decimal amount, so "Sector 5 D" never reads as Dr.
    const strongMarker = marker != null && (markerRaw.length > 1 || hasDecimals);
    const atLineEnd = text.slice((m.index ?? 0) + m[0].length).trim() === "";
    if (!hasDecimals && !hasGrouping && !currency && !strongMarker) {
      if (marker != null && atLineEnd && /^\d{3,9}$/.test(digits)) {
        tokens.push({ value: Number(digits), index: m.index ?? 0, length: m[0].length, marker, negative: false, hasDecimals: false, missingDecimal: true });
      }
      continue;
    }
    // Long bare digit runs are card/reference numbers, even with decimals stripped.
    if (!hasGrouping && digits.replace(/\..*/, "").length > 9) continue;
    const value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value) || value === 0) continue;
    tokens.push({
      value,
      index: m.index ?? 0,
      length: m[0].length,
      marker: strongMarker ? marker : null,
      negative: (openParen != null && closeParen != null) || sign === "-" || innerMinus === "-",
      hasDecimals,
    });
  }
  return tokens;
}

const KIND_RULES: { kind: CaptureRowKind; re: RegExp }[] = [
  { kind: "tax", re: /\b(i?gst|cgst|sgst|service tax|tax on)\b/i },
  { kind: "interest", re: /\b(interest|finance charges?)\b/i },
  { kind: "emi", re: /\b(emi|instal?ments?|principal|smart ?emi|flexipay|loan on card)\b/i },
  { kind: "fee", re: /\b(fee|late payment|over ?limit|annual charges?|surcharge|penalty)\b/i },
  { kind: "cashback", re: /\b(cash ?back|reward redemption)\b/i },
  { kind: "refund", re: /\b(refund|reversal|reversed|chargeback|cancell?ed|return)\b/i },
  { kind: "payment", re: /\b(payment received|thank you|autopay|auto debit|bbps|payment - |neft|imps|upi payment|bill ?pay(ment)?|online payment)\b/i },
];

function classifyKind(description: string): CaptureRowKind {
  return KIND_RULES.find((r) => r.re.test(description))?.kind ?? "purchase";
}

const CREDIT_LEANING_KINDS: ReadonlySet<CaptureRowKind> = new Set(["refund", "payment", "cashback"]);

const REFERENCE_RE = /\b(?:ref(?:erence)?\.?\s*(?:no\.?)?\s*:?\s*)?([A-Z0-9]*\d{8,}[A-Z0-9]*)\b/i;

/** A short trailing cell that belongs to its own narrow column (country "IN", currency "USD", reward points "12"). */
const CODE_CELL = /^([A-Z]{2,3}|\d{1,5})$/;

/**
 * Keeps the merchant description to its own column. Copied tables and OCR (wide gaps → tab) separate columns with
 * tabs, or an OCR-read table rule " | ". Short code cells after the description (country/currency/points) are split
 * off into `extra` instead of being glued onto the merchant name; longer cells are kept (a wrapped/spaced merchant).
 */
export function splitDescriptionColumns(raw: string): { description: string; extra: string[] } {
  const cells = raw
    .split(/\t+| {3,}|\s+\|\s+/)
    .map((c) => cleanDescription(c))
    .filter(Boolean);
  const extra: string[] = [];
  while (cells.length > 1 && CODE_CELL.test(cells[cells.length - 1])) extra.unshift(cells.pop()!);
  return { description: cleanDescription(cells.join(" ")), extra };
}

function cleanDescription(text: string): string {
  return text
    .replace(/\t+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s|,:;-]+|[\s|,:;-]+$/g, "")
    .trim();
}

const CELL_SPLIT = /\t+| {2,}|\s+\|\s+/;

const STATEMENT_INFO_WORDS = /\b(due|balance|limit|total|minimum|outstanding|payable|statement|period|rewards?|points?|opening|closing|summary)\b/i;

function splitCells(line: string): string[] {
  return line
    .replace(/^[\s|]+|[\s|]+$/g, "")
    .split(CELL_SPLIT)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** A cell that is only a Charge/Credit marker (its own column). */
const MARKER_CELL = /^(cr|credit|dr|debit|charge|c|d)\.?$/i;

type CellKind = "date" | "amount" | "marker" | "text";

function classifyCell(cell: string): CellKind {
  const date = matchLeadingDate(cell);
  if (date && date.length === cell.length) return "date";
  if (MARKER_CELL.test(cell)) return "marker";
  const tokens = findAmounts(cell);
  if (tokens.length === 1 && tokens[0].index === 0 && tokens[0].length === cell.length) return "amount";
  return "text";
}

interface CellRead {
  /** Field order as the cells appear (short code cells like "IN" are not a field of their own). */
  order: SourceField[];
  /** The same cells rearranged as date → merchant → amount [marker], the one shape the line parser reads. */
  canonical: string;
  /** Already date → merchant → amount [marker] with nothing after: the line parser reads the original as-is. */
  standard: boolean;
}

/**
 * Reads a line as *cells* when every cell can be named from its own contents: exactly one date, exactly one money
 * amount, at most one standalone Cr/Dr marker right next to the amount, and merchant text in one contiguous run.
 * Anything else (two dates, two amounts, text on both sides of the amount, a date glued to the merchant, cells too
 * close to separate) returns null and the line is read exactly as it always was.
 */
function readSourceCells(line: string): CellRead | null {
  const cells = splitCells(line);
  if (cells.length < 3) return null;
  const kinds = cells.map(classifyCell);
  const at = (kind: CellKind) => kinds.flatMap((k, i) => (k === kind ? [i] : []));
  const [dateIdx, amountIdx, markerIdx, textIdx] = [at("date"), at("amount"), at("marker"), at("text")];
  if (dateIdx.length !== 1 || amountIdx.length !== 1 || markerIdx.length > 1 || textIdx.length === 0) return null;
  const [d, a] = [dateIdx[0], amountIdx[0]];
  const m = markerIdx[0];
  if (m != null) {
    if (Math.abs(m - a) !== 1 || findAmounts(cells[a])[0].marker != null) return null;
    // A lone C/D *before* the amount is as likely the tail of a merchant name ("TATA SKY  D  500.00") as a marker;
    // only a spelled-out Cr/Dr/Credit/Debit/Charge is trusted there. After the amount it is the C/D column.
    if (m < a && /^[cd]\.?$/i.test(cells[m])) return null;
  }
  const wordIdx = textIdx.filter((i) => !CODE_CELL.test(cells[i]));
  const merchantIdx = wordIdx.length > 0 ? wordIdx : textIdx;
  const [first, last] = [Math.min(...merchantIdx), Math.max(...merchantIdx)];
  if (kinds.slice(first, last + 1).some((k) => k !== "text")) return null;

  const placed: { field: SourceField; at: number }[] = [
    { field: "date", at: d },
    { field: "merchant", at: first },
    { field: "amount", at: a },
  ];
  if (m != null) placed.push({ field: "direction", at: m });
  const order = placed.sort((x, y) => x.at - y.at).map((p) => p.field);

  const tail = m ?? a;
  const standard = d === 0 && last < a && tail === cells.length - 1 && (m == null || m === a + 1);
  // A one-letter C/D stays one letter (the line parser only trusts it right after a decimal amount, and still asks
  // about a bare "43461 D"); a word maps to Cr/Dr.
  const marker = m == null ? "" : ` ${/^[cd]$/i.test(cells[m]) ? cells[m] : /^(cr|credit)/i.test(cells[m]) ? "Cr" : "Dr"}`;
  const canonical = [cells[d], textIdx.map((i) => cells[i]).join("\t"), cells[a] + marker].join("\t");
  return { order, canonical, standard };
}

/** Maps a header line's cells to fields; null unless it names a date, a merchant and an amount (or split debit/credit). */
function headerColumns(line: string): SourceField[] | null {
  const cells = splitCells(line);
  if (cells.length < 3) return null;
  const order: SourceField[] = [];
  const add = (f: SourceField) => {
    if (!order.includes(f)) order.push(f);
  };
  for (const raw of cells) {
    const c = raw.toLowerCase();
    if (/^(dr\s*\/\s*cr|cr\s*\/\s*dr|c\s*\/\s*d|d\s*\/\s*c|debit\s*\/\s*credit|credit\s*\/\s*debit|charge\s*\/\s*credit|type|txn type|dr\/cr)$/.test(c)) add("direction");
    else if (/^(debit|dr|withdrawals?|debit amount|amount \(dr\)|paid out)/.test(c)) add("debit");
    else if (/^(credit|cr|deposits?|credit amount|amount \(cr\)|paid in)/.test(c)) add("credit");
    else if (/^(amount|amt|transaction amount|amount\s*\(.*\))/.test(c)) add("amount");
    else if (/^(txn\.?\s*|transaction\s*)?date\b/.test(c)) add("date");
    else if (/(description|narration|particulars|merchant|transaction details|payee|remarks)/.test(c)) add("merchant");
  }
  const amountLike = order.includes("amount") || (order.includes("debit") && order.includes("credit"));
  return order.includes("date") && order.includes("merchant") && amountLike ? order : null;
}

/** A leading-date line the cell reader couldn't name: date → merchant → amount only if text precedes the amounts and nothing trails them. */
function legacyOrder(draft: DraftRow): SourceField[] | undefined {
  const last = draft.amountTokens[draft.amountTokens.length - 1];
  if (!draft.dateMatch || draft.mergedLines || !last || !/[a-z]/i.test(draft.description)) return undefined;
  return draft.rest.slice(last.index + last.length).trim() === "" ? ["date", "merchant", "amount"] : undefined;
}

interface ParseOptions {
  /** Used for year-less dates when the paste itself has no full date to borrow a year from. Defaults to today. */
  today?: Date;
}

interface DraftRow {
  lineStart: number;
  lineEnd: number;
  sourceLines: string[];
  /** Null for a transaction-looking line whose date couldn't be read. */
  dateMatch: DateMatch | null;
  description: string;
  amountTokens: AmountToken[];
  cells: string[] | null;
  /** Built from more than one source line (wrapped description / amount on the next line). */
  mergedLines: boolean;
  /** The text the amount tokens' indexes refer to (the line after its date). */
  rest: string;
  /** Source field order, when read with certainty (see `CaptureRow.sourceOrder`). */
  order?: SourceField[];
  /** The date was not the first cell of the line — it was read by its contents and is flagged for a look. */
  dateMoved?: boolean;
}

export function parsePastedStatement(input: string, options: ParseOptions = {}): CaptureParseResult {
  const today = options.today ?? new Date();
  const lines = input.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  const ignored: IgnoredLine[] = [];
  const drafts: DraftRow[] = [];
  let layout: ColumnLayout | null = null;
  let headerOrder: SourceField[] | undefined;
  let current: DraftRow | null = null;

  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed === "") {
      current = null;
      return;
    }

    if (isHeaderLine(trimmed)) {
      layout = columnLayoutFromHeader(line) ?? layout;
      headerOrder = headerColumns(line) ?? headerOrder;
      ignored.push({ lineIndex, text: trimmed, reason: "header" });
      current = null;
      return;
    }

    // Name the cells by their contents. A line that isn't already date → merchant → amount (a date in a later
    // column, a Cr/Dr column before the amount…) is read from the same cells rearranged into that shape; a summary
    // line ("Payment Due Date …") is never rearranged into a transaction.
    const cellRead = readSourceCells(line);
    // A date found in a later column is not allowed to turn a due-date / balance / limit style line into a row.
    const summaryish = cellRead != null && cellRead.order[0] !== "date" && STATEMENT_INFO_WORDS.test(trimmed);
    const reshaped = cellRead != null && !cellRead.standard && !isSummaryLine(trimmed) && !summaryish;
    const text = reshaped ? cellRead.canonical : trimmed;
    const dateMatch = matchLeadingDate(text);
    if (dateMatch && !/\b(opening|closing) balance\b/i.test(trimmed)) {
      let rest = text.slice(dateMatch.length);
      // A second leading date is the posting/value date column — drop it from the description.
      const second = matchLeadingDate(rest.replace(/^[\s\t|,-]+/, ""));
      if (second) rest = rest.replace(/^[\s\t|,-]+/, "").slice(second.length);
      const amountTokens = findAmounts(rest);
      const firstAmountAt = amountTokens[0]?.index ?? rest.length;
      current = {
        lineStart: lineIndex,
        lineEnd: lineIndex,
        sourceLines: [trimmed],
        dateMatch,
        description: rest.slice(0, firstAmountAt),
        amountTokens,
        cells: line.includes("\t") ? line.split("\t") : null,
        mergedLines: false,
        rest,
        order: cellRead?.order,
        dateMoved: reshaped && cellRead.order[0] !== "date",
      };
      current.order ??= legacyOrder(current);
      drafts.push(current);
      return;
    }

    if (isSummaryLine(trimmed)) {
      ignored.push({ lineIndex, text: trimmed, reason: "summary" });
      current = null;
      return;
    }

    const draft = current as DraftRow | null;
    const amountTokens = findAmounts(trimmed);
    // A line with its own merchant text and an amount but no readable date (OCR misread "09 Oct 26" as "090c126") is
    // its own transaction, not part of the row above: keep it as a separate row that needs a date — never merge
    // two transactions into one and never drop it silently.
    const ownTransaction = amountTokens.length > 0 && /[a-z]{3,}/i.test(trimmed.slice(0, amountTokens[0].index)) && amountTokens.some((t) => t.marker != null);
    if (amountTokens.length > 0 && (!draft || lineIndex !== draft.lineEnd + 1 || draft.amountTokens.length > 0 || ownTransaction)) {
      current = {
        lineStart: lineIndex,
        lineEnd: lineIndex,
        sourceLines: [trimmed],
        dateMatch: null,
        description: trimmed.slice(0, amountTokens[0].index),
        amountTokens,
        cells: line.includes("\t") ? line.split("\t") : null,
        mergedLines: false,
        rest: trimmed,
      };
      drafts.push(current);
      return;
    }

    // Continuation of the previous row: a wrapped description, or an amount that landed on its own line.
    if (draft && lineIndex === draft.lineEnd + 1) {
      draft.lineEnd = lineIndex;
      draft.sourceLines.push(trimmed);
      draft.description += " " + trimmed.slice(0, amountTokens[0]?.index ?? trimmed.length);
      draft.amountTokens = draft.amountTokens.concat(amountTokens);
      draft.mergedLines = true;
      return;
    }

    ignored.push({ lineIndex, text: trimmed, reason: "no_transaction" });
  });

  const hasCreditMarkers = drafts.some((d) => d.amountTokens.some((t) => t.marker === "credit"));
  // A Dr/D marker on any row means the statement marks EVERY row (a C/D column), so a row without one lost it.
  const markerColumn = drafts.some((d) => d.amountTokens.some((t) => t.marker === "debit"));
  const knownYears = drafts.map((d) => d.dateMatch?.y).filter((y): y is number => y != null);
  const fallbackYear = knownYears.length > 0 ? mostCommon(knownYears) : today.getFullYear();

  const rows = alignCodeColumns(drafts.map((draft, i) => finalizeRow(draft, i, { layout, hasCreditMarkers, markerColumn, fallbackYear, today })));
  return { rows, ignored, lines, hasCreditMarkers, ...(headerOrder ? { headerOrder } : {}) };
}

/**
 * OCR sometimes leaves only a single space before a narrow code column ("TELECOM SELFCARE IN"), so the gap-based
 * split misses it. When other rows of the same statement clearly have that code column (split on a real column gap),
 * the same trailing code on these rows is moved out of the description too — and the row says so.
 */
function alignCodeColumns(rows: CaptureRow[]): CaptureRow[] {
  const codes = new Set(rows.flatMap((r) => r.extraColumns).filter((c) => /^[A-Z]{2,3}$/.test(c)));
  if (codes.size === 0) return rows;
  return rows.map((row) => {
    if (row.extraColumns.length > 0) return row;
    const m = row.description.match(/^(.*\S)\s+([A-Z]{2,3})$/);
    if (!m || !codes.has(m[2])) return row;
    return { ...row, description: m[1], extraColumns: [m[2]], notes: [...row.notes, `"${m[2]}" treated as the same column other rows have, not part of the merchant name.`] };
  });
}

function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function finalizeRow(
  draft: DraftRow,
  index: number,
  ctx: { layout: ColumnLayout | null; hasCreditMarkers: boolean; markerColumn: boolean; fallbackYear: number; today: Date },
): CaptureRow {
  const issues: CaptureIssue[] = [];
  const notes: string[] = [];

  // --- date ---
  let date: Date | null = null;
  const dm = draft.dateMatch;
  if (dm == null) {
    issues.push({ code: "no_date", message: "No date could be read on this line (it may have been misread) — enter it from the statement.", blocking: true });
  } else {
    let year = dm.y;
    if (year == null) {
      year = ctx.fallbackYear;
      // A year-less "15 Dec" pasted in January belongs to last year.
      const candidate = buildDate(year, dm.mo, dm.d);
      if (candidate && candidate.getTime() - ctx.today.getTime() > 31 * 86_400_000) year -= 1;
      issues.push({ code: "year_assumed", message: `No year in the date — assumed ${year}.`, blocking: false });
    }
    date = buildDate(year, dm.mo, dm.d);
    if (!date) issues.push({ code: "no_date", message: "The date couldn't be read.", blocking: true });
    else if (dm.repaired) {
      issues.push({
        code: "low_confidence_date",
        field: "date",
        strict: true,
        blocking: true,
        message: `The month was read with a zero for the letter O ("${draft.sourceLines[0].slice(0, dm.length).trim()}") — check the date against the statement.`,
      });
    }
  }
  if (draft.mergedLines && draft.amountTokens.length > 0) {
    issues.push({ code: "merged_lines", message: `Built from ${draft.sourceLines.length} lines — check the extra line isn't a separate transaction.`, blocking: true });
  }

  // --- description / kind / reference ---
  const columns = splitDescriptionColumns(draft.description);
  let description = columns.description;
  const refMatch = description.match(REFERENCE_RE);
  const referenceNumber = refMatch ? refMatch[1] : null;
  if (!description) description = "(no description)";
  const kind = classifyKind(description);

  // --- amount + direction ---
  let amount: number | null = null;
  let direction: CaptureDirection | null = null;
  const tokens = draft.amountTokens;
  const amountCandidates = tokens.map((t) => t.value);

  const columnPick = ctx.layout && draft.cells ? pickFromColumns(draft.cells, ctx.layout) : null;
  if (columnPick) {
    amount = columnPick.amount;
    direction = columnPick.direction;
  } else if (tokens.length === 0) {
    issues.push({ code: "no_amount", message: "No amount found on this row — enter it.", blocking: true });
  } else {
    // Card statements end each row with the amount; a trailing second amount is usually a running balance.
    const token = tokens.length === 1 ? tokens[0] : null;
    if (token == null) {
      issues.push({
        code: "multiple_amounts",
        message: `Several amounts on this row (${tokens.map((t) => t.value).join(", ")}) — pick the transaction amount.`,
        blocking: true,
      });
      amount = tokens[0].value;
    } else if (token.missingDecimal) {
      issues.push({
        code: "decimal_missing",
        field: "amount",
        strict: true,
        confirmOnly: true,
        blocking: true,
        message: `Read "${token.value}" with no decimal point — is it ₹${(token.value / 100).toFixed(2)} or ₹${token.value.toFixed(2)}? Pick the amount on the statement.`,
      });
      amountCandidates.splice(0, amountCandidates.length, token.value / 100, token.value);
      direction = token.marker;
    } else {
      amount = token.value;
      if (!token.hasDecimals) {
        issues.push({ code: "amount_without_decimals", message: "Amount has no paise — check it wasn't a points or reference column.", blocking: false });
      }
      direction = resolveDirection(token, kind, ctx, issues);
    }
    // Direction from an explicit marker on any token still applies when the amount itself is ambiguous.
    if (direction == null && tokens.length > 1) {
      const marked = tokens.find((t) => t.marker != null);
      if (marked && tokens.every((t) => t.marker == null || t.marker === marked.marker)) direction = marked.marker;
    }
  }
  if (direction == null && !issues.some((i) => i.code === "direction_unclear" || i.code === "no_amount")) {
    issues.push({ code: "direction_unclear", message: "Can't tell whether this is a charge or a credit — choose one.", blocking: true });
  }

  if (draft.dateMoved) notes.push("The date wasn't the first column of this line — it was read from its contents. Check it against the source.");

  // --- defaults that keep risky rows out of an import unless the user opts in ---
  let suggestedInclude = true;
  if (kind === "emi") {
    suggestedInclude = false;
    notes.push("EMI line — Smart Capture can't link it to an EMI, so it starts excluded. Include it only to record it as a plain expense.");
  } else if (kind === "payment" && direction === "credit") {
    suggestedInclude = false;
    notes.push("Card bill payment — usually already recorded from the bank side. Starts excluded to avoid counting it twice.");
  }

  const blocking = issues.some((i) => i.blocking);
  const confidence: CaptureRow["confidence"] = blocking ? "low" : issues.length > 0 ? "medium" : "high";

  return {
    id: `r${index + 1}`,
    lineStart: draft.lineStart,
    lineEnd: draft.lineEnd,
    sourceText: draft.sourceLines.join("\n"),
    date,
    description,
    amount,
    direction,
    kind,
    referenceNumber,
    amountCandidates,
    extraColumns: columns.extra,
    issues,
    notes,
    confidence,
    suggestedInclude,
    ...(draft.order && !draft.mergedLines ? { sourceOrder: draft.order } : {}),
  };
}

function resolveDirection(
  token: AmountToken,
  kind: CaptureRowKind,
  { hasCreditMarkers, markerColumn }: { hasCreditMarkers: boolean; markerColumn: boolean },
  issues: CaptureIssue[],
): CaptureDirection | null {
  if (token.marker) return token.marker;
  if (markerColumn) {
    issues.push({ code: "direction_unclear", message: "Other rows have a C/D (Cr/Dr) marker but none was read on this one — choose Charge or Credit.", blocking: true });
    return null;
  }
  if (token.negative) {
    issues.push({ code: "direction_unclear", message: "Negative amount read as a credit — confirm.", blocking: false });
    return "credit";
  }
  // A refund/payment-looking line with no Cr marker is exactly the case we must not guess.
  if (CREDIT_LEANING_KINDS.has(kind)) {
    issues.push({ code: "direction_unclear", message: "Looks like a credit (refund/payment) but has no Cr marker — choose the direction.", blocking: true });
    return null;
  }
  if (!hasCreditMarkers) {
    issues.push({ code: "direction_unclear", message: "No Cr/Dr markers in this paste — read as a charge (card convention). Confirm.", blocking: false });
  }
  return "debit";
}

function pickFromColumns(cells: string[], layout: ColumnLayout): { amount: number; direction: CaptureDirection } | null {
  const debit = findAmounts(cells[layout.debitIndex] ?? "")[0];
  const credit = findAmounts(cells[layout.creditIndex] ?? "")[0];
  if (debit && !credit) return { amount: debit.value, direction: "debit" };
  if (credit && !debit) return { amount: credit.value, direction: "credit" };
  return null;
}

export const KIND_LABEL: Record<CaptureRowKind, string> = {
  purchase: "Purchase",
  refund: "Refund",
  payment: "Payment",
  interest: "Interest",
  tax: "GST / Tax",
  fee: "Fee",
  emi: "EMI",
  cashback: "Cashback",
};
