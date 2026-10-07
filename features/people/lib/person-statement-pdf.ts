/**
 * Portrait A4 People settlement statement — the PDF twin of the Share Statement preview, laid out as a
 * document (a bank / card statement), never a dashboard: no charts, no KPI tiles, one balance answer.
 * Rendered solely from `statementView`: every amount, label, type and status comes from the statement
 * engine through the shared presentation layer; nothing here does arithmetic on money (the only numbers
 * computed are layout coordinates).
 *
 * The statement is read by the person, so it never says "you": both parties are named ("Sojan owes Abin
 * John"). Palette: white paper, deep FlowFi green as the single brand accent, sage surfaces for structure,
 * grey for metadata, and semantic colour only on states that carry meaning (green = paid / settled, soft
 * red = due / overdue, amber = part-paid, blue-grey = carried forward). Every colour supports a word, so
 * the statement stays clear in greyscale print.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import {
  STATEMENT_COPY,
  statementSections,
  statementSummaryCells,
  statementView,
  type StatementViewOptions,
  type StatementViewRow,
} from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementStatusTone } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { splitCountLabel, type SplitAllocation } from "@/lib/split/split-allocation";

export function pdfSafe(text: string): string {
  return text.replace(/₹/g, "Rs. ").replace(/−/g, "-").replace(/[–—]/g, "-").replace(/→/g, "->").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

// ---- Palette (solid, PDF-safe; greys kept dark enough to survive print) ----
const INK = rgb(0.08, 0.09, 0.11);
const BODY = rgb(0.23, 0.25, 0.28);
const MUTED = rgb(0.36, 0.38, 0.41);
const RULE = rgb(0.84, 0.85, 0.86);
const RULE_STRONG = rgb(0.66, 0.68, 0.7);
const WHITE = rgb(1, 1, 1);
/** Deep FlowFi green: the brand mark, section accents and the ending balance. */
const FOREST = rgb(0.078, 0.263, 0.184);
const GREEN_TEXT = rgb(0.1, 0.38, 0.25);
const LIME = rgb(0.73, 0.96, 0.35);
const SAGE = rgb(0.955, 0.97, 0.958);
/** The split details' surface — lighter than SAGE, so the panel reads as secondary to its row. */
const SAGE_SOFT = rgb(0.967, 0.977, 0.969);
/** Between transactions: present, but quieter than any heading rule. */
const ROW_RULE = rgb(0.88, 0.89, 0.9);
const SAGE_RULE = rgb(0.8, 0.86, 0.82);
const FOCUS_TINT = rgb(0.925, 0.965, 0.89);
/** Very light blue-grey: the repeated column header and the carry-forward line. */
const HEAD_TINT = rgb(0.95, 0.957, 0.965);
const CARRY_TINT = rgb(0.962, 0.97, 0.978);
type Tone = { fill: RGB; text: RGB; edge: RGB };
const GREEN: Tone = { fill: rgb(0.9, 0.955, 0.92), text: rgb(0.07, 0.39, 0.22), edge: rgb(0.62, 0.8, 0.68) };
const RED: Tone = { fill: rgb(0.99, 0.928, 0.922), text: rgb(0.62, 0.13, 0.1), edge: rgb(0.9, 0.64, 0.62) };
const RED_STRONG: Tone = { fill: rgb(0.98, 0.87, 0.86), text: rgb(0.56, 0.07, 0.05), edge: rgb(0.8, 0.4, 0.37) };
const AMBER: Tone = { fill: rgb(1, 0.95, 0.86), text: rgb(0.45, 0.27, 0.02), edge: rgb(0.88, 0.71, 0.42) };
const SLATE: Tone = { fill: rgb(0.925, 0.94, 0.958), text: rgb(0.22, 0.31, 0.4), edge: rgb(0.68, 0.74, 0.8) };
const GREY: Tone = { fill: rgb(0.945, 0.948, 0.952), text: BODY, edge: RULE_STRONG };

/** Status badge: green = paid / settled, soft red = due, amber = part-paid, blue-grey = upcoming; the rest neutral. */
/** Status details that only restate a row's direction line plus its Paid / Remaining figures. */
const REPEATS_COLUMNS = new Set<SettlementStatusTone>(["due", "payable", "partial", "settled"]);

const STATUS: Record<SettlementStatusTone, Tone> = {
  due: RED,
  payable: RED,
  partial: AMBER,
  settled: GREEN,
  overdue: RED_STRONG,
  upcoming: SLATE,
  received: GREEN,
  paid: GREY,
  neutral: GREY,
};

/** Type roles (pt). Helvetica's figures are tabular, so amounts align; hierarchy comes from size and weight. */
const T = {
  title: 16.5,
  name: 12.5,
  section: 11,
  desc: 8.6,
  money: 8.2,
  label: 6.3,
  body: 7.6,
  meta: 7,
  support: 6.8,
  badge: 6.1,
} as const;

