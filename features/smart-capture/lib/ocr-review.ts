/**
 * OCR safety layer for Smart Capture. Runs after the normal text parser on
 * text that came from a screenshot and makes the review stricter:
 *
 *  - every OCR row gets a blocking `ocr_unverified` issue — the user must
 *    confirm they checked it against the image;
 *  - a date, amount or C/D (Cr/Dr) marker read below `LOW_CONFIDENCE` gets
 *    its own *strict* issue, cleared only by editing or confirming that field;
 *  - a row with no marker says plainly that its direction was inferred;
 *  - a sliver of a row cut off by the screenshot/crop edge is flagged and
 *    starts excluded (it is usually a partial copy of a neighbouring row);
 *  - two rows with the same date, merchant and amount are pointed out — but
 *    never merged or dropped, because same-amount purchases are real.
 *
 * Confidence only ever adds flags — a high score never removes one.
 */

import { matchLeadingDate, type CaptureIssue, type CaptureRow } from "./parse-pasted-statement";
import type { OcrBox, OcrLine, OcrWord } from "./tesseract-ocr";

/** Tesseract word confidence (0–100) below which a date/amount must be corrected or individually confirmed. */
export const LOW_CONFIDENCE = 85;

/** A line shorter than this fraction of the page's median line height is a sliver cut by the image edge. */
export const PARTIAL_LINE_RATIO = 0.6;

const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[.,]?$/i;
const AMOUNT_WORD = /(\d[\d,]*\.\d{1,2}|^(₹|rs\.?|inr)|^\d{1,3}(,\d{2,3})+)/i;
/** Cr/Dr, or a single-letter C/D in its own column — counted only after an amount (a "D" in a merchant name never is). */
const MARKER_WORD = /^(cr|dr|c|d)\.?$/i;
const ATTACHED_MARKER = /\d\.\d{2}(cr|dr|c|d)$/i;
const MARKER_COLUMN_WORD = /^(cr|dr|credit|debit|charge|c|d)\.?$/i;

