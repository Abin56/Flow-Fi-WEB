/**
 * OCR safety layer for Smart Capture. Runs after the normal text parser on
 * text that came from a screenshot and makes the review stricter:
 *
 *  - an OCR row with strong, unambiguous evidence on every field (date,
 *    amount and a C/D marker — or the statement's own "only credits are
 *    marked" convention — all read clearly, nothing else flagged) needs no
 *    click at all — it goes straight to Ready;
 *  - a value word read unclearly is re-read on its own (tesseract-ocr.ts
 *    `recheck`); when that second, separate read agrees at a good
 *    confidence, the word counts as clearly read. When it disagrees, the
 *    field stays flagged and the user sees both readings;
 *  - a row that still needs a look gets exactly one open ask: a field-level
 *    fix/confirm when the problem is pinned to one field, otherwise a single
 *    generic `ocr_unverified` "check against the image" — never both;
 *  - a date, amount or C/D (Cr/Dr) marker read below `LOW_CONFIDENCE` gets
 *    its own *strict* issue, cleared only by editing or confirming that field;
 *  - a row with no marker says plainly that its direction was inferred;
 *  - a sliver of a row cut off by the screenshot/crop edge is flagged and
 *    starts excluded (it is usually a partial copy of a neighbouring row);
 *  - two rows with the same date, merchant and amount are pointed out — and
 *    always need their own look (blocking, never bulk-cleared), because
 *    same-amount purchases are real and must neither be silently merged nor
 *    silently imported twice.
 *
 * Evidence only decides whether a row needs the user; it never changes a
 * value, and a parser flag is never removed by a high score.
 */

import { FIELD_ISSUE_CODES, matchLeadingDate, type CaptureIssue, type CaptureRow } from "./parse-pasted-statement";
import type { OcrBox, OcrLine, OcrWord } from "./tesseract-ocr";

/** Tesseract word confidence (0–100) below which a date/amount must be corrected or individually confirmed. */
export const LOW_CONFIDENCE = 85;

/**
 * At/above this (and only this — see `annotateOcrRows` for the other conditions), OCR evidence on a row is strong
 * enough that it doesn't need its own "checked against the image" click. Deliberately not the only gate: a row also
 * needs a date, an amount and (when read) a Charge/Credit marker actually located on the line, and no other open
 * flag (a possible repeat, a cut-off line, merged lines, anything already strict) — a confidence score alone is
 * never trusted to wave through a genuine ambiguity.
 */
export const READY_CONFIDENCE = 90;

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

/** Text a word is compared by: case, surrounding space and a trailing full stop don't matter ("Dr." = "DR"). */
const tokenKey = (s: string) => s.trim().replace(/\.$/, "").toUpperCase();

/** A second, separate read of the word agrees with the first at a good confidence. */
function corroborated(w: OcrWord): boolean {
  return w.recheck != null && tokenKey(w.recheck.text) === tokenKey(w.text) && w.recheck.confidence >= LOW_CONFIDENCE;
}

/** The confidence a word is judged by: its own, or — when a second read agrees — the better of the two. */
function evidence(w: OcrWord): number {
  return corroborated(w) ? Math.max(w.confidence, w.recheck!.confidence) : w.confidence;
}

/** ` A second read saw "…".` when the second read of these words disagreed — so the user sees both readings. */
function secondReadNote(words: OcrWord[]): string {
  const other = words.filter((w) => w.recheck && w.recheck.text && tokenKey(w.recheck.text) !== tokenKey(w.text));
  return other.length ? ` A second read of the image saw "${other.map((w) => w.recheck!.text).join(" ")}".` : "";
}

const sameDay = (a: Date | null, b: Date | null) => a != null && b != null && a.getTime() === b.getTime();
const merchantKey = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

/**
 * `hasCreditMarkers`: the statement itself marks credits (some row reads "Cr"/"C"), so an unmarked row is a charge by
 * the statement's own convention — evidence for its direction when nothing unread sits after its amount.
 */