// ---- Page geometry (A4 portrait, 36pt side margins → 523.3pt usable) ----
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;
const M_TOP = 36;
const TABLE_W = PAGE_W - 2 * M;
const COLUMNS = [
  { label: "#", w: 20, align: "right" },
  { label: "Date", w: 54, align: "left" },
  { label: "Description", w: 0, align: "left" },
  { label: "Amount", w: 66, align: "right" },
  { label: "Paid", w: 58, align: "right" },
  { label: "Remaining", w: 68, align: "right" },
  { label: "Status", w: 80, align: "left" },
] as const;
/** Description takes whatever the fixed columns leave. */
const COL_W = COLUMNS.map((c) => (c.w === 0 ? TABLE_W - COLUMNS.reduce((s, x) => s + x.w, 0) : c.w));
const colX = (i: number) => M + COL_W.slice(0, i).reduce((s, w) => s + w, 0);
const PAD = 6;
const DESC_W = COL_W[2] - 2 * PAD;
const STATUS_W = COL_W[6] - 2 * PAD;
/** The footer rule's height; footer text sits below it. */
const FOOTER_RULE_Y = 32;
/** The lowest point any content may reach — every keep-together check uses this one floor. */
const CONTENT_BOTTOM = FOOTER_RULE_Y + 8;
const TITLE_LH = 10.4;
const SUPPORT_LH = 8.4;
/** Offsets (below a row's top) of its first baseline and of the line under the title block. */
const LINE1 = 12.5;
const LINE2_GAP = 11;
/** A month heading (label + rule). */
const MONTH_H = 19;
/** The THIS CYCLE divider. */
const SECTION_H = 20;
/** The carry-forward (Previous balance) row. */
const CARRY_H = 28;
/** Grid columns cap inside a portrait split panel (cells stay wide enough for "Name ₹amount"). */
const MAX_PANEL_COLS = 4;

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = pdfSafe(text);
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = `${t.slice(0, -4)}...`;
  return t;
}

const GENERATED = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Grid columns for N participants: one row up to 6, then two balanced rows (8 → 4 + 4), capped at 6 per row. */
export function allocationColumns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 6) return n;
  return Math.min(6, Math.ceil(n / 2));
}

/**
 * Renders the statement. `options` (the person's ledger entries, the whole-history statement, account
 * names and the owner's display name) only sharpen the wording — assigned vs split, payments made in a
 * later cycle, the account a payment moved through, who the owner is — and never change a figure.
 */
