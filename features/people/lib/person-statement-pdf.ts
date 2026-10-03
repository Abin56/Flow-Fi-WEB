/**
 * Landscape A4 People settlement statement — the PDF twin of the Share Statement preview.
 * Rendered solely from `statementView`: every amount, label, type and status comes from the statement
 * engine through the shared presentation layer; nothing here does arithmetic on money (the only numbers
 * computed are layout coordinates).
 *
 * The statement is read by the person, so it never says "you": both parties are named and the position
 * reads as a direction ("SOJAN → ABIN JOHN"). Restrained palette: white surfaces and dark text, FlowFi lime
 * as the single brand accent, grey for metadata, and semantic colour only on states that carry meaning
 * (green = paid / settled, amber = due / partly paid, red = overdue). Every colour supports a word, so the
 * statement stays clear in greyscale print.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { STATEMENT_COPY, statementView, type StatementViewOptions, type StatementViewRow } from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementStatusTone } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { SplitAllocation } from "@/lib/split/split-allocation";

export function pdfSafe(text: string): string {
  return text.replace(/₹/g, "Rs. ").replace(/−/g, "-").replace(/[–—]/g, "-").replace(/→/g, "->").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

// ---- Palette (solid, PDF-safe; greys kept dark enough to survive low-contrast screens and print) ----
const INK = rgb(0.08, 0.09, 0.11);
const BODY = rgb(0.22, 0.24, 0.28);
const MUTED = rgb(0.32, 0.34, 0.38);
// Three border weights, all visible on ordinary 1080p screens: the transaction frame strongest, the split
// panel's frame next, the dividers between participant cells lightest.
const RULE = rgb(0.72, 0.73, 0.75);
const RULE_SOFT = rgb(0.82, 0.83, 0.84);
const RULE_STRONG = rgb(0.5, 0.52, 0.55);
const RECORD_EDGE = rgb(0.47, 0.49, 0.53);
const PANEL = rgb(0.955, 0.958, 0.95);
const PANEL_STRONG = rgb(0.915, 0.92, 0.905);
const WHITE = rgb(1, 1, 1);
const LIME = rgb(0.73, 0.96, 0.35);
const LIME_DEEP = rgb(0.29, 0.45, 0.04);
const GREEN = { fill: rgb(0.89, 0.96, 0.91), text: rgb(0.05, 0.4, 0.2), edge: rgb(0.5, 0.75, 0.58) };
const AMBER = { fill: rgb(1, 0.94, 0.84), text: rgb(0.45, 0.26, 0.02), edge: rgb(0.82, 0.6, 0.27) };
const RED = { fill: rgb(0.99, 0.9, 0.89), text: rgb(0.66, 0.11, 0.08), edge: rgb(0.85, 0.5, 0.47) };
const LIME_TINT = rgb(0.95, 0.978, 0.885);
const NEUTRAL = { fill: PANEL_STRONG, text: BODY, edge: RULE_STRONG };
const DUE = { fill: rgb(1, 0.965, 0.9), text: rgb(0.47, 0.29, 0.02), edge: rgb(0.88, 0.7, 0.4) };

/** Status pill: semantic colour only where the state means something; everything else stays neutral. */
const STATUS: Record<SettlementStatusTone, { fill: RGB; text: RGB; edge: RGB }> = {
  due: DUE,
  payable: DUE,
  partial: AMBER,
  settled: GREEN,
  overdue: RED,
  upcoming: NEUTRAL,
  received: GREEN,
  paid: NEUTRAL,
  neutral: NEUTRAL,
};

/**
 * Type roles (pt). One family (Helvetica, whose figures are tabular, so amounts align), two weights;
 * the hierarchy comes from size and colour, so bold is kept for names, titles and money.
 */
const T = {
  brand: 6.6,
  title: 16,
  name: 12,
  section: 10.5,
  desc: 9,
  moneyMajor: 21,
  moneySummary: 10.5,
  money: 8.4,
  label: 6.6,
  body: 7.6,
  meta: 7,
  /** Level-3 supporting lines under a transaction (relation, share caption, status detail). */
  support: 7.2,
} as const;
/** Spacing scale — every gap is one of these. */
const S = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 } as const;