export function annotateOcrRows(rows: CaptureRow[], lines: OcrLine[], { hasCreditMarkers = false }: { hasCreditMarkers?: boolean } = {}): CaptureRow[] {
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
    const lowDate = date.filter((w) => evidence(w) < LOW_CONFIDENCE);
    const lowAmount = amounts.filter((w) => evidence(w) < LOW_CONFIDENCE);
    const lowMarker = markers.filter((w) => evidence(w) < LOW_CONFIDENCE);

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
        message: `Date read unclearly ("${lowDate.map((w) => w.text).join(" ")}", ${pct(Math.min(...lowDate.map((w) => w.confidence)))}).${secondReadNote(lowDate)}`,
      });
    }
    if (lowAmount.length > 0) {
      issues.push({
        code: "low_confidence_amount",
        field: "amount",
        strict: true,
        blocking: true,
        message: `Amount read unclearly ("${lowAmount.map((w) => w.text).join(" ")}", ${pct(Math.min(...lowAmount.map((w) => w.confidence)))}).${secondReadNote(lowAmount)}`,
      });
    }
    if (lowMarker.length > 0) {
      issues.push({
        code: "low_confidence_direction",
        field: "direction",
        strict: true,
        blocking: true,
        message: `C/D marker read unclearly ("${lowMarker.map((w) => w.text).join(" ")}", ${pct(Math.min(...lowMarker.map((w) => w.confidence)))}).${secondReadNote(lowMarker)}`,
      });
    }
    // Unmarked charge on a statement that marks its credits: supported by the statement's own convention — unless
    // something unread sits after the amount on its line (where a misread "Cr" would be).
    const lastAmount = [...amounts].sort((a, b) => a.bbox.x1 - b.bbox.x1).at(-1);
    const nothingAfterAmount =
      lastAmount != null && !words.some((w) => w !== lastAmount && w.bbox.x0 > lastAmount.bbox.x1 && Math.abs(w.bbox.y0 - lastAmount.bbox.y0) < lastAmount.bbox.y1 - lastAmount.bbox.y0);
    const byConvention = markers.length === 0 && hasCreditMarkers && row.direction === "debit" && nothingAfterAmount && !issues.some((i) => i.code === "direction_unclear");
    if (byConvention) {
      notes.push("No C/D marker — a Charge by this statement's own convention (only credits are marked).");
    } else if (markers.length === 0 && row.direction != null && !issues.some((i) => i.code === "direction_unclear")) {
      issues.push({
        code: "direction_inferred",
        blocking: false,
        message: `No C/D (Cr/Dr) marker was read on this row — shown as a ${row.direction === "credit" ? "Credit" : "Charge"}. Check it against the image.`,
      });
    }

    const checked = [...date, ...amounts, ...markers];
    const minConfidence = checked.length ? Math.min(...checked.map(evidence)) : 0;
    const blockingSoFar = issues.filter((i) => i.blocking);
    // A row whose only open problems are field-specific already has its one ask per field — a separate generic
    // check would be a second, redundant button for the same thing.
    const onlyFieldSpecific = blockingSoFar.length > 0 && blockingSoFar.every((i) => FIELD_ISSUE_CODES.has(i.code));
    const hasTwin = rows.some((o) => o.id !== row.id && sameDay(o.date, row.date) && o.amount != null && o.amount === row.amount && merchantKey(o.description) === merchantKey(row.description));
    // Direction needs its own evidence — a marker actually read on the line, or the statement's convention above.
    const directionEvidence = markers.length > 0 || byConvention;
    const reliable = blockingSoFar.length === 0 && !hasTwin && date.length > 0 && amounts.length > 0 && directionEvidence && minConfidence >= READY_CONFIDENCE;

    issues.push({
      code: "ocr_unverified",
      blocking: !reliable && !onlyFieldSpecific,
      message: reliable
        ? "Date, amount and Charge/Credit were all read clearly from the screenshot."
        : "Read from a screenshot — compare the date, amount and Charge/Credit with the image.",
    });

    return {
      ...row,
      issues,
      notes,
      suggestedInclude,
      confidence: "low" as const,
      ocr: {
        box: unionBox(rowLines.map((l) => l.bbox)),
        minConfidence,
        lowConfidenceWords: [...lowDate, ...lowAmount].map((w) => w.text),
        flaggedBoxes: [...lowDate, ...lowAmount, ...lowMarker].map((w) => w.bbox),
        secondRead: checked.filter((w) => w.confidence < LOW_CONFIDENCE && corroborated(w)).map((w) => w.text),
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
      blocking: true,
      message: `Same date, merchant and amount as row ${twins.map((t) => t.id.replace(/^r/, "")).join(", ")}${opposite ? " but with the opposite Charge/Credit" : ""}. Both are kept — check that each is a separate transaction.`,
    };
    return { ...row, issues: [...row.issues, issue] };
  });
}