export async function renderPersonStatementPdf(statement: PersonCycleStatement, options: StatementViewOptions = {}): Promise<Uint8Array> {
  const view = statementView(statement, options);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${view.personName} - People Statement - ${view.cycleLabel}`));
  doc.setAuthor(pdfSafe(view.ownerName));
  doc.setProducer("FlowFi");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const first = view.personName.split(" ")[0];
  const settled = view.direction === "settled";
  const ZERO = money(0);
  const generated = GENERATED.format(options.now ?? new Date());

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M_TOP;

  const width = (s: string, size: number, font: PDFFont = regular) => font.widthOfTextAtSize(pdfSafe(s), size);
  const text = (s: string, x: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    page.drawText(pdfSafe(s), { x, y: yy, size, font, color });
  const textRight = (s: string, right: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    text(s, right - width(s, size, font), yy, size, font, color);
  const box = (x: number, yy: number, w: number, h: number, fill: RGB, border?: RGB, borderWidth = 0.6) =>
    page.drawRectangle({ x, y: yy, width: w, height: h, color: fill, ...(border ? { borderColor: border, borderWidth } : {}) });
  /** A softly rounded rectangle (bottom-left at x, yy). */
  const roundBox = (x: number, yy: number, w: number, h: number, r: number, fill: RGB, border?: RGB, borderWidth = 0.6) => {
    const rr = Math.min(r, w / 2, h / 2);
    const path = `M ${rr} 0 H ${w - rr} A ${rr} ${rr} 0 0 1 ${w} ${rr} V ${h - rr} A ${rr} ${rr} 0 0 1 ${w - rr} ${h} H ${rr} A ${rr} ${rr} 0 0 1 0 ${h - rr} V ${rr} A ${rr} ${rr} 0 0 1 ${rr} 0 Z`;
    page.drawSvgPath(path, { x, y: yy + h, color: fill, ...(border ? { borderColor: border, borderWidth } : {}) });
  };
  const vline = (x: number, top: number, bottom: number, color = RULE, thickness = 0.5) =>
    page.drawLine({ start: { x, y: bottom }, end: { x, y: top }, thickness, color });
  const hline = (x0: number, x1: number, yy: number, color = RULE, thickness = 0.5) => page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness, color });
  /** Steps a size down (never below `min`) until `s` fits `maxW` — large values are never cut. */
  const sizeToFit = (s: string, size: number, font: PDFFont, maxW: number, min = 5.5) => {
    let sz = size;
    while (sz > min && width(s, sz, font) > maxW) sz -= 0.25;
    return sz;
  };
  const amountRight = (s: string, right: number, yy: number, size: number, font: PDFFont, color: RGB, colW: number) =>
    textRight(s, right, yy, sizeToFit(s, size, font, colW - 2 * PAD), font, color);
  const pillWidth = (label: string, size: number = T.badge) => bold.widthOfTextAtSize(pdfSafe(label), size) + 9;
  /** A small rounded badge whose text baseline is `yy`. */
  const pill = (label: string, x: number, yy: number, tone: Tone, size: number = T.badge) => {
    const w = pillWidth(label, size);
    roundBox(x, yy - 3.2, w, size + 5.6, 2.6, tone.fill, tone.edge, 0.5);
    text(label, x + 4.5, yy, size, bold, tone.text);
    return w;
  };

  /**
   * Word wrap that never truncates: a word wider than the line is broken by characters. `firstW` lets the
   * first line run beside something (a badge) while later lines take the full width.
   */
  const wrapWords = (label: string, w: number, font: PDFFont, size: number, firstW = w): string[] => {
    const lines: string[] = [];
    const limit = () => (lines.length === 0 ? firstW : w);
    let cur = "";
    // "Rs. 5,000" is one unit (a no-break space while wrapping), so an amount never splits across lines, and a
    // " · " separator stays at the end of its line instead of starting the next.
    const units = pdfSafe(label.replace(/\s+/g, " ")).replace(/Rs\. /g, "Rs. ").replace(/ · /g, " ·  ");
    for (const word of units.split(/ +/).filter(Boolean)) {
      let piece = word;
      while (font.widthOfTextAtSize(piece, size) > limit() && !cur) {
        let n = piece.length - 1;
        while (n > 1 && font.widthOfTextAtSize(piece.slice(0, n), size) > limit()) n -= 1;
        lines.push(piece.slice(0, n));
        piece = piece.slice(n);
      }
      const next = cur ? `${cur} ${piece}` : piece;
      if (font.widthOfTextAtSize(next, size) <= limit()) cur = next;
      else {
        lines.push(cur);
        cur = piece;
        while (font.widthOfTextAtSize(cur, size) > limit()) {
          let n = cur.length - 1;
          while (n > 1 && font.widthOfTextAtSize(cur.slice(0, n), size) > limit()) n -= 1;
          lines.push(cur.slice(0, n));
          cur = cur.slice(n);
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines.map((l) => l.replace(/ /g, " ")) : [""];
  };
  /** Keeps at most `max` lines; the last kept line carries the rest, shortened with "...". */
  const capLines = (lines: string[], max: number, font: PDFFont, size: number, w: number) =>
    lines.length <= max ? lines : [...lines.slice(0, max - 1), fit(lines.slice(max - 1).join(" "), font, size, w)];

  // ---------------- Header (first page) ----------------
  const BAL_W = 200;
  const drawHeader = () => {
    const top = y;
    // Brand row: wordmark + tagline over a hairline with a short green accent.
    text("FlowFi", M, top - 13, 14, bold, FOREST);
    text("People · Expenses · Settle Up", M, top - 23, 6.6, regular, MUTED);
    textRight("PEOPLE STATEMENT", M + TABLE_W, top - 13, T.label - 0.2, bold, MUTED);
    textRight(`Generated ${generated}`, M + TABLE_W, top - 23, 6.6, regular, MUTED);
    hline(M, M + TABLE_W, top - 31, RULE, 0.5);
    box(M, top - 31.75, 36, 1.5, FOREST);

    // Title, then who and which period as labelled fields, then who prepared it.
    const leftW = TABLE_W - BAL_W - 22;
    text("People Settlement Statement", M, top - 56, sizeToFit("People Settlement Statement", T.title, bold, leftW), bold, INK);
    const fieldW = leftW / 2 - 8;
    text("STATEMENT FOR", M, top - 74, T.label - 0.4, bold, MUTED);
    text(fit(view.personName, bold, T.name - 0.5, fieldW), M, top - 87, sizeToFit(view.personName, T.name - 0.5, bold, fieldW, 8.5), bold, INK);
    const px = M + leftW / 2;
    text("PERIOD", px, top - 74, T.label - 0.4, bold, MUTED);
    text(fit(view.cycleLabel, regular, 9.6, fieldW), px, top - 87, sizeToFit(view.cycleLabel, 9.6, regular, fieldW, 7), regular, INK);
    text(fit(`Prepared by ${view.ownerName}`, regular, T.meta, leftW), M, top - 103, T.meta, regular, MUTED);

    // The answer: one balance block, the strongest thing on the page.
    const bx = M + TABLE_W - BAL_W;
    const bTop = top - 42;
    const bH = 66;
    box(bx, bTop - bH, BAL_W, bH, SAGE);
    box(bx, bTop - bH, 3, bH, FOREST);
    const inner = BAL_W - 32;
    text(settled ? "SETTLED" : "BALANCE DUE", bx + 17, bTop - 15, T.label + 0.2, bold, GREEN_TEXT);
    text(view.amount, bx + 17, bTop - 41, sizeToFit(view.amount, 25, bold, inner, 10), bold, settled ? GREEN.text : INK);
    const line = settled ? "Nothing left to settle" : view.headline;
    const lineSize = sizeToFit(line, 8.8, regular, inner, 6.5);
    text(fit(line, regular, lineSize, inner), bx + 17, bTop - 56, lineSize, regular, BODY);
    y = bTop - bH - 16;
  };

  // ---------------- Statement summary (the cycle's reconciliation, one strip) ----------------
  const drawSummary = () => {
    const cells = statementSummaryCells(view);
    const h = 42;
    const currentW = 108;
    const restW = (TABLE_W - currentW) / (cells.length - 1);
    hline(M, M + TABLE_W, y, RULE_STRONG, 0.5);
    hline(M, M + TABLE_W, y - h, RULE, 0.5);
    let x = M;
    cells.forEach((c, i) => {
      const w = c.current ? currentW : restW;
      if (c.current) box(x, y - h + 0.25, w, h - 0.5, SAGE);
      else if (i > 0) vline(x, y - 9, y - h + 9, ROW_RULE, 0.5);
      const tx = x + (i === 0 ? 0 : 10);
      const cw = w - (i === 0 ? 8 : 14);
      text(fit(c.label.toUpperCase(), bold, T.label - 0.2, cw), tx, y - 11.5, T.label - 0.2, bold, c.current ? FOREST : MUTED);
      const zero = c.value === ZERO;
      const size = sizeToFit(c.value, c.current ? 12 : 9.6, bold, cw, 6.5);
      const color = c.current ? (settled ? GREEN.text : FOREST) : zero ? MUTED : c.advance ? GREEN.text : INK;
      text(c.value, tx, y - 24.5, size, zero && !c.current ? regular : bold, color);
      if (c.note) text(fit(c.note, regular, 6.1, cw), tx, y - 34, 6.1, regular, MUTED);
      x += w;
    });
    y -= h;
    if (view.cashNote) {
      textRight(fit(view.cashNote, regular, T.meta, TABLE_W), M + TABLE_W, y - 10, T.meta, regular, MUTED);
      y -= 10;
    }
  };

  // ---------------- Continued header + table header (repeated on every page) ----------------
  /** Pages after the first: compact, but enough context that a printed page stands on its own. */
  const drawContinued = () => {
    text("FlowFi", M, y - 10, 9, bold, FOREST);
    const lead = width("FlowFi", 9, bold) + 8;
    const pending = `${view.current.label} ${view.current.value}`;
    const pendingW = width(pending, 8.4, bold);
    text(fit(`People Settlement Statement  ·  ${view.personName}`, regular, 7.4, TABLE_W - lead - pendingW - 16), M + lead, y - 10, 7.4, regular, BODY);
    textRight(pending, M + TABLE_W, y - 10, 8.4, bold, settled ? GREEN.text : FOREST);
    text(fit(view.cycleLabel, regular, 6.8, TABLE_W - 80), M + lead, y - 19.5, 6.8, regular, MUTED);
    textRight("continued", M + TABLE_W, y - 19.5, 6.6, regular, MUTED);
    hline(M, M + TABLE_W, y - 26, RULE, 0.5);
    y -= 34;
  };
  const drawTableHeader = () => {
    const h = 16;
    box(M, y - h, TABLE_W, h, HEAD_TINT);
    hline(M, M + TABLE_W, y - h, RULE_STRONG, 0.5);
    COLUMNS.forEach((c, i) => {
      const x = colX(i);
      const label = c.label.toUpperCase();
      if (c.align === "right") textRight(label, x + COL_W[i] - PAD, y - 10.4, T.label - 0.2, bold, MUTED);
      else text(label, x + PAD, y - 10.4, T.label - 0.2, bold, MUTED);
    });
    y -= h;
  };

  const newPage = (withTableHeader: boolean) => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M_TOP;
    drawContinued();
    if (withTableHeader) drawTableHeader();
  };
  const ensure = (h: number, withTableHeader = true) => {
    // A unit (a transaction with its details, or a heading with its first transaction) is never split across pages.
    if (y - h < CONTENT_BOTTOM) newPage(withTableHeader);
  };

  /**
   * "Total price ₹4,000 · 4-way split · Amma's share ₹1,000" as one or more lines that fit `width`:
   * the bold total leads the first line, and the remaining " · " parts flow on, wrapping whole.
   * Only for a legacy split whose Expense isn't available (no full breakdown to draw).
   */
  const NOTE_SIZE = T.support;
  const wrapSplitNote = (note: string, w: number): { head: string; rest: string }[] => {
    const [head, ...parts] = note.split(" · ");
    const lines: { head: string; rest: string }[] = [{ head, rest: "" }];
    for (const part of parts) {
      const cur = lines[lines.length - 1];
      const candidate = cur.head || cur.rest ? `${cur.rest} · ${part}` : part;
      const used = (cur.head ? width(cur.head, NOTE_SIZE, bold) : 0) + width(candidate, NOTE_SIZE);
      if (used <= w) cur.rest = candidate;
      else lines.push({ head: "", rest: part });
    }
    return lines;
  };

  // ---------------- Split details (part of its row) ----------------
  // Genuine splits (2+ people) get a light sage panel: the bill and who owes what on one line, then every stored
  // allocation as "Name ₹amount", the recipient's cell tinted. An expense assigned in full (or a legacy one
  // without participants) needs no panel — one detail line in the description says it all.
  const PANEL_X = colX(2) + PAD - 4;
  const PANEL_W = M + TABLE_W - PAD - PANEL_X;
  const PANEL_HEAD = 15;
  const NAME_SIZE = 7.2;
  const NAME_LH = 8.4;
  const AMOUNT_SIZE = 7.6;
  const DETAIL_LABEL = T.label - 0.4;
  const isCompact = (a: SplitAllocation) => a.participants.length <= 1;
  const layoutAllocation = (a: SplitAllocation) => {
    const n = a.participants.length;
    const cols = Math.min(MAX_PANEL_COLS, allocationColumns(n));
    const cellW = PANEL_W / Math.max(1, cols);
    const fontOf = (focus: boolean) => (focus ? bold : regular);
    // "Name ₹amount" on one line while every name's words fit beside the amount; otherwise each cell
    // stacks the name (wrapped by word) above its amount, so no name is ever broken or hidden.
    const inlineFits = a.participants.every((p) => {
      const room = cellW - 2 * PAD - width(money(p.amount), AMOUNT_SIZE, bold) - 6;
      return pdfSafe(p.label)
        .split(/\s+/)
        .every((word) => fontOf(p.isFocus).widthOfTextAtSize(word, NAME_SIZE) <= room);
    });
    const names = a.participants.map((p) =>
      wrapWords(p.label, inlineFits ? cellW - 2 * PAD - width(money(p.amount), AMOUNT_SIZE, bold) - 6 : cellW - 2 * PAD, fontOf(p.isFocus), NAME_SIZE),
    );
    const gridRows = Math.ceil(n / cols);
    const rowHeights = Array.from({ length: gridRows }, (_, r) => {
      const lines = Math.max(1, ...names.slice(r * cols, r * cols + cols).map((l) => l.length));
      return 4.5 + lines * NAME_LH + (inlineFits ? 0 : 9) + 2;
    });
    const gridH = rowHeights.reduce((s, h) => s + h, 0);
    const mismatch = a.reconciles || n === 0 ? 0 : 11;
    const panelH = PANEL_HEAD + gridH + mismatch;
    return { cols, cellW, names, rowHeights, inlineFits, panelH };
  };
  /** Draws "ORIGINAL PURCHASE ₹882.96 · 4-way split" from `x`; returns where it ends. */
  const purchaseLine = (a: SplitAllocation, x: number, yy: number, tail: string | null) => {
    text("ORIGINAL PURCHASE", x, yy, DETAIL_LABEL, bold, MUTED);
    x += width("ORIGINAL PURCHASE", DETAIL_LABEL, bold) + 4;
    const original = money(a.original);
    text(original, x, yy, 7.6, bold, INK);
    x += width(original, 7.6, bold);
    if (tail) {
      x += 5;
      text("·", x, yy, 7, regular, MUTED);
      x += width("·", 7) + 5;
      text(tail, x, yy, 7, regular, BODY);
      x += width(tail, 7);
    }
    return x;
  };
  const drawAllocation = (a: SplitAllocation, l: ReturnType<typeof layoutAllocation>, top: number, row: StatementViewRow) => {
    box(PANEL_X, top - l.panelH, PANEL_W, l.panelH, SAGE_SOFT);
    box(PANEL_X, top - l.panelH, 1.5, l.panelH, SAGE_RULE);
    const hx = PANEL_X + PAD;
    const hy = top - 10;
    // Header: SPLIT DETAILS  ORIGINAL PURCHASE ₹882.96 · 4-way split ………… Sojan owes Abin ₹220.74
    text("SPLIT DETAILS", hx, hy, DETAIL_LABEL, bold, GREEN_TEXT);
    const x = purchaseLine(a, hx + width("SPLIT DETAILS", DETAIL_LABEL, bold) + 10, hy, splitCountLabel(a));
    if (row.statusDetail) {
      const room = PANEL_X + PANEL_W - PAD - x - 14;
      const tone = STATUS[row.statusTone];
      const color = tone === GREY ? INK : tone.text;
      if (room > 30) textRight(fit(row.statusDetail, bold, 7.2, room), PANEL_X + PANEL_W - PAD, hy, 7.2, bold, color);
    }
    let rowTop = top - PANEL_HEAD;
    hline(PANEL_X + PAD, PANEL_X + PANEL_W - PAD, rowTop, SAGE_RULE, 0.4);
    for (let r = 0; r < l.rowHeights.length; r += 1) {
      const rh = l.rowHeights[r];
      if (r > 0) hline(PANEL_X + PAD, PANEL_X + PANEL_W - PAD, rowTop, SAGE_RULE, 0.3);
      a.participants.slice(r * l.cols, r * l.cols + l.cols).forEach((p, c) => {
        const i = r * l.cols + c;
        const cx = PANEL_X + c * l.cellW;
        if (p.isFocus) box(cx + 0.5, rowTop - rh + 0.5, l.cellW - 1, rh - 1, FOCUS_TINT);
        let ty = rowTop - 4.5 - NAME_SIZE + 0.6;
        const nameFont = p.isFocus ? bold : regular;
        for (const line of l.names[i]) {
          text(line, cx + PAD, ty, NAME_SIZE, nameFont, p.isFocus ? INK : BODY);
          ty -= NAME_LH;
        }
        const amount = money(p.amount);
        const amountColor = p.amount === 0 ? MUTED : INK;
        if (l.inlineFits) textRight(amount, cx + l.cellW - PAD, rowTop - 4.5 - NAME_SIZE + 0.6, AMOUNT_SIZE, bold, amountColor);
        else text(amount, cx + PAD, ty - 0.6, AMOUNT_SIZE, bold, amountColor);
      });
      rowTop -= rh;
    }
    if (!a.reconciles) text(`Allocated ${money(a.allocated)} of ${money(a.original)}`, hx, top - l.panelH + 4, T.meta - 0.4, regular, MUTED);
  };

  // ---------------- Rows ----------------
  // Each transaction is one unit: the description leads (bold), then a quiet meta line (type · cycle), then the
  // direction note; money sits right-aligned in its columns; the status pill and its detail on the right.
  const META_SIZE = 6.7;
  const META_LH = 8.6;
  const layoutRow = (row: StatementViewRow) => {
    const a = row.allocation ?? null;
    const compact = a != null && isCompact(a);
    const strip = a && !compact ? layoutAllocation(a) : null;
    const titleLines = capLines(wrapWords(row.title, DESC_W, bold, T.desc), 3, bold, T.desc, DESC_W);
    const typeLabel = fit(row.typeLabel, regular, META_SIZE, DESC_W);
    const typeW = width(typeLabel, META_SIZE);
    const from = row.carried && row.fromCycle ? `From ${row.fromCycle}` : "";
    const sepW = width("  ·  ", META_SIZE);
    const besideW = DESC_W - typeW - sepW;
    const fromBeside = from !== "" && width(from.split(" ")[0], META_SIZE) <= besideW;
    const fromLines = from ? wrapWords(from, DESC_W, regular, META_SIZE, fromBeside ? besideW : DESC_W) : [];
    // A split drawn with its details needs no "Sojan's share of a split expense": the type, the Amount caption
    // and the tinted cell already say it.
    const relation = a && row.kind === "split" ? "" : row.relation;
    const relationLines = relation ? capLines(wrapWords(relation, DESC_W, regular, T.support), 2, regular, T.support, DESC_W) : [];
    const splitLines = row.splitNote && !a ? wrapSplitNote(row.splitNote, DESC_W) : [];
    // An expense assigned to one person is a plain transaction: its Amount already is that person's amount, so
    // no bill line, no share caption. Only a legacy split without its participant list keeps one bill line
    // ("ORIGINAL PURCHASE ₹750 · Split expense") — the one place its purchase total appears — and stored
    // allocations that don't add up still say so.
    const assignedOnly = compact && a.participants.length === 1;
    const billLine = compact && a.participants.length === 0;
    const mismatch = compact && !a.reconciles && a.participants.length > 0;
    const compactLines = (billLine ? 1 : 0) + (mismatch ? 1 : 0);
    const metaOffset = LINE1 + (titleLines.length - 1) * TITLE_LH + 10;
    const metaLines = fromBeside ? fromLines.length : 1 + fromLines.length;
    const descBottom =
      metaOffset + (Math.max(1, metaLines) - 1) * META_LH + (relationLines.length + splitLines.length) * SUPPORT_LH + (compactLines ? compactLines * SUPPORT_LH + 2 : 0);
    // The status detail sits under the pill — unless the split panel states it, or it would only repeat the
    // direction line beside it and the Paid / Remaining figures ("AMMA owes ABIN ₹50.59").
    const repeatsRow = relationLines.length > 0 && REPEATS_COLUMNS.has(row.statusTone);
    const statusLines =
      row.statusDetail && !strip && !repeatsRow ? capLines(wrapWords(row.statusDetail, STATUS_W, regular, T.support), 3, regular, T.support, STATUS_W) : [];
    const statusBottom = LINE1 + LINE2_GAP + (statusLines.length - 1) * SUPPORT_LH;
    const amountBottom = LINE1 + 9;
    const mainH = Math.max(descBottom, statusBottom, amountBottom) + 9;
    const h = mainH + (strip ? strip.panelH + 9 : 0);
    return { a, assignedOnly, billLine, strip, titleLines, typeLabel, typeW, sepW, fromLines, fromBeside, relationLines, splitLines, mismatch, metaOffset, statusLines, mainH, h };
  };
  const drawRow = (row: StatementViewRow) => {
    const l = layoutRow(row);
    ensure(l.h);
    const top = y;
    const line1 = top - LINE1;
    const line2 = top - LINE1 - 9;
    // # and date
    textRight(row.no, colX(0) + COL_W[0] - PAD, line1, T.meta, regular, MUTED);
    text(row.date, colX(1) + PAD, line1, T.body, regular, BODY);
    // Description: title, then type · cycle, then the direction note.
    const dx = colX(2) + PAD;
    l.titleLines.forEach((t, ti) => text(t, dx, line1 - ti * TITLE_LH, T.desc, bold, INK));
    let ly = top - l.metaOffset;
    text(l.typeLabel, dx, ly, META_SIZE, regular, GREEN_TEXT);
    l.fromLines.forEach((f, fi) => {
      if (fi === 0 && l.fromBeside) {
        text("  ·  ", dx + l.typeW, ly, META_SIZE, regular, MUTED);
        text(f, dx + l.typeW + l.sepW, ly, META_SIZE, regular, MUTED);
      } else {
        ly -= META_LH;
        text(f, dx, ly, META_SIZE, regular, MUTED);
      }
    });
    l.relationLines.forEach((r) => {
      ly -= SUPPORT_LH;
      text(r, dx, ly, T.support, regular, MUTED);
    });
    l.splitLines.forEach((sl) => {
      ly -= SUPPORT_LH;
      if (sl.head) {
        const headW = width(sl.head, NOTE_SIZE, bold);
        text(sl.head, dx, ly, NOTE_SIZE, bold, INK);
        if (sl.rest) text(fit(sl.rest, regular, NOTE_SIZE, DESC_W - headW), dx + headW, ly, NOTE_SIZE, regular, MUTED);
      } else text(fit(sl.rest, regular, NOTE_SIZE, DESC_W), dx, ly, NOTE_SIZE, regular, MUTED);
    });
    if (l.a && l.billLine) {
      ly -= SUPPORT_LH + 2;
      purchaseLine(l.a, dx, ly, splitCountLabel(l.a));
    }
    if (l.a && l.mismatch) {
      ly -= SUPPORT_LH;
      text(`Allocated ${money(l.a.allocated)} of ${money(l.a.original)}`, dx, ly, T.meta - 0.4, regular, MUTED);
    }
    // Amount (named for whose share it is), Paid (context), Remaining (the figure that matters).
    const right = (i: number) => colX(i) + COL_W[i] - PAD;
    if (row.original) {
      amountRight(row.original, right(3), line1, T.money, bold, INK, COL_W[3]);
      if (row.amountLabel !== "Amount" && !l.assignedOnly) textRight(fit(row.amountLabel, regular, T.support - 0.4, COL_W[3] - 2 * PAD), right(3), line2, T.support - 0.4, regular, MUTED);
    } else textRight("-", right(3), line1, T.money, regular, MUTED);
    if (row.paid) amountRight(row.paid, right(4), line1, T.money, regular, row.paid === ZERO ? MUTED : BODY, COL_W[4]);
    else textRight("-", right(4), line1, T.money, regular, MUTED);
    if (row.remaining) {
      const zero = row.remaining === ZERO;
      const tone = zero ? MUTED : row.statusTone === "overdue" ? RED.text : INK;
      amountRight(row.remaining, right(5), line1, zero ? T.money : T.money + 0.4, zero ? regular : bold, tone, COL_W[5]);
    } else textRight("-", right(5), line1, T.money, regular, MUTED);
    // Status pill + its detail.
    pill(fit(row.status, bold, T.badge, STATUS_W - 9), colX(6) + PAD, line1, STATUS[row.statusTone]);
    l.statusLines.forEach((s, si) => text(s, colX(6) + PAD, top - LINE1 - LINE2_GAP - si * SUPPORT_LH, T.support, regular, MUTED));
    if (l.strip && l.a) drawAllocation(l.a, l.strip, top - l.mainH + 2, row);
    y = top - l.h;
    hline(M, M + TABLE_W, y, ROW_RULE, 0.5);
  };

  // ---------------- Section dividers (each kept with what follows it) ----------------
  /** The carry-forward line: the previous balance on its own, before the obligations it is made of. */
  const { previous, showPrevious, byMonth } = statementSections(view);
  const carryRow = (next: number) => {
    ensure(CARRY_H + next);
    box(M, y - CARRY_H, TABLE_W, CARRY_H, CARRY_TINT);
    box(M, y - CARRY_H, 2.4, CARRY_H, SLATE.edge);
    hline(M, M + TABLE_W, y - CARRY_H, RULE, 0.5);
    text(STATEMENT_COPY.carried.label.toUpperCase(), M + PAD + 2, y - 12, T.label + 0.4, bold, SLATE.text);
    const note = [STATEMENT_COPY.carried.note, previous?.side].filter(Boolean).join("  ·  ");
    text(fit(note, regular, T.support, colX(3) - M - 2 * PAD), M + PAD + 2, y - 21, T.support, regular, MUTED);
    if (previous) amountRight(previous.value, colX(5) + COL_W[5] - PAD, y - 12, T.money + 0.6, bold, INK, COL_W[5]);
    pill("Carry forward", colX(6) + PAD, y - 12, SLATE);
    y -= CARRY_H;
  };
  /** THIS CYCLE: a section divider (label, the cycle, a green rule) — and, when nothing is new, the notice itself. */
  const cycleBand = (note: string, next: number) => {
    ensure(10 + SECTION_H + next);
    y -= 10;
    const l = STATEMENT_COPY.current.toUpperCase();
    text(l, M + 1, y - 10, T.label + 0.6, bold, FOREST);
    const lw = width(l, T.label + 0.6, bold);
    text(fit(note, regular, T.meta, TABLE_W - lw - 12), M + 1 + lw + 10, y - 10, T.meta, regular, BODY);
    hline(M, M + TABLE_W, y - 15, FOREST, 0.8);
    y -= SECTION_H;
  };
  /** Month heading: a small uppercase label and a thin sage rule — enough to scan by, never a block. */
  const monthHeading = (month: string, next: number) => {
    ensure(MONTH_H + next);
    const m = month.toUpperCase();
    text(m, M + 1, y - 13, T.label + 0.3, bold, GREEN_TEXT);
    hline(M + width(m, T.label + 0.3, bold) + 10, M + TABLE_W, y - 10.8, SAGE_RULE, 0.5);
    y -= MONTH_H;
  };
  const allRows = [...view.carried, ...view.rows];
  const drawRows = (rows: StatementViewRow[]) => {
    let month: string | null = null;
    for (const r of rows) {
      if (byMonth && r.month !== month) {
        monthHeading(r.month, layoutRow(r).h);
        month = r.month;
      }
      drawRow(r);
    }
  };
  const firstUnit = (rows: StatementViewRow[]) => (rows.length === 0 ? 0 : (byMonth ? MONTH_H : 0) + layoutRow(rows[0]).h);

  // ---------------- Compose ----------------
  drawHeader();
  drawSummary();
  y -= 20;
  const count = allRows.length;
  text("Transactions", M, y - 9, T.section, bold, INK);
  text(`${count} ${count === 1 ? "item" : "items"}  ·  Paid and remaining as of ${view.asOf}`, M, y - 20, T.meta, regular, MUTED);
  y -= 27;
  drawTableHeader();
  const emptyNote = `${view.cycleLabel}  ·  ${STATEMENT_COPY.empty}`;
  if (showPrevious) {
    carryRow(firstUnit(view.carried));
    drawRows(view.carried);
    cycleBand(view.rows.length ? view.cycleLabel : emptyNote, firstUnit(view.rows));
  } else if (view.rows.length === 0) cycleBand(emptyNote, 0);
  if (view.rows.length > 0) drawRows(view.rows);

  // ---------------- Payment history (grouped by real payment) ----------------
  if (view.payments.length > 0) {
    const AMOUNT_RIGHT = M + TABLE_W - PAD;
    const APPLIED_RIGHT = M + 380;
    const LABEL_X = M + 64;
    const paymentH = (p: (typeof view.payments)[number]) => (p.single != null ? 26 : 20 + p.applied.length * 10 + 16 + (p.held ? 12 : 0));
    // The heading never sits alone at a page foot: it moves with the first payment.
    ensure(22 + 20 + paymentH(view.payments[0]), false);
    y -= 22;
    text("Payment history", M, y - 9, T.section, bold, INK);
    text("This cycle", M + width("Payment history", T.section, bold) + 8, y - 9, T.meta, regular, MUTED);
    y -= 15;
    box(M, y - 15, TABLE_W, 15, HEAD_TINT);
    hline(M, M + TABLE_W, y - 15, RULE_STRONG, 0.5);
    text("DATE", M + PAD, y - 10, T.label - 0.2, bold, MUTED);
    text("PAYMENT", LABEL_X, y - 10, T.label - 0.2, bold, MUTED);
    textRight("AMOUNT", AMOUNT_RIGHT, y - 10, T.label - 0.2, bold, MUTED);
    y -= 15;
    for (const p of view.payments) {
      const h = paymentH(p);
      ensure(h + 1, false);
      text(p.date, M + PAD, y - 12, T.body, regular, BODY);
      text(fit(`${p.label}${p.account ? `  ·  ${p.account}` : ""}`, bold, T.body + 0.2, AMOUNT_RIGHT - LABEL_X - 90), LABEL_X, y - 12, T.body + 0.2, bold, INK);
      textRight(p.amount, AMOUNT_RIGHT, y - 12, T.money + 0.2, bold, p.inbound ? GREEN.text : INK);
      if (p.single != null) {
        text(fit(p.single, regular, T.meta, AMOUNT_RIGHT - LABEL_X - 90), LABEL_X, y - 21, T.meta, regular, MUTED);
      } else {
        let ly = y - 23;
        text("APPLIED TO", LABEL_X, ly, T.label - 0.2, bold, MUTED);
        ly -= 9.5;
        for (const a of p.applied) {
          text(fit(`+  ${a.label}`, regular, 7, APPLIED_RIGHT - LABEL_X - 70), LABEL_X + 6, ly, 7, regular, INK);
          textRight(a.amount, APPLIED_RIGHT, ly, 7, regular, INK);
          ly -= 10;
        }
        hline(LABEL_X, APPLIED_RIGHT, ly + 7, RULE, 0.5);
        text("Applied", LABEL_X + 6, ly - 1, 7, bold, INK);
        textRight(p.appliedTotal ?? "", APPLIED_RIGHT, ly - 1, 7, bold, INK);
        if (p.held) {
          ly -= 12;
          text("Held as advance", LABEL_X + 6, ly, 7, bold, GREEN.text);
          textRight(p.held, APPLIED_RIGHT, ly, 7, bold, GREEN.text);
        }
      }
      y -= h;
      hline(M, M + TABLE_W, y, RULE, 0.5);
    }
    const totals = [view.totalReceived && `Total paid by ${first}  ${view.totalReceived}`, view.totalPaid && `Total paid by ${view.ownerShort}  ${view.totalPaid}`].filter(Boolean) as string[];
    for (const t of totals) {
      ensure(13, false);
      y -= 12;
      textRight(t, AMOUNT_RIGHT, y, T.body + 0.4, bold, INK);
    }
  }

  // ---------------- Ending balance ----------------
  // The statement's conclusion: a deep-green band repeating the answer in full. Always drawn: when the full
  // band doesn't fit, a one-line band takes the remaining room, and only when neither fits does it move to
  // the next page (under its continued header) — so it rarely sits alone on a page.
  const endLine = settled ? "Settled - nothing left to settle" : view.headline;
  const dueLabel = settled ? "NOTHING DUE" : "AMOUNT DUE";
  const FULL_H = 54;
  const COMPACT_H = 30;
  if (y - (12 + FULL_H) < CONTENT_BOTTOM && y - (10 + COMPACT_H) >= CONTENT_BOTTOM) {
    y -= 10;
    roundBox(M, y - COMPACT_H, TABLE_W, COMPACT_H, 3, FOREST);
    const by = y - 19;
    text("ENDING BALANCE", M + 14, by, T.label + 0.6, bold, LIME);
    const amountSize = sizeToFit(view.amount, 14, bold, 180, 9);
    const amountW = width(view.amount, amountSize, bold);
    const lead = M + 14 + width("ENDING BALANCE", T.label + 0.6, bold) + 14;
    const dueW = width(dueLabel, T.label, bold) + 10;
    text(fit(endLine, bold, 9.5, M + TABLE_W - 14 - amountW - dueW - lead - 10), lead, by, 9.5, bold, WHITE);
    textRight(dueLabel, M + TABLE_W - 14 - amountW - 10, by + 0.5, T.label, bold, SAGE_RULE);
    textRight(view.amount, M + TABLE_W - 14, by - 1, amountSize, bold, WHITE);
    y -= COMPACT_H;
  } else {
    ensure(12 + FULL_H, false);
    y -= 12;
    roundBox(M, y - FULL_H, TABLE_W, FULL_H, 3, FOREST);
    text("ENDING BALANCE", M + 18, y - 19, T.label + 0.6, bold, LIME);
    const endAmountSize = sizeToFit(view.amount, 22, bold, 220, 11);
    const endAmountW = width(view.amount, endAmountSize, bold);
    text(fit(endLine, bold, 11.5, TABLE_W - endAmountW - 60), M + 18, y - 37, 11.5, bold, WHITE);
    textRight(dueLabel, M + TABLE_W - 18, y - 19, T.label + 0.2, bold, SAGE_RULE);
    textRight(view.amount, M + TABLE_W - 18, y - 40, endAmountSize, bold, WHITE);
    y -= FULL_H;
  }

  // ---------------- Footer ----------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: FOOTER_RULE_Y }, end: { x: M + TABLE_W, y: FOOTER_RULE_Y }, thickness: 0.5, color: RULE });
    const pageLabel = `Page ${i + 1} of ${pages.length}`;
    const pageW = bold.widthOfTextAtSize(pageLabel, 6.8);
    p.drawText(pageLabel, { x: M + TABLE_W - pageW, y: 20, size: 6.8, font: bold, color: BODY });
    const prepared = fit(`Prepared by ${view.ownerName}  ·  `, regular, 6.8, 200);
    const preparedW = regular.widthOfTextAtSize(prepared, 6.8);
    p.drawText(prepared, { x: M + TABLE_W - pageW - preparedW, y: 20, size: 6.8, font: regular, color: MUTED });
    const left = fit(`FlowFi  ·  Statement for ${view.personName}  ·  ${view.cycleLabel}`, regular, 6.8, TABLE_W - preparedW - pageW - 16);
    p.drawText(left, { x: M, y: 20, size: 6.8, font: regular, color: MUTED });
  });
  return doc.save();
}