function unionBox(boxes: OcrBox[]): OcrBox {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/** Leading words of a row's first line that make up its date ("05/09/2026", or "05", "Sep", "26"). */
function dateWords(words: OcrWord[]): OcrWord[] {
  const ordered = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const picked: OcrWord[] = [];
  for (const w of ordered) {
    if (picked.length >= 3) break;
    if (/\d/.test(w.text) && !AMOUNT_WORD.test(w.text)) picked.push(w);
    else if (MONTH_WORD.test(w.text) && picked.length > 0) picked.push(w);
    else break;
  }
  return picked;
}

/**
 * A date that isn't the first cell of the line: the words (up to three) that read as one whole date, wherever they
 * sit. Empty when none does — the caller must then treat the date as unchecked, never as fine.
 */
function findDateWords(words: OcrWord[]): OcrWord[] {
  const ordered = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  for (let start = 0; start < ordered.length; start++) {
    for (let len = Math.min(3, ordered.length - start); len >= 1; len--) {
      const run = ordered.slice(start, start + len);
      const text = run.map((w) => w.text).join(" ");
      if (matchLeadingDate(text)?.length === text.length) return run;
    }
  }
  return [];
}

/** `anywhere`: the row has a standalone Cr/Dr column that may sit before the amount, so a lone marker word counts wherever it is. */
function markerWords(line: OcrLine, anywhere = false): OcrWord[] {
  const ordered = [...line.words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const firstAmountX = ordered.find((w) => AMOUNT_WORD.test(w.text))?.bbox.x0;
  return ordered.filter((w, i) => {
    if (ATTACHED_MARKER.test(w.text)) return true;
    if (anywhere && MARKER_COLUMN_WORD.test(w.text)) return true;
    if (!MARKER_WORD.test(w.text)) return false;
    if (firstAmountX != null && w.bbox.x0 > firstAmountX) return true;
    // Last word right after a number — the C/D column even when the amount itself lost its decimal point ("43461 D").
    return i === ordered.length - 1 && i > 0 && /\d{3,}/.test(ordered[i - 1].text);
  });
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

const sameDay = (a: Date | null, b: Date | null) => a != null && b != null && a.getTime() === b.getTime();
const merchantKey = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

export function annotateOcrRows(rows: CaptureRow[], lines: OcrLine[]): CaptureRow[] {
  const typicalHeight = median(lines.map((l) => l.bbox.y1 - l.bbox.y0));

  const annotated = rows.map((row) => {
    const rowLines = lines.slice(row.lineStart, row.lineEnd + 1);
    if (rowLines.length === 0) return row;
    const words = rowLines.flatMap((l) => l.words);
    const issues: CaptureIssue[] = [...row.issues];
    const notes = [...row.notes];
    let suggestedInclude = row.suggestedInclude;

    const dateFirst = row.sourceOrder == null || row.sourceOrder[0] === "date";
    const date = dateFirst ? dateWords(rowLines[0].words) : findDateWords(rowLines[0].words);
    const amounts = words.filter((w) => AMOUNT_WORD.test(w.text));
    const markerColumn = row.sourceOrder?.includes("direction") ?? false;
    const markers = rowLines.flatMap((l) => markerWords(l, markerColumn));
    const lowDate = date.filter((w) => w.confidence < LOW_CONFIDENCE);
    const lowAmount = amounts.filter((w) => w.confidence < LOW_CONFIDENCE);
    const lowMarker = markers.filter((w) => w.confidence < LOW_CONFIDENCE);

    const firstHeight = rowLines[0].bbox.y1 - rowLines[0].bbox.y0;
    if (typicalHeight > 0 && firstHeight < typicalHeight * PARTIAL_LINE_RATIO) {
      suggestedInclude = false;
      issues.push({
        code: "partial_line",
        blocking: true,
        message: "This line looks cut off by the edge of the screenshot (it is much shorter than the other lines). It may be a partial copy of another row — check the image.",
      });
      notes.push("Cut-off line — starts excluded. Include it only if the image shows it is a separate transaction.");
    }

    if (!dateFirst && date.length === 0) {
      // The date sits in a later column and its words couldn't be located, so its read confidence is unknown.
      issues.push({
        code: "low_confidence_date",
        field: "date",
        strict: true,
        blocking: true,
        message: "The date is not in the first column and couldn't be matched to the screenshot's words — correct it or confirm it against the image.",
      });
    }
    if (lowDate.length > 0) {
      issues.push({
        code: "low_confidence_date",
        field: "date",
        strict: true,
        blocking: true,
        message: `Date read with low confidence ("${lowDate.map((w) => w.text).join(" ")}", ${pct(Math.min(...lowDate.map((w) => w.confidence)))}) — correct it or confirm it against the image.`,
      });
    }
    if (lowAmount.length > 0) {
      issues.push({
        code: "low_confidence_amount",
        field: "amount",
        strict: true,
        blocking: true,
        message: `Amount read with low confidence ("${lowAmount.map((w) => w.text).join(" ")}", ${pct(Math.min(...lowAmount.map((w) => w.confidence)))}) — correct it or confirm it against the image.`,
      });
    }
    if (lowMarker.length > 0) {
      issues.push({
        code: "low_confidence_direction",
        field: "direction",
        strict: true,
        blocking: true,
        message: `The C/D (Cr/Dr) marker was read with low confidence (${pct(Math.min(...lowMarker.map((w) => w.confidence)))}) — check Charge/Credit against the image.`,
      });
    }
    if (markers.length === 0 && row.direction != null && !issues.some((i) => i.code === "direction_unclear")) {
      issues.push({
        code: "direction_inferred",
        blocking: false,
        message: `No C/D (Cr/Dr) marker was read on this row — shown as a ${row.direction === "credit" ? "Credit" : "Charge"}. Check it against the image.`,
      });
    }
    issues.push({
      code: "ocr_unverified",
      blocking: true,
      message: "Read from a screenshot — check the date, amount and Charge/Credit against the image, then confirm.",
    });

    const checked = [...date, ...amounts, ...markers];
    return {
      ...row,
      issues,
      notes,
      suggestedInclude,
      confidence: "low" as const,
      ocr: {
        box: unionBox(rowLines.map((l) => l.bbox)),
        minConfidence: checked.length ? Math.min(...checked.map((w) => w.confidence)) : 0,
        lowConfidenceWords: [...lowDate, ...lowAmount].map((w) => w.text),
      },
    };
  });

  return flagRepeatedRows(annotated);
}

/**
 * Same date + merchant + amount appearing twice is either two real purchases or one row read twice (a sliver, an
 * overlapping crop). Never merged — the user decides — but each copy says so, and opposite directions are called out.
 */
export function flagRepeatedRows(rows: CaptureRow[]): CaptureRow[] {
  return rows.map((row) => {
    const twins = rows.filter((o) => o.id !== row.id && sameDay(o.date, row.date) && o.amount != null && o.amount === row.amount && merchantKey(o.description) === merchantKey(row.description));
    if (twins.length === 0) return row;
    const opposite = twins.some((t) => t.direction != null && row.direction != null && t.direction !== row.direction);
    const issue: CaptureIssue = {
      code: "possible_repeat",
      blocking: false,
      message: `Same date, merchant and amount as row ${twins.map((t) => t.id.replace(/^r/, "")).join(", ")}${opposite ? " but with the opposite Charge/Credit" : ""}. Both are kept — check the image that each is a separate transaction.`,
    };
    return { ...row, issues: [...row.issues, issue] };
  });
}