// ---- Page geometry (A4 landscape, 34pt margins → 773.9pt usable) ----
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const M = 34;
/** A slightly tighter top margin: the page starts higher, the footer keeps its full margin. */
const M_TOP = 28;
const TABLE_W = PAGE_W - 2 * M;
const COLUMNS = [
  { label: "No.", w: 22, align: "right" },
  { label: "Date", w: 56, align: "left" },
  { label: "Description", w: 240, align: "left" },
  { label: "Type", w: 76, align: "left" },
  { label: "Amount", w: 80, align: "right" },
  { label: "Paid", w: 64, align: "right" },
  { label: "Remaining", w: 74, align: "right" },
  { label: "Status", w: 0, align: "left" },
] as const;
const COL_W = COLUMNS.map((c, i) => (i === COLUMNS.length - 1 ? TABLE_W - COLUMNS.slice(0, -1).reduce((s, x) => s + x.w, 0) : c.w));
/** The footer rule's height; footer text sits below it. */
const FOOTER_RULE_Y = 30;
/**
 * The lowest point any content may reach: a small safety gap above the footer rule. Every keep-together
 * check (rows, headings, payments, the ending block) uses this one floor.
 */
const CONTENT_BOTTOM = FOOTER_RULE_Y + 6;
const PAD = 6;
/** A row's main line block: title + one metadata line. */
const ROW_H = 23;
const TITLE_LH = 10.5;
/** Space between transaction records, so each frame reads on its own. */
const RECORD_GAP = S.xs;
/** A month heading (uppercase label + rule). */
const MONTH_H = 14;
/** A section heading band (Previous balance / This cycle). */
const SECTION_H = 16;

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
  // The balance is a direction, not good or bad news for the reader: ink when due, green only once settled.
  const positionText = settled ? GREEN.text : INK;

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M_TOP;

  const width = (s: string, size: number, font: PDFFont = regular) => font.widthOfTextAtSize(pdfSafe(s), size);
  const text = (s: string, x: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    page.drawText(pdfSafe(s), { x, y: yy, size, font, color });
  const textRight = (s: string, right: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    text(s, right - width(s, size, font), yy, size, font, color);
  const box = (x: number, yy: number, w: number, h: number, fill: RGB, border?: RGB, borderWidth = 0.6) =>
    page.drawRectangle({ x, y: yy, width: w, height: h, color: fill, ...(border ? { borderColor: border, borderWidth } : {}) });
  const vline = (x: number, top: number, bottom: number, color = RULE, thickness = 0.4) =>
    page.drawLine({ start: { x, y: bottom }, end: { x, y: top }, thickness, color });
  const hline = (x0: number, x1: number, yy: number, color = RULE, thickness = 0.5) => page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness, color });
  /** A right-aligned amount that always fits its column: very large values step the size down, never get cut. */
  const amountRight = (s: string, right: number, yy: number, size: number, font: PDFFont, color: RGB, colW: number) => {
    let sz = size;
    while (sz > 5.5 && width(s, sz, font) > colW - 2 * PAD) sz -= 0.25;
    textRight(s, right, yy, sz, font, color);
  };
  /** A badge: status = filled + semantic edge; type = white with a neutral outline (so the two never look alike). */
  const pill = (label: string, x: number, yy: number, fill: RGB, color: RGB, size = 6.4, edge?: RGB) => {
    const t = pdfSafe(label);
    const w = bold.widthOfTextAtSize(t, size) + 8;
    box(x, yy - 3, w, size + 5.4, fill, edge, 0.6);
    text(t, x + 4, yy, size, bold, color);
    return w;
  };

  // "SOJAN → ABIN JOHN": the arrow is drawn (Helvetica has no arrow glyph), so the direction never degrades to "->".
  const ARROW_W = 15;
  const flowWidth = (f: { from: string; to: string }, size: number, font: PDFFont) => width(f.from, size, font) + ARROW_W + width(f.to, size, font);
  /** Draws the direction at `x`, stepping the size down (never below 6pt) until it fits `maxW`; returns the size used. */
  const drawFlow = (f: { from: string; to: string }, x: number, yy: number, size: number, font: PDFFont, color: RGB, maxW: number, alignRight = false) => {
    let sz = size;
    while (sz > 6 && flowWidth(f, sz, font) > maxW) sz -= 0.25;
    const from = fit(f.from, font, sz, (maxW - ARROW_W) / 2);
    const to = fit(f.to, font, sz, maxW - ARROW_W - width(from, sz, font));
    const total = width(from, sz, font) + ARROW_W + width(to, sz, font);
    const x0 = alignRight ? x - total : x;
    const wf = width(from, sz, font);
    text(from, x0, yy, sz, font, color);
    const ay = yy + sz * 0.33;
    const a0 = x0 + wf + 4;
    const a1 = x0 + wf + ARROW_W - 4;
    page.drawLine({ start: { x: a0, y: ay }, end: { x: a1, y: ay }, thickness: 0.9, color });
    page.drawLine({ start: { x: a1 - 2.6, y: ay + 2.3 }, end: { x: a1 + 0.2, y: ay }, thickness: 0.9, color });
    page.drawLine({ start: { x: a1 - 2.6, y: ay - 2.3 }, end: { x: a1 + 0.2, y: ay }, thickness: 0.9, color });
    text(to, x0 + wf + ARROW_W, yy, sz, font, color);
  };

  // ---------------- Header + summary (first page) ----------------
  const drawHeader = () => {
    // Brand + title, then who and when; the balance and its direction answer on the right.
    box(M, y - 3, TABLE_W, 3, LIME);
    y -= 3;
    text("FLOWFI", M, y - 13, T.brand, bold, LIME_DEEP);
    text("People Settlement Statement", M, y - 30, T.title, bold, INK);
    const nameText = fit(view.personName, bold, T.name, 300);
    text(nameText, M, y - 46, T.name, bold, INK);
    text(fit(view.cycleLabel, regular, T.body + 0.6, 420 - width(nameText, T.name, bold)), M + width(nameText, T.name, bold) + S.md, y - 46, T.body + 0.6, regular, BODY);
    text(fit(`Prepared by ${view.ownerName}  ·  Generated ${GENERATED.format(options.now ?? new Date())}`, regular, T.meta, 430), M, y - 57, T.meta, regular, MUTED);

    const right = M + TABLE_W;
    textRight(settled ? "SETTLED" : "BALANCE DUE", right, y - 13, T.label, bold, MUTED);
    textRight(view.amount, right, y - 37, T.moneyMajor, bold, positionText);
    if (view.flow) drawFlow(view.flow, right, y - 51, T.body + 0.6, bold, BODY, 300, true);
    else textRight("Nothing due", right, y - 51, T.body + 0.6, regular, MUTED);
    y -= 58 + S.sm;

    // ---- One financial summary: each figure with its label; balance due carries the weight ----
    const cells = [
      ...view.reconciliation.map((l) => ({ label: l.label, value: l.value, side: l.side, current: false, advance: false })),
      { label: view.current.label, value: view.current.value, side: null as string | null, current: true, advance: false },
      ...(view.advance ? [{ label: view.advance.label, value: view.advance.value, side: "Held apart - not in the balance", current: false, advance: true }] : []),
    ];
    const h = 36;
    const currentW = 150;
    const restW = (TABLE_W - currentW) / (cells.length - 1);
    box(M, y - h, TABLE_W, h, WHITE, RULE_STRONG, 0.6);
    let x = M;
    cells.forEach((c, i) => {
      const w = c.current ? currentW : restW;
      if (c.current) {
        box(x, y - h, w, h, PANEL_STRONG);
        box(x, y - h, 3, h, LIME);
      } else if (i > 0 && !cells[i - 1].current) vline(x, y - S.md, y - h + S.md, RULE, 0.5);
      const tx = x + (c.current ? 12 : 10);
      text(fit(c.label.toUpperCase(), bold, T.label, w - 18), tx, y - 11, T.label, bold, c.current ? BODY : MUTED);
      const zero = c.value === ZERO;
      const color = c.current ? positionText : zero ? MUTED : c.advance ? GREEN.text : INK;
      text(c.value, tx, y - 24.5, c.current ? 13 : T.moneySummary, zero && !c.current ? regular : bold, color);
      if (c.side) text(fit(c.side, regular, T.meta - 0.4, w - 18), tx, y - 32, T.meta - 0.4, regular, MUTED);
      x += w;
    });
    y -= h;
    if (view.cashNote) {
      textRight(fit(view.cashNote, regular, T.meta, TABLE_W), M + TABLE_W, y - 10, T.meta, regular, MUTED);
      y -= 10;
    }
    y -= S.md;
  };

  // ---------------- Table header (repeated on every page) ----------------
  const drawTableHeader = (continued: boolean) => {
    if (continued) {
      text(fit(`${view.personName}  ·  People Settlement Statement  ·  ${view.cycleLabel}`, bold, 8.5, TABLE_W - 200), M, y - 10, 8.5, bold, INK);
      // Later pages still carry the answer, so the ending band never has to start a page of its own.
      const pending = `${view.current.label} ${view.current.value}`;
      textRight(pending, M + TABLE_W, y - 10, 8, bold, positionText);
      textRight("continued  ·  ", M + TABLE_W - width(pending, 8, bold), y - 10, 7.4, regular, MUTED);
      y -= 18;
    }
    const h = 15;
    let x = M;
    COLUMNS.forEach((c, i) => {
      const w = COL_W[i]!;
      const label = c.label.toUpperCase();
      if (c.align === "right") textRight(label, x + w - PAD, y - 10, T.label, bold, MUTED);
      else text(label, x + PAD, y - 10, T.label, bold, MUTED);
      x += w;
    });
    hline(M, M + TABLE_W, y - h, RULE_STRONG, 0.8);
    y -= h;
  };

  const newPage = (withTableHeader: boolean) => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M_TOP;
    if (withTableHeader) drawTableHeader(true);
  };
  const ensure = (h: number, withTableHeader = true) => {
    // A unit (a transaction with its split breakdown, or a heading with its first transaction) is never split across pages.
    if (y - h < CONTENT_BOTTOM) newPage(withTableHeader);
  };

  /**
   * "Total price ₹4,000 · 4-way split · Amma's share ₹1,000" as one or more lines that fit `width`:
   * the bold total leads the first line, and the remaining " · " parts flow on, wrapping whole.
   * Only for a legacy split whose Expense isn't available (no full breakdown to draw).
   */
  const NOTE_SIZE = T.meta;
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

  // ---------------- Split breakdown (part of its row) ----------------
  // One panel under the row's description: the bill on the left (original purchase + how many shared it),
  // then a grid of every stored allocation (name above amount; names wrap by word, amounts are never cut).
  const BLOCK_X = M + COL_W[0] + COL_W[1] + PAD;
  const BLOCK_W = M + TABLE_W - PAD - BLOCK_X;
  const MAX_CELL_W = 138;
  const NAME_SIZE = 7.6;
  const NAME_LH = 8.8;
  const AMOUNT_SIZE = 8.8;
  const CAPTION_SIZE = 6.6;
  const wrapWords = (label: string, w: number, font: PDFFont, size = NAME_SIZE): string[] => {
    const lines: string[] = [];
    let cur = "";
    for (const word of pdfSafe(label).split(/\s+/)) {
      let piece = word;
      // A single word wider than the cell is broken by characters rather than cut.
      while (font.widthOfTextAtSize(piece, size) > w) {
        let n = piece.length - 1;
        while (n > 1 && font.widthOfTextAtSize(piece.slice(0, n), size) > w) n -= 1;
        if (cur) lines.push(cur);
        lines.push(piece.slice(0, n));
        cur = "";
        piece = piece.slice(n);
      }
      const next = cur ? `${cur} ${piece}` : piece;
      if (font.widthOfTextAtSize(next, size) <= w) cur = next;
      else {
        if (cur) lines.push(cur);
        cur = piece;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  // The Amount column already names whose share it is; inside the grid the cell only needs its role.
  const focusCaption = "Recipient share";
  const SUMMARY_W = 122;
  const SUMMARY_H = 28;
  const GRID_X = BLOCK_X + SUMMARY_W;
  const GRID_W = BLOCK_W - SUMMARY_W;
  const layoutAllocation = (a: SplitAllocation) => {
    const n = a.participants.length;
    const cols = allocationColumns(n);
    const cellW = Math.min(MAX_CELL_W, GRID_W / Math.max(1, cols));
    const names = a.participants.map((p) => wrapWords(p.label, cellW - 2 * PAD, p.isFocus ? bold : regular));
    // The recipient's caption sits beside their amount when it fits, else on its own line.
    const captionInline = a.participants.every((p) => !p.isFocus || width(money(p.amount), AMOUNT_SIZE, bold) + 5 + width(focusCaption, CAPTION_SIZE) <= cellW - 2 * PAD);
    const gridRows = Math.ceil(n / cols);
    // Each grid row is as tall as its tallest cell: wrapped name + amount, + the recipient's caption line.
    const rowHeights = Array.from({ length: gridRows }, (_, r) => {
      const slice = a.participants.slice(r * cols, r * cols + cols);
      const lines = Math.max(1, ...names.slice(r * cols, r * cols + cols).map((l) => l.length));
      return S.xs + 1 + lines * NAME_LH + 10 + (!captionInline && slice.some((p) => p.isFocus) ? 8 : 0) + S.xs;
    });
    // The grid fills at least the bill summary's height, so cells and the panel share one bottom edge.
    const short = SUMMARY_H - rowHeights.reduce((s, h) => s + h, 0);
    if (short > 0 && rowHeights.length) rowHeights[rowHeights.length - 1] += short;
    const gridH = rowHeights.reduce((s, h) => s + h, 0);
    const mismatch = a.reconciles || n === 0 ? 0 : 10;
    const panelH = Math.max(gridH, SUMMARY_H) + mismatch;
    return { cols, cellW, names, rowHeights, gridH, captionInline, panelH, height: panelH + S.xs };
  };
  const drawAllocation = (a: SplitAllocation, l: ReturnType<typeof layoutAllocation>, top: number) => {
    const gridW = l.cols * l.cellW;
    // The bill is the anchor (soft surface); participant cells sit on white inside one ruled frame.
    const panelW = SUMMARY_W + (a.participants.length ? gridW : 0);
    box(BLOCK_X, top - l.panelH, panelW, l.panelH, WHITE, RULE, 0.6);
    box(BLOCK_X + 0.3, top - l.panelH + 0.3, SUMMARY_W - 0.3, l.panelH - 0.6, PANEL);
    const how = a.participantCount >= 2 ? `${a.participantCount}-way split` : a.participantCount === 1 ? "Assigned in full" : "Split expense";
    const hx = BLOCK_X + PAD;
    // Not a participant: a small uppercase label, the purchase amount dominant, then how it was shared.
    text("ORIGINAL PURCHASE", hx, top - 7.8, T.label - 0.4, bold, MUTED);
    text(money(a.original), hx, top - 17.5, 10, bold, INK);
    text(fit(how, regular, T.support - 0.4, SUMMARY_W - 2 * PAD), hx, top - 24.6, T.support - 0.4, regular, BODY);
    let rowTop = top;
    for (let r = 0; r < l.rowHeights.length; r += 1) {
      const rh = l.rowHeights[r];
      if (r > 0) hline(GRID_X, GRID_X + gridW, rowTop, RULE_SOFT, 0.5);
      a.participants.slice(r * l.cols, r * l.cols + l.cols).forEach((p, c) => {
        const i = r * l.cols + c;
        const cx = GRID_X + c * l.cellW;
        // The recipient's cell: one soft tint, nothing more.
        if (p.isFocus) box(cx + 0.3, rowTop - rh + 0.3, l.cellW - 0.6, rh - 0.6, LIME_TINT);
        vline(cx, rowTop, rowTop - rh, c === 0 ? RULE : RULE_SOFT, 0.5);
        let ty = rowTop - S.md - 0.8;
        for (const line of l.names[i]) {
          text(line, cx + PAD, ty, NAME_SIZE, p.isFocus ? bold : regular, p.isFocus ? INK : BODY);
          ty -= NAME_LH;
        }
        const amount = money(p.amount);
        text(amount, cx + PAD, ty - 1.5, AMOUNT_SIZE, bold, p.amount === 0 ? MUTED : INK);
        if (p.isFocus) {
          if (l.captionInline) text(focusCaption, cx + PAD + width(amount, AMOUNT_SIZE, bold) + 5, ty - 1.5, CAPTION_SIZE, regular, MUTED);
          else text(fit(focusCaption, regular, CAPTION_SIZE, l.cellW - 2 * PAD), cx + PAD, ty - 9.5, CAPTION_SIZE, regular, MUTED);
        }
      });
      rowTop -= rh;
    }
    if (!a.reconciles && a.participants.length > 0) text(`Allocated ${money(a.allocated)} of ${money(a.original)}`, GRID_X + PAD, top - l.panelH + 3.5, T.meta - 0.2, regular, MUTED);
  };

  // ---------------- Rows ----------------
  const layoutRow = (row: StatementViewRow) => {
    const strip = row.allocation ? layoutAllocation(row.allocation) : null;
    const splitLines = row.splitNote && !strip ? wrapSplitNote(row.splitNote, COL_W[2] - 2 * PAD) : [];
    // Merchant names wrap (up to 3 lines) rather than being cut; the row grows instead.
    const wrapped = wrapWords(row.title, COL_W[2] - 2 * PAD, bold, T.desc);
    const titleLines = wrapped.length > 3 ? [...wrapped.slice(0, 2), fit(wrapped.slice(2).join(" "), bold, T.desc, COL_W[2] - 2 * PAD)] : wrapped;
    const extra = (titleLines.length - 1) * TITLE_LH;
    const mainH = ROW_H + extra + splitLines.length * 8.5;
    return { strip, splitLines, titleLines, extra, mainH, h: mainH + (strip?.height ?? 0) };
  };
  const drawRow = (row: StatementViewRow) => {
    const { strip, splitLines, titleLines, extra, mainH, h } = layoutRow(row);
    ensure(h + RECORD_GAP);
    y -= RECORD_GAP;
    const top = y;
    const bottom = y - h;
    // One contained record: a visible outer frame, so each transaction has a clear beginning and end.
    page.drawRectangle({ x: M, y: bottom, width: TABLE_W, height: h, borderColor: RECORD_EDGE, borderWidth: 0.9 });

    const line1 = top - 11;
    const line2 = top - 19.5;
    let x = M;
    COL_W.forEach((w, i) => {
      const right = x + w - PAD;
      switch (i) {
        case 0:
          textRight(row.no, right, line1, T.meta, regular, MUTED);
          break;
        case 1:
          text(row.date, x + PAD, line1, T.body, regular, BODY);
          break;
        case 2:
          titleLines.forEach((t, ti) => text(t, x + PAD, line1 - ti * TITLE_LH, T.desc, bold, INK));
          {
            // A split drawn with its allocation needs no "Sojan's share of a split expense": the type badge,
            // the Amount caption and the highlighted cell already say it.
            const relation = row.allocation && row.kind === "split" ? null : row.relation;
            const support = [row.carried && row.fromCycle ? `From ${row.fromCycle}` : null, relation].filter(Boolean).join("  ·  ");
            if (support) text(fit(support, regular, T.support, w - 2 * PAD), x + PAD, line2 - extra, T.support, regular, MUTED);
          }
          splitLines.forEach((sl, li) => {
            const ly = top - 28 - extra - li * 8.5;
            if (li === 0) {
              const headW = width(sl.head, NOTE_SIZE, bold);
              text(sl.head, x + PAD, ly, NOTE_SIZE, bold, INK);
              if (sl.rest) text(fit(sl.rest, regular, NOTE_SIZE, w - 2 * PAD - headW), x + PAD + headW, ly, NOTE_SIZE, regular, MUTED);
            } else text(fit(sl.rest, regular, NOTE_SIZE, w - 2 * PAD), x + PAD, ly, NOTE_SIZE, regular, MUTED);
          });
          break;
        case 3:
          // A type is a category, not an alert: one neutral badge for every kind.
          pill(fit(row.typeLabel, bold, 6.4, w - 2 * PAD - 8), x + PAD, line1 + 0.5, WHITE, BODY, 6.4, RULE_STRONG);
          break;
        case 4:
          if (row.original) {
            amountRight(row.original, right, line1, T.money, bold, INK, w);
            if (row.amountLabel !== "Amount") textRight(fit(row.amountLabel, regular, T.support - 0.4, w - 2 * PAD), right, line2, T.support - 0.4, regular, MUTED);
          } else textRight("-", right, line1, T.money, regular, MUTED);
          break;
        case 5:
          // Paid is context: regular weight, and quiet when nothing has been paid.
          if (row.paid) amountRight(row.paid, right, line1, T.money, regular, row.paid === ZERO ? MUTED : BODY, w);
          else textRight("-", right, line1, T.money, regular, MUTED);
          break;
        case 6:
          // Remaining is the figure that matters: bold while anything is left, quiet at zero.
          if (row.remaining) {
            const zero = row.remaining === ZERO;
            const tone = zero ? MUTED : row.statusTone === "overdue" ? RED.text : INK;
            amountRight(row.remaining, right, line1, zero ? T.money : T.money + 0.4, zero ? regular : bold, tone, w);
          } else textRight("-", right, line1, T.money, regular, MUTED);
          break;
        case 7: {
          const st = STATUS[row.statusTone];
          pill(fit(row.status, bold, 6.4, w - 2 * PAD - 8), x + PAD, line1 + 0.5, st.fill, st.text, 6.4, st.edge);
          if (row.statusDetail) text(fit(row.statusDetail, regular, T.support - 0.2, w - 2 * PAD), x + PAD, line2, T.support - 0.2, regular, MUTED);
          break;
        }
      }
      x += w;
    });
    if (strip && row.allocation) drawAllocation(row.allocation, strip, top - mainH);
    y = bottom;
  };

  // ---------------- Headings (each kept with the transaction that follows it) ----------------
  /** Section band: PREVIOUS BALANCE / THIS CYCLE with a short note. `next` = the height of what must follow on the same page. */
  const sectionHeading = (label: string, note: string, next: number) => {
    ensure(S.sm + SECTION_H + next);
    y -= S.sm;
    // A borderless neutral band: reads as a section label, never as another (framed) transaction, and has no
    // lime so it never competes with the balance summary.
    box(M, y - SECTION_H, TABLE_W, SECTION_H, PANEL_STRONG);
    const l = label.toUpperCase();
    text(l, M + PAD, y - 11, T.label + 0.4, bold, INK);
    text(fit(note, regular, T.meta, TABLE_W - width(l, T.label + 0.4, bold) - 3 * PAD), M + PAD + width(l, T.label + 0.4, bold) + S.md, y - 11, T.meta, regular, BODY);
    y -= SECTION_H;
  };
  /** Month heading: a small uppercase label over a thin rule — enough to scan by, never a coloured block. */
  const monthHeading = (month: string, next: number) => {
    ensure(MONTH_H + next);
    // More room above a month (from the previous frame) than below it (to its first transaction).
    const m = month.toUpperCase();
    text(m, M + 1, y - 10.5, T.label + 0.4, bold, BODY);
    hline(M + width(m, T.label + 0.4, bold) + S.md + 1, M + TABLE_W, y - 8, RULE, 0.6);
    y -= MONTH_H;
  };
  const allRows = [...view.carried, ...view.rows];
  const byMonth = new Set(allRows.map((r) => r.month)).size > 1;
  /** A group's rows, with a month heading wherever the month changes (only when the statement spans months). */
  const drawRows = (rows: StatementViewRow[]) => {
    let month: string | null = null;
    for (const r of rows) {
      if (byMonth && r.month !== month) {
        monthHeading(r.month, layoutRow(r).h + RECORD_GAP);
        month = r.month;
      }
      drawRow(r);
    }
  };
  const firstUnit = (rows: StatementViewRow[]) => (rows.length === 0 ? 0 : (byMonth ? MONTH_H : 0) + layoutRow(rows[0]).h + RECORD_GAP);

  // ---------------- Compose ----------------
  drawHeader();
  const count = allRows.length;
  text("Transactions", M, y - 4, T.section, bold, INK);
  textRight(`${count} ${count === 1 ? "item" : "items"}  ·  Paid and remaining as of ${view.asOf}`, M + TABLE_W, y - 4, T.meta, regular, MUTED);
  y -= S.md + 1;
  drawTableHeader(false);
  if (view.carried.length > 0) {
    sectionHeading(STATEMENT_COPY.carried.label, STATEMENT_COPY.carried.note, firstUnit(view.carried));
    drawRows(view.carried);
    // Nothing new this cycle: the band itself says so — no separate empty line under it.
    sectionHeading(STATEMENT_COPY.current, view.rows.length ? view.cycleLabel : `${view.cycleLabel}  ·  ${STATEMENT_COPY.empty}`, firstUnit(view.rows));
  }
  if (view.rows.length === 0 && view.carried.length === 0) {
    ensure(24);
    text(STATEMENT_COPY.empty, M + PAD, y - 15, T.body + 0.4, regular, MUTED);
    hline(M, M + TABLE_W, y - 24, RULE, 0.5);
    y -= 24;
  } else if (view.rows.length > 0) {
    drawRows(view.rows);
  }

  // ---------------- Payment history (grouped by real payment) ----------------
  if (view.payments.length > 0) {
    const histW = 470;
    const paymentH = (p: (typeof view.payments)[number]) => (p.single != null ? 24 : 18 + p.applied.length * 10 + 16 + (p.held ? 13 : 0));
    // The heading never sits alone at a page foot: it moves with the first payment.
    ensure(S.xl + S.sm + paymentH(view.payments[0]) + 1, false);
    y -= S.xl;
    text("Payment history", M, y, T.section, bold, INK);
    text("This cycle", M + width("Payment history", T.section, bold) + S.md, y, T.meta, regular, MUTED);
    y -= S.sm;
    hline(M, M + histW, y, RULE_STRONG, 0.6);
    for (const p of view.payments) {
      const h = paymentH(p);
      ensure(h + 1, false);
      hline(M, M + histW, y - h, RULE, 0.5);
      text(p.date, M + PAD, y - 12, T.body, regular, BODY);
      text(fit(`${p.label}${p.account ? `  ·  ${p.account}` : ""}`, bold, T.body + 0.2, histW - 170), M + 66, y - 12, T.body + 0.2, bold, INK);
      textRight(p.amount, M + histW - PAD, y - 12, T.money, bold, p.inbound ? GREEN.text : INK);
      if (p.single != null) {
        text(fit(p.single, regular, T.meta, histW - 90), M + 66, y - 20.5, T.meta, regular, MUTED);
      } else {
        let ly = y - 22;
        text("APPLIED TO", M + 66, ly, T.label - 0.2, bold, MUTED);
        ly -= 9;
        for (const a of p.applied) {
          text(fit(`+  ${a.label}`, regular, 7, 220), M + 72, ly, 7, regular, INK);
          textRight(a.amount, M + 330, ly, 7, regular, INK);
          ly -= 10;
        }
        hline(M + 66, M + 330, ly + 7, RULE, 0.5);
        text("Applied", M + 72, ly - 1, 7, bold, INK);
        textRight(p.appliedTotal ?? "", M + 330, ly - 1, 7, bold, INK);
        if (p.held) {
          ly -= 12;
          text("Held as advance", M + 72, ly, 7, bold, GREEN.text);
          textRight(p.held, M + 330, ly, 7, bold, GREEN.text);
        }
      }
      y -= h;
    }
    const totals = [view.totalReceived && `Total paid by ${first}  ${view.totalReceived}`, view.totalPaid && `Total paid by ${view.ownerShort}  ${view.totalPaid}`].filter(Boolean) as string[];
    for (const t of totals) {
      ensure(12, false);
      y -= 11;
      textRight(t, M + histW - PAD, y, T.body + 0.4, bold, INK);
    }
  }

  // ---------------- Ending balance ----------------
  // Repeats the answer as the statement's conclusion. It may use the footer's spare room (it only has to
  // clear the footer rule), and is skipped rather than left alone on a new page — page 1's header and every
  // continued page's header already state it.
  const endH = 22;
  if (y - (endH + S.sm) >= CONTENT_BOTTOM) {
    y -= S.sm;
    box(M, y - endH, TABLE_W, endH, PANEL_STRONG);
    box(M, y - endH, 3, endH, LIME);
    text("ENDING BALANCE", M + 12, y - 14, T.label + 0.2, bold, BODY);
    const mid = M + 12 + width("ENDING BALANCE", T.label + 0.2, bold) + S.xl;
    if (view.flow) drawFlow(view.flow, mid, y - 14.5, 8.6, bold, INK, TABLE_W - (mid - M) - 200);
    else text("Settled", mid, y - 14.5, 8.6, bold, GREEN.text);
    textRight(`${view.amount} due`, M + TABLE_W - 12, y - 15.5, 12, bold, positionText);
    y -= endH;
  }

  // ---------------- Footer ----------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: FOOTER_RULE_Y }, end: { x: M + TABLE_W, y: FOOTER_RULE_Y }, thickness: 0.5, color: RULE });
    const lineA = fit(`FlowFi  ·  Statement for ${view.personName}  ·  ${view.cycleLabel}`, regular, 6.8, TABLE_W - 90);
    p.drawText(lineA, { x: M, y: 20, size: 6.8, font: regular, color: MUTED });
    p.drawText(fit(`Prepared by ${view.ownerName}`, regular, 6.4, TABLE_W - 90), { x: M, y: 11, size: 6.4, font: regular, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: M + TABLE_W - regular.widthOfTextAtSize(label, 6.8), y: 15.5, size: 6.8, font: regular, color: MUTED });
  });
  return doc.save();
}
