/**
 * Smart Capture column mapping — step 1½ between "text/OCR in" and "rows out".
 *
 * Statements disagree about their tables: some have Debit | Credit | Balance, some one Amount with a Cr/Dr column,
 * some a reference number or a value date, some none of the headers at all. Instead of hoping one parser fits them
 * all, the text is first cut into a *grid* (rows × columns), every column is given a role — automatically where the
 * evidence is clear, by the user where it is not — and only then are transactions read from the confirmed roles.
 *
 * This file is pure (no React, no Firestore, no network) and has two halves:
 *   1. `buildGrid` + `detectColumnRoles` — find the columns and propose a role for each (with how sure it is);
 *   2. `extractMapped` — read the transactions with the roles (see mapped-extract.ts).
 *
 * Nothing is guessed silently: a column whose role came from structure alone is marked "check", position is never
 * used to tell Debit from Credit unless the user sees and confirms it, and a column that is not mapped is not read.
 */

import { findAmounts, matchLeadingDate } from "./parse-pasted-statement";
import type { CaptureDirection } from "./parse-pasted-statement";
import type { OcrLine, OcrWord } from "./tesseract-ocr";

export type ColumnRole = "date" | "description" | "amount" | "debit" | "credit" | "type" | "balance" | "reference" | "ignore";

export const ROLE_LABEL: Record<ColumnRole, string> = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  debit: "Debit",
  credit: "Credit",
  type: "Cr / Dr",
  balance: "Balance",
  reference: "Reference no.",
  ignore: "Ignore",
};

/** The order roles are offered in. */
export const ROLE_ORDER: readonly ColumnRole[] = ["date", "description", "amount", "debit", "credit", "type", "balance", "reference", "ignore"];

/** Roles that name one column only; choosing one that is taken moves it (the old column becomes Ignore). */
export const SINGLE_ROLES: ReadonlySet<ColumnRole> = new Set(["date", "amount", "debit", "credit", "type", "balance", "reference"]);

export type GridMethod = "delimited" | "positioned" | "aligned" | "tokens";

export interface GridColumn {
  /** Header text for this column when the statement has one ("" otherwise). */
  header: string;
  /** Screenshot only: the horizontal band (prepared-canvas px) this column occupies. */
  span?: { x0: number; x1: number };
}

export interface GridRow {
  /** Index of the line in `CaptureGrid.lines` this row was read from. */
  lineIndex: number;
  cells: string[];
  /**
   * The line's cells could not be told apart by position (pasted text with single spaces, a line with a different cell
   * count) — an amount's column is then unknown, so Debit vs Credit is never decided from where it sits.
   */
  uncertain?: boolean;
}

export interface CaptureGrid {
  method: GridMethod;
  /** The source text's lines — line `i` here is line `i` of the parse result and of an OCR capture. */
  lines: string[];
  columns: GridColumn[];
  /** Only the lines that hold a transaction (a date in the date column). */
  rows: GridRow[];
  headerLine: number | null;
}

export function normalizeLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
}

// ---- cell reading -----------------------------------------------------------------------------------------------

export function isDateCell(cell: string): boolean {
  const t = cell.replace(/^[|\s]+/, "").trimEnd();
  return t !== "" && matchLeadingDate(t)?.length === t.length;
}

export type MoneyCell =
  | { kind: "money"; value: number; marker: CaptureDirection | null; negative: boolean }
  | { kind: "zero" }
  | { kind: "empty" }
  | { kind: "other" };

const EMPTY_CELL = /^([-–—_.]+|nil|na|n\/a)$/i;
const ZERO_CELL = /^(₹|rs\.?|inr)?\s*0+([.,]0+)?\s*(cr|dr)?$/i;

