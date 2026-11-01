/**
 * Reads transactions from a statement grid using the roles the user confirmed (see column-mapping.ts).
 *
 * The confirmed columns are written back out as one plain line per transaction —
 * `date ⇥ description ⇥ amount [Cr|Dr]` — and handed to the same parser every other capture goes through, so every
 * existing check (date/year handling, decimals, kinds, repeats…) applies unchanged. Only what the mapping adds is
 * done here:
 *
 *  - Debit and Credit columns decide the direction (an amount in Debit is a charge, in Credit a credit); a row with
 *    amounts in both, or neither, is left for the user — never resolved by position;
 *  - the Balance column is never read as an amount, only used to *check* the rows: the step between neighbouring
 *    balances must equal the amount. A row that breaks it is blocked for a look, and when a statement has no
 *    Cr/Dr/Debit/Credit at all, the balance is the only evidence of direction — used only when it settles the row to the
 *    paisa, otherwise the row asks the user;
 *  - a mapped Reference column is the row's reference number.
 */

import {
  parsePastedStatement,
  type CaptureDirection,
  type CaptureIssue,
  type CaptureParseResult,
  type CaptureRow,
  type SourceField,
} from "./parse-pasted-statement";
import { cleanMoneyText, parseMoneyCell, typeCellDirection, type CaptureGrid, type ColumnRole } from "./column-mapping";
import type { OcrLine, OcrWord } from "./tesseract-ocr";

export interface BalanceCheck {
  /** A Balance column is mapped. */
  mapped: boolean;
  /** Neighbouring rows both carrying a balance and an amount. */
  checked: number;
  /** Of those, the rows whose balance follows from the previous one. */
  matched: number;
  /** Rows blocked for breaking the running balance. */
  mismatched: number;
  /** The balance follows the amounts closely enough to judge rows by it. */
  trusted: boolean;
  /**
   * The statement's own Debit/Credit rows move the balance the unusual way (a Debit raises it). Usually that means the
   * two columns are swapped — the preview says so and offers the swap; rows are not individually blocked for it.
   */
  inverted: boolean;
}

/** Debit and Credit trade places. */
export function swapDebitCredit(roles: readonly ColumnRole[]): ColumnRole[] {
  return roles.map((r) => (r === "debit" ? "credit" : r === "credit" ? "debit" : r));
}

export interface MappedExtraction {
  result: CaptureParseResult;
  balance: BalanceCheck;
}

interface RowMeta {
  balance: number | null;
  reference: string | null;
  /** The direction was stated by the statement (Debit/Credit column, Cr/Dr column or marker, sign) — not left to convention. */
  explicit: boolean;
  /** …and specifically by a mapped column. */
  fromColumn: boolean;
}

const rolesAt = (roles: readonly ColumnRole[], role: ColumnRole) => roles.flatMap((r, i) => (r === role ? [i] : []));
const stripMarker = (cell: string) => cell.replace(/[\s|]*(cr|dr)\.?$/i, "").trim();
const paise = (rupees: number) => Math.round(rupees * 100);

function balanceOf(cell: string): number | null {
  const m = parseMoneyCell(cell);
  if (m.kind === "zero") return 0;
  if (m.kind !== "money") return null;
  return m.negative || m.marker === "debit" ? -m.value : m.value;
}

/** The amount part of a transaction's line, and whether the statement itself stated the direction. */
function amountPart(cells: string[], uncertain: boolean, roles: readonly ColumnRole[]): { part: string; explicit: boolean; fromColumn: boolean } {
  const [amountCol] = rolesAt(roles, "amount");
  if (amountCol != null) {
    const cell = cleanMoneyText(cells[amountCol] ?? "");
    const m = parseMoneyCell(cell);
    if (m.kind === "empty" || m.kind === "zero") return { part: "", explicit: false, fromColumn: false };
    const [typeCol] = rolesAt(roles, "type");
    const typed = typeCol != null ? typeCellDirection(cells[typeCol] ?? "") : null;
    const markerless = m.kind === "money" && m.marker == null;
    const part = markerless && typed ? `${cell} ${typed === "credit" ? "Cr" : "Dr"}` : cell;
    const explicit = m.kind === "money" && (m.marker != null || m.negative || typed != null);
    return { part, explicit, fromColumn: markerless && typed != null };
  }

  const [debitCol] = rolesAt(roles, "debit");
  const [creditCol] = rolesAt(roles, "credit");
  const filled = ([[debitCol, "Dr"], [creditCol, "Cr"]] as const).flatMap(([col, marker]) => {
    const cell = col != null ? (cells[col] ?? "") : "";
    return parseMoneyCell(cell).kind === "money" ? [{ cell: stripMarker(cleanMoneyText(cell)), marker }] : [];
  });
  if (filled.length === 0) return { part: "", explicit: false, fromColumn: false };
  // Where an amount sits is only trustworthy when the line's cells were told apart by position.
  if (uncertain) return { part: filled.map((f) => f.cell).join("\t"), explicit: false, fromColumn: false };
  if (filled.length === 1) return { part: `${filled[0].cell} ${filled[0].marker}`, explicit: true, fromColumn: true };
  return { part: filled.map((f) => `${f.cell} ${f.marker}`).join("\t"), explicit: false, fromColumn: false };
}

const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function recompute(row: CaptureRow): CaptureRow {
  const blocking = row.issues.some((i) => i.blocking);
  return { ...row, confidence: blocking ? "low" : row.issues.length > 0 ? "medium" : "high" };
}

function withDirection(row: CaptureRow, direction: CaptureDirection | null, issue: CaptureIssue | null): CaptureRow {
  const issues = row.issues.filter((i) => i.code !== "direction_unclear" && i.code !== "direction_inferred");
  const next = { ...row, direction, issues: issue ? [...issues, issue] : issues };
  if (direction === "credit" && row.kind === "payment" && next.suggestedInclude) {
    next.suggestedInclude = false;
    next.notes = [...next.notes, "Card bill payment — usually already recorded from the bank side. Starts excluded to avoid counting it twice."];
  }
  return recompute(next);
}

export function extractMapped(grid: CaptureGrid, roles: readonly ColumnRole[], options: { today?: Date } = {}): MappedExtraction {
  const [dateCol] = rolesAt(roles, "date");
  const descCols = rolesAt(roles, "description");
  const [refCol] = rolesAt(roles, "reference");
  const [balanceCol] = rolesAt(roles, "balance");
  const dataLines = new Map(grid.rows.map((r) => [r.lineIndex, r]));

  const meta = new Map<number, RowMeta>();
  // Lines that aren't transactions pass through as written — with tabs flattened, so a header line can't be taken as
  // the parser's own Debit/Credit column layout (the mapping has already said which column is which).
  const lines = grid.lines.map((line, i) => {
    const row = dataLines.get(i);
    if (!row) return line.replace(/\t+/g, "  ");
    const description = descCols.map((c) => row.cells[c] ?? "").join(" ").replace(/\s+/g, " ").trim();
    const amount = amountPart(row.cells, row.uncertain === true, roles);
    meta.set(i, {
      balance: balanceCol != null ? balanceOf(row.cells[balanceCol] ?? "") : null,
      reference: refCol != null && (row.cells[refCol] ?? "").trim() ? row.cells[refCol].trim() : null,
      explicit: amount.explicit,
      fromColumn: amount.fromColumn,
    });
    return [row.cells[dateCol] ?? "", description, amount.part].join("\t").replace(/\t+$/, "");
  });

  const parsed = parsePastedStatement(lines.join("\n"), options);
  const order: SourceField[] = roles.flatMap((r, i): SourceField[] =>
    r === "date" ? ["date"] : r === "description" ? (descCols[0] === i ? ["merchant"] : []) : r === "amount" ? ["amount"] : r === "debit" ? ["debit"] : r === "credit" ? ["credit"] : r === "type" ? ["direction"] : [],
  );

  let rows: CaptureRow[] = parsed.rows.map((row) => {
    const m = meta.get(row.lineStart);
    if (!m) return row;
    return {
      ...row,
      sourceText: grid.lines.slice(row.lineStart, row.lineEnd + 1).map((l) => l.trim()).join("\n"),
      referenceNumber: m.reference ?? row.referenceNumber,
      ...(m.fromColumn ? { directionBasis: "column" as const } : {}),
      ...(row.issues.some((i) => i.code === "merged_lines") ? {} : { sourceOrder: order }),
    };
  });

  const balance = balanceCol != null ? checkBalance(rows, meta) : { check: { mapped: false, checked: 0, matched: 0, mismatched: 0, trusted: false, inverted: false }, rows };
  rows = balance.rows;

  return {
    result: { ...parsed, rows, lines: grid.lines, headerOrder: order },
    balance: balance.check,
  };
}

/**
 * The running-balance pass. `rows` are in statement order; the previous row *in time* is the one above for an
 * oldest-first statement and the one below for newest-first (whichever the balances themselves show).
 */