/** A single currency-looking glyph (or a lone R/T/Z/F/X/E/Y, how OCR often renders "₹") right before a number that is clearly money. */
const CURRENCY_GLYPH = /^([-(+]?)\s*(?:[^\w\s.,()+\-]|[RTZFXEY](?=\d))\s?(?=(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{1,2}|\d{1,3}(?:,\d{2,3})+)/;

/**
 * Takes the currency sign off the front of an amount ("₹ 9,694.47", "$9,694.47", "¥1,395.47", OCR's "T9,694.47") so the
 * number itself can be read. Only when what follows is clearly money — a description is never touched.
 */
export function cleanMoneyText(raw: string): string {
  return raw.trim().replace(CURRENCY_GLYPH, "$1");
}

/** What a cell holds as money. A cell with an amount AND other text is "other" — it is never half-read. */
export function parseMoneyCell(raw: string): MoneyCell {
  const cell = cleanMoneyText(raw);
  if (cell === "" || EMPTY_CELL.test(cell)) return { kind: "empty" };
  if (ZERO_CELL.test(cell)) return { kind: "zero" };
  const tokens = findAmounts(cell);
  if (tokens.length !== 1) return { kind: "other" };
  const [t] = tokens;
  if (cell.slice(0, t.index).trim() !== "" || cell.slice(t.index + t.length).trim() !== "") return { kind: "other" };
  return { kind: "money", value: t.value, marker: t.marker, negative: t.negative };
}

const MARKER_CELL = /^(cr|credit|dr|debit|c|d)\.?$/i;

/** A type-column value as the direction it names, or null when it names none. */
export function typeCellDirection(cell: string): CaptureDirection | null {
  const c = cell.trim().toLowerCase().replace(/\.$/, "");
  if (/^(cr|credit|c|deposit)$/.test(c)) return "credit";
  if (/^(dr|debit|d|withdrawal|charge)$/.test(c)) return "debit";
  return null;
}

const REFERENCE_CELL = /^[A-Za-z0-9/_-]*\d{6,}[A-Za-z0-9/_-]*$/;

// ---- grid building ----------------------------------------------------------------------------------------------

const trimCells = (cells: string[]) => cells.map((c) => c.replace(/\s+/g, " ").trim());

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}

/** The last line above the first transaction with at least two filled cells — the table's header, when it has one. */
function findHeaderLine(cellsByLine: (string[] | null)[], firstDataLine: number): number | null {
  for (let i = firstDataLine - 1; i >= 0; i--) {
    const cells = cellsByLine[i];
    if (cells && cells.filter(Boolean).length >= 2) return i;
  }
  return null;
}

/** Finishes a grid: the date column is where most transactions have their date; only those lines become rows. */
function assemble(method: GridMethod, lines: string[], width: number, cellsByLine: (string[] | null)[], uncertainLines: Set<number>, spans?: GridColumn["span"][]): CaptureGrid | null {
  const dateVotes = new Array<number>(width).fill(0);
  let candidates = 0;
  cellsByLine.forEach((cells) => {
    if (!cells) return;
    const first = cells.findIndex(isDateCell);
    if (first >= 0) {
      dateVotes[first]++;
      candidates++;
    }
  });
  if (candidates === 0 || width < 3) return null;
  const dateCol = dateVotes.indexOf(Math.max(...dateVotes));
  if (dateVotes[dateCol] / candidates < 0.8) return null;

  const rows: GridRow[] = [];
  cellsByLine.forEach((cells, lineIndex) => {
    if (cells && isDateCell(cells[dateCol] ?? "")) rows.push({ lineIndex, cells, ...(uncertainLines.has(lineIndex) ? { uncertain: true } : {}) });
  });
  if (rows.length === 0) return null;
  const headerLine = findHeaderLine(cellsByLine, rows[0].lineIndex);
  const headerCells = headerLine != null ? cellsByLine[headerLine] : null;
  const columns: GridColumn[] = Array.from({ length: width }, (_, i) => ({ header: headerCells?.[i] ?? "", ...(spans?.[i] ? { span: spans[i] } : {}) }));
  return { method, lines, columns, rows, headerLine };
}

// -- delimited (tab / pipe / comma-separated values) --

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const SPLITTERS: Record<string, (line: string) => string[]> = {
  "\t": (line) => line.split("\t"),
  "|": (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|"),
  ",": splitCsv,
};

function buildDelimited(lines: string[]): CaptureGrid | null {
  for (const [delimiter, split] of Object.entries(SPLITTERS)) {
    const split_ = lines.map((l) => (l.includes(delimiter) ? trimCells(split(l)) : null));
    const dataCounts = split_.flatMap((c) => (c && c.some(isDateCell) ? [c.length] : []));
    if (dataCounts.length === 0) continue;
    const width = mode(dataCounts);
    // Most transactions must have the same number of cells, or the delimiter isn't really this table's column separator.
    if (width < 3 || dataCounts.filter((n) => n === width).length / dataCounts.length < 0.7) continue;
    const uncertain = new Set<number>();
    const cells = split_.map((c, i) => {
      if (!c) return null;
      if (c.length === width) return c;
      // Different cell count: pad or fold the surplus into the last cell, and never trust where an amount sits.
      uncertain.add(i);
      return c.length < width ? [...c, ...new Array<string>(width - c.length).fill("")] : [...c.slice(0, width - 1), c.slice(width - 1).join(" ")];
    });
    const grid = assemble("delimited", lines, width, cells, uncertain);
    if (grid) return grid;
  }
  return null;
}

// -- aligned (monospace text: columns separated by runs of spaces at the same character positions) --

const GUTTER_MIN_CHARS = 2;

function buildAligned(lines: string[]): CaptureGrid | null {
  if (lines.some((l) => l.includes("\t"))) return null;
  const data = lines.flatMap((l, i) => (l.trim().split(/ {2,}/).some(isDateCell) ? [i] : []));
  if (data.length === 0) return null;
  const width = Math.max(...data.map((i) => lines[i].length));
  const blank = new Array<boolean>(width).fill(true);
  for (const i of data) for (let x = 0; x < lines[i].length; x++) if (lines[i][x] !== " ") blank[x] = false;
  const first = blank.indexOf(false);
  const last = blank.lastIndexOf(false);
  if (first < 0) return null;

  // Cut at the middle of every interior blank run that is wide enough — zero tolerance: a cut never goes through text.
  const cuts: number[] = [];
  for (let x = first; x <= last; ) {
    if (!blank[x]) {
      x++;
      continue;
    }
    let end = x;
    while (end <= last && blank[end]) end++;
    if (end - x >= GUTTER_MIN_CHARS) cuts.push(Math.floor((x + end) / 2));
    x = end;
  }
  const bounds = [0, ...cuts, Number.MAX_SAFE_INTEGER];
  const cols = bounds.length - 1;
  if (cols < 3) return null;
  const cells = lines.map((l) => (l.trim() === "" ? null : trimCells(Array.from({ length: cols }, (_, c) => l.slice(bounds[c], bounds[c + 1])))));
  return assemble("aligned", lines, cols, cells, new Set());
}

// -- positioned (screenshot: word boxes) --

/** The 1–3 consecutive words (left to right) that make up one whole date, if any. */
export function findDateRun(words: OcrWord[]): OcrWord[] | null {
  const ordered = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  for (let start = 0; start < ordered.length; start++) {
    for (let len = Math.min(3, ordered.length - start); len >= 1; len--) {
      const run = ordered.slice(start, start + len);
      if (isDateCell(run.map((w) => w.text).join(" "))) return run;
    }
  }
  return null;
}

/** Share of a table's transactions allowed to cross a column cut (OCR boxes are never pixel-perfect). */
const POSITION_TOLERANCE = 0.05;

function buildPositioned(textLines: string[], ocr: OcrLine[]): CaptureGrid | null {
  if (ocr.length !== textLines.length) return null;
  const data = ocr.flatMap((l, i) => (findDateRun(l.words) ? [i] : []));
  if (data.length === 0) return null;
  const heights = data.flatMap((i) => ocr[i].words.map((w) => w.bbox.y1 - w.bbox.y0));
  const gutterMin = Math.max(4, median(heights) * 1.0);
  const maxX = Math.ceil(Math.max(...data.flatMap((i) => ocr[i].words.map((w) => w.bbox.x1)))) + 1;
  const occupancy = new Array<number>(maxX + 1).fill(0);
  for (const i of data) {
    const covered = new Set<number>();
    for (const w of ocr[i].words) for (let x = Math.max(0, Math.floor(w.bbox.x0)); x <= Math.min(maxX, Math.ceil(w.bbox.x1)); x++) covered.add(x);
    covered.forEach((x) => occupancy[x]++);
  }
  const allowed = data.length >= 20 ? Math.floor(data.length * POSITION_TOLERANCE) : 0;
  const first = occupancy.findIndex((n) => n > allowed);
  const last = occupancy.length - 1 - [...occupancy].reverse().findIndex((n) => n > allowed);
  if (first < 0) return null;

  const cuts: number[] = [];
  for (let x = first; x <= last; ) {
    if (occupancy[x] > allowed) {
      x++;
      continue;
    }
    let end = x;
    while (end <= last && occupancy[end] <= allowed) end++;
    if (end - x >= gutterMin) cuts.push((x + end) / 2);
    x = end;
  }
  const cols = cuts.length + 1;
  if (cols < 3) return null;
  const spans = Array.from({ length: cols }, (_, c) => ({ x0: c === 0 ? 0 : cuts[c - 1], x1: c === cols - 1 ? Number.POSITIVE_INFINITY : cuts[c] }));
  const cells = ocr.map((l) => {
    if (l.words.length === 0) return null;
    const out = Array.from({ length: cols }, () => [] as string[]);
    for (const w of [...l.words].sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      const centre = (w.bbox.x0 + w.bbox.x1) / 2;
      const c = spans.findIndex((s) => centre >= s.x0 && centre < s.x1);
      out[c < 0 ? cols - 1 : c].push(w.text);
    }
    return out.map((words) => words.join(" ").trim());
  });
  return assemble("positioned", textLines, cols, cells, new Set(), spans);
}

// -- tokens (single-spaced text, e.g. copied out of a PDF viewer): date · description · amounts from the right --

const MONEY_TOKEN = /^\(?[-+]?(?:₹|rs\.?|inr)?\s?(?:(?:\d{1,3}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?|\d+\.\d{1,2})\)?$/i;
const MARKER_TOKEN = /^(cr|dr)\.?$/i;

function peelTail(rest: string): { head: string; amounts: string[] } {
  const parts = rest.trim().split(/\s+/);
  const amounts: string[] = [];
  let end = parts.length;
  while (end > 0) {
    let marker = "";
    let at = end;
    if (MARKER_TOKEN.test(parts[at - 1]) && at > 1 && MONEY_TOKEN.test(parts[at - 2])) {
      marker = ` ${parts[at - 1]}`;
      at--;
    }
    if (!MONEY_TOKEN.test(parts[at - 1])) break;
    amounts.unshift(parts[at - 1] + marker);
    end = at - 1;
  }
  return { head: parts.slice(0, end).join(" "), amounts };
}

function buildTokens(lines: string[]): CaptureGrid | null {
  interface Read {
    date: string;
    date2: string;
    desc: string;
    amounts: string[];
  }
  const reads = new Map<number, Read>();
  lines.forEach((line, i) => {
    const body = line.replace(/^[\s|]+/, "");
    const lead = matchLeadingDate(body);
    if (!lead) return;
    let rest = body.slice(lead.length);
    const second = matchLeadingDate(rest.replace(/^[\s|,-]+/, ""));
    let date2 = "";
    if (second) {
      const stripped = rest.replace(/^[\s|,-]+/, "");
      date2 = stripped.slice(0, second.length);
      rest = stripped.slice(second.length);
    }
    const { head, amounts } = peelTail(rest);
    reads.set(i, { date: body.slice(0, lead.length).trim(), date2, desc: head.replace(/^[\s|,-]+/, ""), amounts });
  });
  if (reads.size === 0) return null;
  const all = [...reads.values()];
  const hasDate2 = all.filter((r) => r.date2).length / all.length >= 0.5;
  const width = mode(all.map((r) => r.amounts.length));
  if (width === 0) return null;
  const uncertain = new Set<number>();
  const cells = lines.map((_, i) => {
    const r = reads.get(i);
    if (!r) return null;
    let { amounts, desc } = r;
    if (amounts.length !== width) {
      uncertain.add(i);
      if (amounts.length > width) {
        desc = `${desc} ${amounts.slice(0, amounts.length - width).join(" ")}`.trim();
        amounts = amounts.slice(amounts.length - width);
      }
    }
    // Right-aligned: the last number is the last column (usually the balance).
    const numeric = [...new Array<string>(width - amounts.length).fill(""), ...amounts];
    return [r.date, ...(hasDate2 ? [r.date2] : []), desc, ...numeric];
  });
  const total = (hasDate2 ? 3 : 2) + width;
  // A header line is only usable when it happens to split into exactly this many cells.
  const grid = assemble("tokens", lines, total, cells, uncertain);
  if (!grid) return null;
  if (grid.headerLine != null) {
    const headerCells = trimCells(lines[grid.headerLine].replace(/^[\s|]+|[\s|]+$/g, "").split(/\t+| {2,}|\s+\|\s+/)).filter(Boolean);
    if (headerCells.length === total) grid.columns.forEach((c, i) => (c.header = headerCells[i]));
  }
  return grid;
}

export interface GridSource {
  text: string;
  /** Screenshot reads: the OCR lines (line `i` ↔ line `i` of `text`) — they give real column positions. */
  ocrLines?: OcrLine[];
}

/** Cuts the source into a table, or null when no table can be found (then the plain parser reads it as before). */
export function buildGrid({ text, ocrLines }: GridSource): CaptureGrid | null {
  const lines = normalizeLines(text);
  return (ocrLines ? buildPositioned(lines, ocrLines) : null) ?? buildDelimited(lines) ?? buildAligned(lines) ?? buildTokens(lines);
}

// ---- role detection ---------------------------------------------------------------------------------------------

/** How much the proposed role can be trusted: "high" = header and contents agree, "check" = structure only, "none" = no evidence. */
export type RoleConfidence = "high" | "check" | "none";

export interface AutoMapping {
  roles: ColumnRole[];
  confidence: RoleConfidence[];
}

/** Role named by a header cell, or null. */
export function headerRole(raw: string): ColumnRole | null {
  const h = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!h) return null;
  // A row counter ("S.No", "Sl. No.", "No.", "#") is not a reference number — it numbers the rows, nothing more.
  if (/^(s\.?\s*no\.?|sl\.?\s*no\.?|sr\.?\s*no\.?|serial(\s*(no\.?|number))?|sno|no\.?|#|index)$/.test(h)) return "ignore";
  if (/value\s*(date|dt)|val\.?\s*(date|dt)/.test(h)) return "ignore";
  if (/^(dr\s*\/\s*cr|cr\s*\/\s*dr|c\s*\/\s*d|d\s*\/\s*c|debit\s*\/\s*credit|credit\s*\/\s*debit|type|txn type|transaction type|dr\/cr.*|cr\/dr.*)$/.test(h)) return "type";
  // "Remarks / Instrument", "Narration", "Particulars" hold the text of the transaction, even when a UPI string looks like a reference.
  if (/(description|narration|particulars|remarks|merchant|payee|details)/.test(h) && !/\b(ref|chq|cheque|utr)\b/.test(h)) return "description";
  if (/\b(ref|chq|cheque|utr|instrument|reference|txn id|transaction id|tran id)\b/.test(h) && !/\b(date|dt)\b/.test(h)) return "reference";
  if (/\bbal(ance)?\b/.test(h)) return "balance";
  if (/\b(date|dt)\b/.test(h)) return "date";
  if (/^(debit|dr|withdrawals?|paid out|money out|spent)\b|\bwithdrawal\b|\(dr\)|\bdebit\b/.test(h) && !/\bcredit\b/.test(h)) return "debit";
  if (/^(credit|cr|deposits?|paid in|money in|received)\b|\bdeposit\b|\(cr\)|\bcredit\b/.test(h) && !/\bdebit\b/.test(h)) return "credit";
  if (/\b(amount|amt)\b/.test(h)) return "amount";
  if (/(description|narration|particulars|details|remarks|merchant|payee|transaction)/.test(h)) return "description";
  return null;
}

interface ColumnStats {
  filled: number;
  dates: number;
  money: number;
  markers: number;
  refs: number;
  text: number;
  avgLength: number;
}

function columnStats(grid: CaptureGrid, col: number): ColumnStats {
  const s: ColumnStats = { filled: 0, dates: 0, money: 0, markers: 0, refs: 0, text: 0, avgLength: 0 };
  let length = 0;
  for (const row of grid.rows) {
    const cell = (row.cells[col] ?? "").trim();
    const money = parseMoneyCell(cell);
    if (money.kind === "empty") continue;
    s.filled++;
    length += cell.length;
    if (isDateCell(cell)) s.dates++;
    else if (money.kind === "money" || money.kind === "zero") s.money++;
    else if (MARKER_CELL.test(cell)) s.markers++;
    else if (REFERENCE_CELL.test(cell) && !/\s/.test(cell)) s.refs++;
    else if (/[a-z]{3,}/i.test(cell)) s.text++;
  }
  s.avgLength = s.filled ? length / s.filled : 0;
  return s;
}

/** The money in a row's cell (absolute value), or null when the cell holds none. */
function cellMoney(row: GridRow, col: number): number | null {
  const m = parseMoneyCell(row.cells[col] ?? "");
  return m.kind === "money" ? m.value : null;
}

export interface Continuity {
  matches: number;
  pairs: number;
  orientation: "oldest-first" | "newest-first";
}

/**
 * How well a column behaves like a running balance: the step between neighbouring rows equals an amount on the row.
 * Tried in both row orders (statements list oldest-first or newest-first); the better one is returned.
 */
export function balanceContinuity(grid: CaptureGrid, balanceCol: number, amountCols: number[]): Continuity {
  const bal = grid.rows.map((r) => cellMoney(r, balanceCol));
  const amounts = grid.rows.map((r) => amountCols.flatMap((c) => cellMoney(r, c) ?? []).map((v) => Math.round(v * 100)));
  const score = (neighbour: (i: number) => number) => {
    let matches = 0;
    let pairs = 0;
    for (let i = 0; i < bal.length; i++) {
      const j = neighbour(i);
      const [now, before] = [bal[i], bal[j]];
      if (now == null || before == null) continue;
      pairs++;
      if (amounts[i].includes(Math.abs(Math.round(now * 100) - Math.round(before * 100)))) matches++;
    }
    return { matches, pairs };
  };
  const oldest = score((i) => i - 1);
  const newest = score((i) => i + 1);
  return oldest.matches >= newest.matches ? { ...oldest, orientation: "oldest-first" } : { ...newest, orientation: "newest-first" };
}

const continuityOk = (c: Continuity) => c.pairs >= 1 && c.matches / c.pairs >= 0.6 && (c.pairs >= 2 || c.matches === 1);

/** Share of rows in which both columns have an amount: two columns that are never filled together are Debit | Credit. */
function overlap(grid: CaptureGrid, a: number, b: number): number {
  const filled = grid.rows.filter((r) => cellMoney(r, a) != null || cellMoney(r, b) != null);
  return filled.length ? filled.filter((r) => cellMoney(r, a) != null && cellMoney(r, b) != null).length / filled.length : 0;
}

/**
 * The column most likely to be the description when none is chosen: text-like (not dates, money or a Cr/Dr marker),
 * the widest, and not already something the header settled firmly (Date, money, Balance…).
 */
export function descriptionCandidate(grid: CaptureGrid, roles: readonly (ColumnRole | null)[]): number | null {
  let best: { col: number; length: number } | null = null;
  for (let i = 0; i < grid.columns.length; i++) {
    const role = roles[i];
    if (role != null && role !== "reference" && role !== "ignore") continue;
    const s = columnStats(grid, i);
    if (s.filled === 0 || s.dates > 0 || s.money / s.filled > 0.3 || s.markers / s.filled > 0.3 || (s.text + s.refs) / s.filled < 0.6 || s.avgLength < 6) continue;
    if (best == null || s.avgLength > best.length) best = { col: i, length: s.avgLength };
  }
  return best?.col ?? null;
}

export function detectColumnRoles(grid: CaptureGrid): AutoMapping {
  const n = grid.columns.length;
  const roles: (ColumnRole | null)[] = new Array(n).fill(null);
  const confidence: RoleConfidence[] = new Array(n).fill("none");
  const stats = Array.from({ length: n }, (_, i) => columnStats(grid, i));
  const header = grid.columns.map((c) => headerRole(c.header));
  const total = Math.max(1, grid.rows.length);
  const set = (i: number, role: ColumnRole, c: RoleConfidence) => {
    roles[i] = role;
    confidence[i] = c;
  };
  const free = () => roles.flatMap((r, i) => (r == null ? [i] : []));
  const moneyLike = (i: number) => stats[i].filled > 0 && stats[i].money / stats[i].filled >= 0.8;
  const markerLike = (i: number) => stats[i].filled > 0 && stats[i].markers / stats[i].filled >= 0.8;

  // 1. Date: the column of dates (a second date column — value date — is not read).
  const dateCols = stats.flatMap((s, i) => (s.dates / total >= 0.7 ? [i] : []));
  const dateCol = dateCols.find((i) => header[i] === "date") ?? dateCols[0];
  for (const i of dateCols) set(i, i === dateCol ? "date" : "ignore", i === dateCol ? (header[i] === "date" || stats[i].dates === stats[i].filled ? "high" : "check") : "high");

  // 2. Columns the header names — trusted when the contents agree (or there are none to disagree).
  const taken = new Set<ColumnRole>();
  for (let i = 0; i < n; i++) {
    const role = header[i];
    if (roles[i] != null || role == null || role === "date") continue;
    if (SINGLE_ROLES.has(role) && taken.has(role)) continue;
    const s = stats[i];
    const agrees =
      role === "ignore" ||
      s.filled === 0 ||
      (role === "description" && s.text + s.refs > 0) ||
      (["amount", "debit", "credit", "balance"].includes(role) && moneyLike(i)) ||
      (role === "type" && markerLike(i)) ||
      role === "reference";
    if (!agrees && role !== "description") continue;
    set(i, role, agrees ? "high" : "check");
    taken.add(role);
  }

  // 3. Balance, when no header named it: the money column the other amounts walk through.
  const money = free().filter(moneyLike);
  const amountCols = (excluding: number) => [...money, ...roles.flatMap((r, i) => (r === "amount" || r === "debit" || r === "credit" ? [i] : []))].filter((i) => i !== excluding);
  if (!taken.has("balance") && money.length >= 2) {
    let best: { col: number; c: Continuity } | null = null;
    for (const col of money) {
      const c = balanceContinuity(grid, col, amountCols(col));
      if (continuityOk(c) && (best == null || c.matches / c.pairs > best.c.matches / best.c.pairs)) best = { col, c };
    }
    if (best) {
      set(best.col, "balance", best.c.matches / best.c.pairs >= 0.8 ? "high" : "check");
      taken.add("balance");
    }
  }

  // 4. Amount columns that are left.
  const rest = free().filter(moneyLike);
  const haveAmounts = taken.has("amount") || taken.has("debit") || taken.has("credit");
  if (!haveAmounts && rest.length > 0) {
    if (rest.length === 1) {
      set(rest[0], "amount", "high");
      taken.add("amount");
    } else if (overlap(grid, rest[0], rest[1]) <= 0.1) {
      // Two columns never filled together — Debit | Credit. Their order is the usual one, but only the user (or the
      // balance) can say which is which, so it is marked "check".
      set(rest[0], "debit", "check");
      set(rest[1], "credit", "check");
      taken.add("debit").add("credit");
      if (!taken.has("balance") && rest.length === 3) {
        set(rest[2], "balance", "check");
        taken.add("balance");
      }
    } else {
      set(rest[0], "amount", "check");
      taken.add("amount");
      if (!taken.has("balance") && rest.length === 2) {
        set(rest[1], "balance", "check");
        taken.add("balance");
      }
    }
  } else if (haveAmounts) {
    // A lone debit/credit named by its header, with an unnamed money column beside it → the other half.
    for (const i of rest) {
      if (taken.has("debit") && !taken.has("credit") && !taken.has("amount")) {
        set(i, "credit", "check");
        taken.add("credit");
      } else if (taken.has("credit") && !taken.has("debit") && !taken.has("amount")) {
        set(i, "debit", "check");
        taken.add("debit");
      }
    }
  }

  // 5. Cr/Dr marker column: only meaningful beside a single Amount.
  for (const i of free()) {
    if (markerLike(i) && !taken.has("type") && taken.has("amount") && !taken.has("debit") && !taken.has("credit")) {
      set(i, "type", "high");
      taken.add("type");
    }
  }

  // 6. Reference, then description (the widest remaining text column), then everything else is ignored.
  for (const i of free()) {
    const s = stats[i];
    if (!taken.has("reference") && s.filled > 0 && s.refs / s.filled >= 0.6) {
      set(i, "reference", "check");
      taken.add("reference");
    }
  }
  const textCols = free().filter((i) => stats[i].text > 0);
  if (!roles.some((r) => r === "description") && textCols.length > 0) {
    const widest = textCols.reduce((a, b) => (stats[b].avgLength > stats[a].avgLength ? b : a));
    set(widest, "description", "high");
  }
  // Nothing text-like was left (e.g. a UPI string was taken for a reference): the widest such column is the description.
  if (!roles.some((r) => r === "description")) {
    const fallback = descriptionCandidate(grid, roles);
    if (fallback != null) set(fallback, "description", "check");
  }
  // A text column right next to the description (Narration split in two) belongs to it.
  const descCols = roles.flatMap((r, i) => (r === "description" ? [i] : []));
  for (const i of free()) {
    if (stats[i].text > 0 && descCols.some((d) => Math.abs(d - i) === 1)) set(i, "description", "check");
  }
  for (const i of free()) set(i, "ignore", "none");

  return { roles: roles as ColumnRole[], confidence };
}

// ---- validating a mapping ---------------------------------------------------------------------------------------

export interface MappingProblem {
  level: "error" | "warning";
  message: string;
  /** Columns the message is about. */
  columns?: number[];
  /** A one-click remedy the screen can offer. */
  fix?: { column: number; role: ColumnRole };
}

export function validateMapping(grid: CaptureGrid, roles: readonly ColumnRole[]): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const at = (role: ColumnRole) => roles.flatMap((r, i) => (r === role ? [i] : []));
  const [date, desc, amount, debit, credit, type] = (["date", "description", "amount", "debit", "credit", "type"] as const).map(at);
  if (date.length === 0) problems.push({ level: "error", message: "Choose which column holds the Date." });
  if (desc.length === 0) {
    const guess = descriptionCandidate(grid, roles);
    problems.push({
      level: "error",
      message: guess != null ? `No column is set as Description — it needs one. Is "${columnName(grid, guess)}" the transaction text?` : "No column is set as Description. Open a column's dropdown and choose Description.",
      ...(guess != null ? { columns: [guess], fix: { column: guess, role: "description" as const } } : {}),
    });
  }
  if (amount.length === 0 && debit.length === 0 && credit.length === 0) problems.push({ level: "error", message: "Choose the money column — Amount, or Debit and Credit." });
  if (amount.length > 0 && (debit.length > 0 || credit.length > 0)) {
    problems.push({ level: "error", message: "Use either one Amount column or Debit / Credit columns, not both.", columns: [...amount, ...debit, ...credit] });
  }
  if (type.length > 0 && (debit.length > 0 || credit.length > 0)) {
    problems.push({ level: "error", message: "A Cr / Dr column goes with a single Amount column, not with Debit / Credit.", columns: type });
  }
  if (problems.some((p) => p.level === "error")) return problems;

  if (amount.length === 0 && (debit.length === 0 || credit.length === 0)) {
    problems.push({ level: "warning", message: `Only ${debit.length ? "Debit" : "Credit"} is mapped — every amount will be read as a ${debit.length ? "charge" : "credit"}.` });
  }
  const dateColumn = date[0];
  const readable = grid.rows.filter((r) => isDateCell(r.cells[dateColumn] ?? "")).length;
  if (readable < grid.rows.length) {
    problems.push({ level: "warning", message: `${grid.rows.length - readable} row${grid.rows.length - readable === 1 ? "" : "s"} have no readable date in the Date column.`, columns: date });
  }
  const moneyColumns = [...amount, ...debit, ...credit];
  const withMoney = grid.rows.filter((r) => moneyColumns.some((c) => cellMoney(r, c) != null)).length;
  if (withMoney < grid.rows.length) {
    const missing = grid.rows.length - withMoney;
    problems.push({ level: "warning", message: `${missing} row${missing === 1 ? "" : "s"} have no readable amount in the mapped column${moneyColumns.length === 1 ? "" : "s"}.`, columns: moneyColumns });
  }
  const balance = at("balance")[0];
  if (balance != null && moneyColumns.length > 0) {
    const c = balanceContinuity(grid, balance, moneyColumns);
    if (c.pairs >= 2 && c.matches / c.pairs < 0.6) {
      problems.push({ level: "warning", message: "The Balance column doesn't follow the amounts row by row — check that it really is the running balance.", columns: [balance] });
    }
  }
  return problems;
}

/** Gives `column` a role. A role that names one column moves there (its previous column becomes Ignore). */
export function assignRole(roles: readonly ColumnRole[], column: number, role: ColumnRole): ColumnRole[] {
  const next = [...roles];
  if (SINGLE_ROLES.has(role)) next.forEach((r, i) => (r === role && i !== column ? (next[i] = "ignore") : undefined));
  next[column] = role;
  return next;
}

export function columnName(grid: CaptureGrid, column: number): string {
  return grid.columns[column]?.header.trim() || `Column ${column + 1}`;
}