function checkBalance(rows: CaptureRow[], meta: Map<number, RowMeta>): { check: BalanceCheck; rows: CaptureRow[] } {
  const seq = rows.flatMap((row, index) => {
    const m = meta.get(row.lineStart);
    return m ? [{ index, row, m }] : [];
  });
  const step = (k: number, dir: -1 | 1) => {
    const [cur, prev] = [seq[k], seq[k + dir]];
    if (!prev || cur.m.balance == null || prev.m.balance == null || cur.row.amount == null) return null;
    const delta = paise(cur.m.balance) - paise(prev.m.balance);
    return { delta, magnitudeOk: Math.abs(delta) === paise(cur.row.amount) };
  };
  const tally = (dir: -1 | 1) => {
    let pairs = 0;
    let matches = 0;
    seq.forEach((_, k) => {
      const s = step(k, dir);
      if (!s) return;
      pairs++;
      if (s.magnitudeOk) matches++;
    });
    return { pairs, matches };
  };
  const [oldestFirst, newestFirst] = [tally(-1), tally(1)];
  const dir: -1 | 1 = oldestFirst.matches >= newestFirst.matches ? -1 : 1;
  const { pairs, matches } = dir === -1 ? oldestFirst : newestFirst;
  const trusted = pairs >= 1 && matches / pairs >= 0.6 && (pairs >= 2 || matches === 1);

  // Which way does a credit move the balance? Learned from rows the statement marked itself; an ordinary account: up.
  let up = 0;
  let down = 0;
  seq.forEach((e, k) => {
    const s = step(k, dir);
    if (!s || !s.magnitudeOk || !e.m.explicit || !e.row.direction) return;
    if (Math.sign(s.delta) === (e.row.direction === "credit" ? 1 : -1)) up++;
    else down++;
  });
  const creditRaises = up >= down;

  const out = [...rows];
  let mismatched = 0;
  seq.forEach((e, k) => {
    const s = step(k, dir);
    let row = out[e.index];
    const amount = row.amount;
    if (e.m.balance == null || amount == null) return;
    const mismatch = (): CaptureIssue => ({
      code: "balance_mismatch",
      blocking: true,
      message: `The running balance doesn't follow this row (balance ${money(e.m.balance!)} after an amount of ${money(amount)}). Check the amount and the Debit / Credit / Balance columns.`,
    });

    if (e.m.explicit) {
      if (trusted && s && row.direction) {
        const expected = (row.direction === "credit") === creditRaises ? 1 : -1;
        if (!s.magnitudeOk || Math.sign(s.delta) !== expected) {
          mismatched++;
          row = recompute({ ...row, issues: [...row.issues, mismatch()] });
        }
      }
    } else {
      // No stated direction: the balance may settle it — to the paisa, in the usual sense — otherwise the user does.
      if (trusted && s?.magnitudeOk) {
        const direction: CaptureDirection = s.delta > 0 === creditRaises ? "credit" : "debit";
        row = {
          ...withDirection(row, direction, {
            code: "direction_inferred",
            blocking: false,
            message: `Charge/Credit worked out from the running balance (it ${s.delta > 0 ? "rose" : "fell"} by ${money(amount)}) — this statement has no Cr/Dr marker. Check it.`,
          }),
          directionBasis: "balance",
        };
      } else {
        if (trusted && s && !s.magnitudeOk) {
          mismatched++;
          row = recompute({ ...row, issues: [...row.issues, mismatch()] });
        }
        row = withDirection(row, null, {
          code: "direction_unclear",
          blocking: true,
          message: "Can't tell whether this is a charge or a credit — the statement has no Cr/Dr marker here and the running balance doesn't settle it. Choose one.",
        });
      }
    }
    out[e.index] = row;
  });

  return { check: { mapped: true, checked: pairs, matched: matches, mismatched, trusted, inverted: trusted && down > up }, rows: out };
}

// ---- what the mapping preview and the OCR layer need --------------------------------------------------------------

export interface ExtractionSummary {
  rows: number;
  /** Rows with something blocking — they arrive in Review & Import flagged. */
  needsLook: number;
  debitPaise: number;
  creditPaise: number;
  firstDate: Date | null;
  lastDate: Date | null;
}

export function summarizeExtraction(rows: readonly CaptureRow[]): ExtractionSummary {
  let debit = 0;
  let credit = 0;
  const times: number[] = [];
  for (const r of rows) {
    if (r.amount != null && r.direction === "debit") debit += paise(r.amount);
    if (r.amount != null && r.direction === "credit") credit += paise(r.amount);
    if (r.date) times.push(r.date.getTime());
  }
  return {
    rows: rows.length,
    needsLook: rows.filter((r) => r.issues.some((i) => i.blocking)).length,
    debitPaise: debit,
    creditPaise: credit,
    firstDate: times.length ? new Date(Math.min(...times)) : null,
    lastDate: times.length ? new Date(Math.max(...times)) : null,
  };
}

/** The roles whose words the OCR safety layer judges (date/amount/marker confidence). */
const JUDGED_ROLES: ReadonlySet<ColumnRole> = new Set(["date", "description", "amount", "debit", "credit", "type"]);

export function columnOfWord(grid: CaptureGrid, word: OcrWord): number {
  const centre = (word.bbox.x0 + word.bbox.x1) / 2;
  return grid.columns.findIndex((c) => c.span != null && centre >= c.span.x0 && centre < c.span.x1);
}

/**
 * The OCR lines the safety layer should judge once columns are mapped: a transaction's words in a Balance, Reference
 * or Ignore column are not part of the import, so a doubtful balance can't flag the row (nor a neighbouring column's
 * word hide the missing marker after an amount). Lines and indexes stay exactly as they were.
 */
export function linesForMapping(grid: CaptureGrid, roles: readonly ColumnRole[], ocrLines: OcrLine[]): OcrLine[] {
  if (grid.method !== "positioned") return ocrLines;
  const data = new Set(grid.rows.map((r) => r.lineIndex));
  return ocrLines.map((line, i) => {
    if (!data.has(i)) return line;
    const words = line.words.filter((w) => {
      const c = columnOfWord(grid, w);
      return c < 0 || JUDGED_ROLES.has(roles[c]);
    });
    return { ...line, words };
  });
}
