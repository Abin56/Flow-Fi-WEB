/**
 * A4 People settlement statement (landscape by default, portrait on request) — the PDF twin of the Share Statement preview, laid out as a
 * financial document (a bank / card statement), never a dashboard: no charts, no KPI tiles, one balance answer.
 * Rendered solely from `statementView`: every amount, label, type and status comes from the statement
 * engine through the shared presentation layer; nothing here does arithmetic on money (the only numbers
 * computed are layout coordinates).
 *
 * The statement is read by the person, so it never says "you": both parties are named ("Sojan owes Abin
 * John"). Structure: each section is one connected panel (heading → column header → rows), rows share their
 * rules, and the width is used for fixed money columns — Original (only for a split) / Amount / Paid /
 * Remaining — so figures line up down the page whatever the description length. Colours come from
 * `statement-palette` (the preview reads the same tokens); every colour supports a word, so the statement
 * stays clear in greyscale print.
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFNull, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import {
  STATEMENT_COPY,
  statementDate,
  statementSections,
  statementSummaryCells,
  statementView,
  type StatementViewOptions,
  type StatementViewRow,
} from "@/features/people/lib/person-statement-pdf-model";
import { hexToUnit, STATEMENT_CHIP, STATEMENT_INK, type StatementChip } from "@/features/people/lib/statement-palette";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { SplitAllocation } from "@/lib/split/split-allocation";

export function pdfSafe(text: string): string {
  return text.replace(/₹/g, "Rs. ").replace(/−/g, "-").replace(/[–—]/g, "-").replace(/→/g, "->").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

// ---- Palette (statement-palette tokens) ----
const hex = (h: string) => rgb(...hexToUnit(h));
const INK = hex(STATEMENT_INK.ink);
const BODY = hex(STATEMENT_INK.body);
const MUTED = hex(STATEMENT_INK.muted);
const RULE = hex(STATEMENT_INK.rule);
const RULE_STRONG = hex(STATEMENT_INK.ruleStrong);
const SURFACE = hex(STATEMENT_INK.surface);
const HEAD = hex(STATEMENT_INK.head);
const NAVY = hex(STATEMENT_INK.navy);
const NAVY_TINT = hex(STATEMENT_INK.navyTint);
const NAVY_RULE = hex(STATEMENT_INK.navyRule);
const REMAIN_TINT = hex(STATEMENT_INK.remainTint);
const SPLIT = hex(STATEMENT_INK.split);
const SPLIT_TINT = hex(STATEMENT_INK.splitTint);
const ADVANCE = hex(STATEMENT_INK.advance);
const ADVANCE_TINT = hex(STATEMENT_INK.advanceTint);
const WHITE = rgb(1, 1, 1);
type Tone = { fill: RGB; text: RGB; edge: RGB };
const CHIP = Object.fromEntries(
  Object.entries(STATEMENT_CHIP).map(([k, v]) => [k, { fill: hex(v.fill), text: hex(v.text), edge: hex(v.edge) }]),
) as Record<StatementChip, Tone>;
const PAID_TEXT = CHIP.paid.text;
const OVERDUE_TEXT = CHIP.overdue.text;

/** Type roles (pt). Helvetica's figures are tabular, so amounts align; hierarchy comes from size and weight. */
const T = {
  title: 9,
  money: 8.4,
  label: 6.3,
  meta: 7,
  caption: 6.5,
  chip: 6.3,
} as const;

export type StatementOrientation = "portrait" | "landscape";

/** TTF bytes for the amount figures (Geist Mono Regular / SemiBold, from `public/fonts/geist-mono`). */
export interface StatementAmountFonts {
  regular: ArrayBuffer | Uint8Array;
  bold: ArrayBuffer | Uint8Array;
}

/** Fetches the amount fonts in the browser; null when they can't be loaded (the PDF then keeps Helvetica and "Rs."). */
export async function loadStatementAmountFonts(base = "/fonts/geist-mono"): Promise<StatementAmountFonts | null> {
  try {
    const [regular, bold] = await Promise.all(
      ["GeistMono-Regular.ttf", "GeistMono-SemiBold.ttf"].map(async (file) => {
        const res = await fetch(`${base}/${file}`);
        if (!res.ok) throw new Error(file);
        return res.arrayBuffer();
      }),
    );
    return { regular, bold };
  } catch {
    return null;
  }
}

/**
 * Page geometry. A4 landscape (the default: 32pt margins → 777.9pt usable); portrait (30pt margins → 535.3pt) keeps
 * the same columns with tighter fixed widths, so every figure still has its own aligned column.
 */
function pageGeometry(orientation: StatementOrientation) {
  const portrait = orientation === "portrait";
  const PAGE_W = portrait ? 595.28 : 841.89;
  const PAGE_H = portrait ? 841.89 : 595.28;
  const M = portrait ? 30 : 32;
  const PAD = portrait ? 5.5 : 7;
  const TABLE_W = PAGE_W - 2 * M;
  // [#, Date, Description (the rest), Original, Amount, Paid, Remaining, Status]
  const widths = portrait ? [18, 52, 0, 64, 68, 58, 64, 78] : [24, 58, 0, 88, 90, 78, 86, 104];
  const COLUMNS = [
    { label: "#", align: "right" },
    { label: "Date", align: "left" },
    { label: "Description", align: "left" },
    { label: "Original", align: "right" },
    { label: "Amount", align: "right" },
    { label: "Paid", align: "right" },
    { label: "Remaining", align: "right" },
    { label: "Status", align: "left" },
  ] as const;
  /** Description takes whatever the fixed columns leave. */
  const COL_W = widths.map((w) => (w === 0 ? TABLE_W - widths.reduce((s, x) => s + x, 0) : w));
  const colX = (i: number) => M + COL_W.slice(0, i).reduce((s, w) => s + w, 0);
  const colRight = (i: number) => colX(i) + COL_W[i] - PAD;
  return { portrait, PAGE_W, PAGE_H, M, PAD, TABLE_W, COLUMNS, COL_W, colX, colRight, DESC_W: COL_W[2] - 2 * PAD, STATUS_W: COL_W[7] - 2 * PAD };
}
const M_TOP = 28;
/** The footer rule's height; footer text sits below it. */
const FOOTER_RULE_Y = 26;
/** The lowest point any content may reach — every keep-together check uses this one floor. */
const CONTENT_BOTTOM = FOOTER_RULE_Y + 8;
const RADIUS = 4;
/** A row's first baseline, below its top. */
const LINE1 = 15;
const TITLE_LH = 10.6;
const META_LH = 8.7;
const NOTE_LH = 8.2;
const HEADER_H = 17;
const MONTH_H = 16;
const SECTION_H = 18;
const CARRY_H = 26;
/** The ending balance block and the gap above it. */
const END_H = 42;
const END_GAP = 12;
/** The shares strip under a split row. */
const SHARE_SIZE = 7.2;
const SHARE_LH = 9.6;
const SHARE_PAD = 3.5;

const GENERATED = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Grid columns for N participants: one row up to 6, then two balanced rows (8 → 4 + 4), capped at 6 per row. */
export function allocationColumns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 6) return n;
  return Math.min(6, Math.ceil(n / 2));
}

/** A placed run of text in a flowed line. */
type Run = { text: string; x: number; font: PDFFont; color: RGB };

/**
 * Renders the statement. `options` (the person's ledger entries, the whole-history statement, account
 * names and the owner's display name) only sharpen the wording — assigned vs split, payments made in a
 * later cycle, the account a payment moved through, who the owner is — and never change a figure.
 */
export async function renderPersonStatementPdf(
  statement: PersonCycleStatement,
  options: StatementViewOptions & { orientation?: StatementOrientation; amountFonts?: StatementAmountFonts | null } = {},
): Promise<Uint8Array> {
  const { portrait, PAGE_W, PAGE_H, M, PAD, TABLE_W, COLUMNS, COL_W, colX, colRight, DESC_W, STATUS_W } = pageGeometry(options.orientation ?? "landscape");
  const view = statementView(statement, options);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${view.personName} - People Statement - ${view.cycleLabel}`));
  doc.setAuthor(pdfSafe(view.ownerName));
  doc.setProducer("FlowFi");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // Amount figures in Geist Mono (the app's figure face) when its bytes are given: even-width digits that line up
  // down a column, and the real ₹ sign. Without them every figure stays Helvetica with "Rs.".
  const custom = options.amountFonts ?? null;
  if (custom) doc.registerFontkit(fontkit);
  const amountRegular = custom ? await doc.embedFont(custom.regular, { subset: true }) : regular;
  const amountBold = custom ? await doc.embedFont(custom.bold, { subset: true }) : bold;
  const amountFace = (font: PDFFont) => (font === bold ? amountBold : amountRegular);
  /** Text in the embedded figure face keeps ₹ and −; everything else goes through `pdfSafe` for WinAnsi. */
  const encode = (s: string, font: PDFFont) => (custom && (font === amountRegular || font === amountBold) ? s : pdfSafe(s));
  const first = view.personName.split(" ")[0];
  const settled = view.direction === "settled";
  const ZERO = money(0);
  const generated = GENERATED.format(options.now ?? new Date());

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M_TOP;

  /**
   * With the figure face loaded, a sentence's amounts ("₹1,715.25") are drawn in it too, so ₹ reads the same in
   * prose as in the columns: the string is split into text runs and amount runs.
   */
  const runs = (s: string, font: PDFFont): { s: string; font: PDFFont }[] =>
    custom && (font === regular || font === bold) && s.includes("₹")
      ? s.split(/(₹[\d,]+(?:\.\d+)?)/).filter(Boolean).map((part) => ({ s: part, font: part.startsWith("₹") ? amountFace(font) : font }))
      : [{ s, font }];
  /** `pdfSafe`, except that ₹ survives when the figure face can draw it. */
  const safeText = (t: string) => (custom ? pdfSafe(t.replace(/₹/g, "¤")).replace(/¤/g, "₹") : pdfSafe(t));
  /** Shortens to `w` with "...", measuring mixed text and amount runs. */
  const fit = (t: string, font: PDFFont, size: number, w: number) => {
    let s = safeText(t);
    while (s.length > 1 && width(s, size, font) > w) s = `${s.slice(0, -4)}...`;
    return s;
  };
  const width = (s: string, size: number, font: PDFFont = regular) => runs(s, font).reduce((w, r) => w + r.font.widthOfTextAtSize(encode(r.s, r.font), size), 0);
  const text = (s: string, x: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) => {
    let cx = x;
    for (const r of runs(s, font)) {
      page.drawText(encode(r.s, r.font), { x: cx, y: yy, size, font: r.font, color });
      cx += r.font.widthOfTextAtSize(encode(r.s, r.font), size);
    }
  };
  const textRight = (s: string, right: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    text(s, right - width(s, size, font), yy, size, font, color);
  const box = (x: number, yy: number, w: number, h: number, fill: RGB) => page.drawRectangle({ x, y: yy, width: w, height: h, color: fill });
  /**
   * A rounded rectangle (bottom-left at x, yy). `corners` picks which corners round — "top" for a panel's
   * header cell, "all" for a panel or a chip. With no fill it is an outline only.
   */
  const roundBox = (x: number, yy: number, w: number, h: number, r: number, fill?: RGB, border?: RGB, borderWidth = 0.6, corners: "all" | "top" | "bottom" = "all") => {
    const rr = Math.min(r, w / 2, h / 2);
    const top = corners !== "bottom" ? rr : 0;
    const bot = corners !== "top" ? rr : 0;
    // SVG space: y grows downward from the path origin (the box's top-left).
    const path = [
      `M ${top} 0 H ${w - top}`,
      top ? `A ${top} ${top} 0 0 1 ${w} ${top}` : "",
      `V ${h - bot}`,
      bot ? `A ${bot} ${bot} 0 0 1 ${w - bot} ${h}` : "",
      `H ${bot}`,
      bot ? `A ${bot} ${bot} 0 0 1 0 ${h - bot}` : "",
      `V ${top}`,
      top ? `A ${top} ${top} 0 0 1 ${top} 0` : "",
      "Z",
    ].join(" ");
    page.drawSvgPath(path, { x, y: yy + h, ...(fill ? { color: fill } : {}), ...(border ? { borderColor: border, borderWidth } : {}) });
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
  const amountRight = (s: string, right: number, yy: number, size: number, font: PDFFont, color: RGB, maxW = 400) =>
    textRight(s, right, yy, sizeToFit(s, size, amountFace(font), maxW), amountFace(font), color);
  /** A compact status chip (pill) whose text baseline is `yy`. */
  const chip = (label: string, x: number, yy: number, tone: Tone) => {
    // A narrow (portrait) status column steps the chip's text down rather than cutting a status word.
    const size = sizeToFit(label, T.chip, bold, STATUS_W - 15, 5.4);
    const s = fit(label, bold, size, STATUS_W - 15);
    const w = width(s, size, bold) + 15;
    roundBox(x, yy - 3.4, w, T.chip + 6, (T.chip + 6) / 2, tone.fill, tone.edge, 0.6);
    page.drawCircle({ x: x + 5.6, y: yy + 2, size: 1.7, color: tone.text });
    text(s, x + 10, yy, size, bold, tone.text);
    return w;
  };

  /**
   * Word wrap that never truncates: a word wider than the line is broken by characters. `firstW` lets the
   * first line run beside something while later lines take the full width.
   */
  const wrapWords = (label: string, w: number, font: PDFFont, size: number, firstW = w): string[] => {
    const lines: string[] = [];
    const limit = () => (lines.length === 0 ? firstW : w);
    let cur = "";
    // "Rs. 5,000" is one unit (a no-break space while wrapping), so an amount never splits across lines, and a
    // " · " separator stays at the end of its line instead of starting the next.
    const units = safeText(label.replace(/\s+/g, " ")).replace(/Rs\. /g, "Rs. ").replace(/ · /g, " ·  ");
    for (const word of units.split(/ +/).filter(Boolean)) {
      let piece = word;
      while (width(piece, size, font) > limit() && !cur) {
        let n = piece.length - 1;
        while (n > 1 && width(piece.slice(0, n), size, font) > limit()) n -= 1;
        lines.push(piece.slice(0, n));
        piece = piece.slice(n);
      }
      const next = cur ? `${cur} ${piece}` : piece;
      if (width(next, size, font) <= limit()) cur = next;
      else {
        lines.push(cur);
        cur = piece;
        while (width(cur, size, font) > limit()) {
          let n = cur.length - 1;
          while (n > 1 && width(cur.slice(0, n), size, font) > limit()) n -= 1;
          lines.push(cur.slice(0, n));
          cur = cur.slice(n);
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines.map((l) => l.replace(/ /g, " ")) : [""];
  };
  /** Keeps at most `max` lines; the last kept line carries the rest, shortened with "...". */
  const capLines = (lines: string[], max: number, font: PDFFont, size: number, w: number) =>
    lines.length <= max ? lines : [...lines.slice(0, max - 1), fit(lines.slice(max - 1).join(" "), font, size, w)];

  // ---------------- Panels: one connected outline per section per page ----------------
  // A section (column header → rows) is one rounded panel; rows inside share rules. On a page break the
  // panel closes on this page and reopens (with its header) on the next.
  let panelTop: number | null = null;
  const openPanel = () => {
    panelTop = y;
  };
  const closePanel = () => {
    if (panelTop == null) return;
    roundBox(M, y, TABLE_W, panelTop - y, RADIUS, undefined, RULE_STRONG, 0.8);
    panelTop = null;
  };
  /** The tinted header cell row at a panel's top; labels are drawn by the caller. */
  const panelHeader = (h: number) => {
    roundBox(M, y - h, TABLE_W, h, RADIUS, HEAD, undefined, 0, "top");
    hline(M, M + TABLE_W, y - h, RULE_STRONG, 0.6);
  };

  // ---------------- Header (first page) ----------------
  const drawHeader = () => {
    const top = y;
    // Brand row: wordmark + document name, generated date on the right, a hairline with a short navy accent.
    text("FlowFi", M, top - 11, 13, bold, NAVY);
    const lead = M + width("FlowFi", 13, bold) + 10;
    vline(lead - 5, top - 2, top - 13, RULE, 0.6);
    text("People Settlement Statement", lead, top - 11, 9.4, regular, BODY);
    const brandEnd = lead + width("People Settlement Statement", 9.4) + 16;
    const byline = fit(`Prepared by ${view.ownerName}  ·  Generated ${generated}`, regular, T.meta, M + TABLE_W - brandEnd);
    textRight(byline, M + TABLE_W, top - 11, T.meta, regular, MUTED);
    hline(M, M + TABLE_W, top - 19, RULE, 0.6);
    box(M, top - 19.8, 34, 1.6, NAVY);

    // Who, which period, as of when — labelled fields across the width.
    const fy = top - 31;
    const vy = top - 45;
    const nameW = TABLE_W * 0.44;
    text("STATEMENT FOR", M, fy, T.label - 0.3, bold, MUTED);
    text(fit(view.personName, bold, 15, nameW), M, vy, sizeToFit(view.personName, 15, bold, nameW, 9), bold, INK);
    const px = M + TABLE_W * 0.47;
    const ax = M + TABLE_W * 0.76;
    text("PERIOD", px, fy, T.label - 0.3, bold, MUTED);
    text(view.cycleLabel, px, vy, sizeToFit(view.cycleLabel, 10.5, regular, ax - px - 12, 7), regular, INK);
    text("AMOUNTS AS OF", ax, fy, T.label - 0.3, bold, MUTED);
    text(view.asOf, ax, vy, sizeToFit(view.asOf, 10.5, regular, M + TABLE_W - ax, 7), regular, INK);
    y = top - 54;
  };

  // ---------------- Statement summary: one panel that reads as a sum, ending in the balance ----------------
  const drawSummary = () => {
    const cells = statementSummaryCells(view);
    const recon = cells.filter((c) => !c.current && !c.advance);
    const primary = cells.find((c) => c.current)!;
    const advance = cells.find((c) => c.advance) ?? null;
    /** One figure: label, value, note — the primary result larger, in navy. `withOp` draws its "+ / − / =" before it. */
    const cell = (c: (typeof cells)[number], x: number, w: number, top: number, h: number, withOp: boolean) => {
      if (c.current) {
        // The one primary result: navy tint, navy edge, the largest figure on the page.
        box(x, top - h + 0.3, w, h - 0.6, NAVY_TINT);
        box(x, top - h + 0.3, 2.4, h - 0.6, NAVY);
      } else if (c.advance) box(x, top - h + 0.3, w - 0.3, h - 0.6, ADVANCE_TINT);
      else if (x > M) vline(x, top - 9, top - h + 9, RULE, 0.5);
      const op = withOp ? c.op : null;
      const ix = x + (op && !c.current ? 20 : 14);
      const iw = x + w - ix - 8;
      const valueY = c.current ? top - 31 : top - 27.5;
      if (op) {
        // The operator sits on the boundary, in line with the figures. A true minus is drawn as an en dash
        // (WinAnsi has no U+2212; `pdfSafe` would shrink it to a hyphen).
        const glyph = op === "−" ? "–" : op;
        page.drawText(glyph, { x: c.current ? x - 9 : x + 6, y: valueY - 0.5, size: 11, font: regular, color: MUTED });
      }
      text(fit(c.label.toUpperCase(), bold, T.label, iw), ix, top - 12.5, T.label, bold, c.current ? NAVY : c.advance ? ADVANCE : MUTED);
      const zero = c.value === ZERO;
      if (c.current) {
        text(c.value, ix, valueY, sizeToFit(c.value, 17, amountBold, iw, 9), amountBold, settled ? PAID_TEXT : NAVY);
        text(fit(c.note, regular, 7.6, iw), ix, top - 42.5, 7.6, regular, BODY);
      } else {
        text(c.value, ix, valueY, sizeToFit(c.value, 10.5, amountBold, iw, 6.5), zero ? amountRegular : amountBold, c.advance ? ADVANCE : zero ? MUTED : INK);
        if (c.note) text(fit(c.note, regular, T.caption, iw), ix, top - 37.5, T.caption, regular, MUTED);
      }
    };
    const top = y;
    if (portrait) {
      // Portrait: the answer (and any advance held apart) across the top, the sum that produces it underneath.
      const topH = 50;
      const sumH = 42;
      roundBox(M, top - topH - sumH, TABLE_W, topH + sumH, RADIUS, undefined, RULE_STRONG, 0.6);
      const advW = advance ? 176 : 0;
      cell(primary, M, TABLE_W - advW, top, topH, false);
      if (advance) cell(advance, M + TABLE_W - advW, advW, top, topH, false);
      hline(M, M + TABLE_W, top - topH, RULE, 0.5);
      recon.forEach((c, i) => cell(c, M + (i * TABLE_W) / recon.length, TABLE_W / recon.length, top - topH, sumH, true));
      y = top - topH - sumH;
    } else {
      // Landscape: one row read left to right as a sum, ending in the balance; an advance is held apart after it.
      const h = 50;
      const PRIMARY_W = 196;
      const ADVANCE_W = 150;
      const reconW = (TABLE_W - PRIMARY_W - (advance ? ADVANCE_W : 0)) / Math.max(1, recon.length);
      roundBox(M, top - h, TABLE_W, h, RADIUS, undefined, RULE_STRONG, 0.6);
      recon.forEach((c, i) => cell(c, M + i * reconW, reconW, top, h, true));
      cell(primary, M + recon.length * reconW, PRIMARY_W, top, h, true);
      if (advance) cell(advance, M + recon.length * reconW + PRIMARY_W, ADVANCE_W, top, h, false);
      y = top - h;
    }
    // Settlement progress: how much of the total due is already cleared, as one thin bar with its words.
    const p = view.settleProgress;
    if (p) {
      const by = y - 13;
      text("SETTLEMENT", M + 2, by, T.label, bold, MUTED);
      const bx = M + 2 + width("SETTLEMENT", T.label, bold) + 10;
      const labelW = width(p.label, T.meta + 0.3, regular);
      const bw = Math.max(60, TABLE_W * 0.5 - (bx - M));
      roundBox(bx, by - 0.5, bw, 4.5, 2.25, HEAD, RULE, 0.4);
      if (p.ratio > 0) roundBox(bx, by - 0.5, Math.max(4.5, bw * p.ratio), 4.5, 2.25, p.ratio >= 1 ? PAID_TEXT : NAVY);
      text(p.label, bx + bw + 10, by, T.meta + 0.3, regular, p.ratio >= 1 ? PAID_TEXT : BODY);
      if (view.cashNote) {
        const room = M + TABLE_W - (bx + bw + 10 + labelW + 20);
        if (room > 80) textRight(fit(view.cashNote, regular, T.meta, room), M + TABLE_W, by, T.meta, regular, MUTED);
        else {
          textRight(fit(view.cashNote, regular, T.meta, TABLE_W), M + TABLE_W, by - 11, T.meta, regular, MUTED);
          y -= 11;
        }
      }
      y -= 19;
    } else if (view.cashNote) {
      textRight(fit(view.cashNote, regular, T.meta, TABLE_W), M + TABLE_W, y - 10, T.meta, regular, MUTED);
      y -= 10;
    }
  };

  // ---------------- Continued header + column header (repeated on every page) ----------------
  /** Pages after the first: compact, but enough context that a printed page stands on its own. */
  const drawContinued = () => {
    text("FlowFi", M, y - 10, 9.5, bold, NAVY);
    const lead = width("FlowFi", 9.5, bold) + 8;
    const pendingW = width(`${view.current.label} `, 8.4, bold) + width(view.current.value, 8.4, amountBold);
    text(fit(`People Settlement Statement  ·  ${view.personName}  ·  ${view.cycleLabel}`, regular, 7.6, TABLE_W - lead - pendingW - 70), M + lead, y - 10, 7.6, regular, BODY);
    textRight(view.current.value, M + TABLE_W, y - 10, 8.4, amountBold, settled ? PAID_TEXT : NAVY);
    textRight(`${view.current.label} `, M + TABLE_W - width(view.current.value, 8.4, amountBold), y - 10, 8.4, bold, settled ? PAID_TEXT : NAVY);
    textRight("continued", M + TABLE_W - pendingW - 10, y - 10, T.caption, regular, MUTED);
    hline(M, M + TABLE_W, y - 16, RULE, 0.6);
    y -= 24;
  };
  const drawTableHeader = () => {
    openPanel();
    panelHeader(HEADER_H);
    COLUMNS.forEach((c, i) => {
      // The Amount column names whose share it is when that holds for every row ("SHAMBU'S SHARE").
      const label = fit((i === 4 ? view.amountHeader : c.label).toUpperCase(), bold, T.label, COL_W[i] - 2 * PAD);
      if (c.align === "right") textRight(label, colRight(i), y - 11, T.label, bold, BODY);
      else text(label, colX(i) + PAD, y - 11, T.label, bold, BODY);
    });
    for (const i of [3, 7]) vline(colX(i), y - 3, y - HEADER_H + 3, RULE_STRONG, 0.5);
    y -= HEADER_H;
  };

  type PanelKind = "table" | "payments" | null;
  let panelKind: PanelKind = null;
  let redrawPanelHeader: () => void = () => {};
  const newPage = () => {
    closePanel();
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M_TOP;
    drawContinued();
    if (panelKind) redrawPanelHeader();
  };
  /** A unit (a transaction with its shares, a heading with what follows it) is never split across pages. */
  const ensure = (h: number) => {
    if (y - h < CONTENT_BOTTOM) newPage();
  };

  // ---------------- Shares strip (part of a split row) ----------------
  // A genuine split (2+ people) gets one connected line under its row: every stored allocation as
  // "Name ₹amount", the recipient's in bold. Names wrap by word (never cut), an amount stays with its name.
  const STRIP_X = colX(2) + PAD;
  const STRIP_LABEL = "SHARES";
  const STRIP_FLOW_X = STRIP_X + width(STRIP_LABEL, T.label - 0.3, bold) + 8;
  const STRIP_RIGHT = M + TABLE_W - PAD;
  const layoutShares = (a: SplitAllocation): Run[][] => {
    const maxW = STRIP_RIGHT - STRIP_FLOW_X;
    const SEP = 14;
    const lines: Run[][] = [[]];
    let x = 0;
    const place = (r: Omit<Run, "x">, gap: number) => {
      const w = width(r.text, SHARE_SIZE, r.font);
      if (x > 0 && x + gap + w > maxW) {
        lines.push([]);
        x = 0;
        gap = 0;
      }
      lines[lines.length - 1].push({ ...r, x: x + gap });
      x += gap + w;
    };
    const units: Omit<Run, "x">[][] = a.participants.map((p) => [
      { text: p.label, font: p.isFocus ? bold : regular, color: p.isFocus ? INK : BODY },
      { text: money(p.amount), font: amountBold, color: p.amount === 0 ? MUTED : INK },
    ]);
    if (!a.reconciles) units.push([{ text: `Allocated ${money(a.allocated)} of ${money(a.original)}`, font: regular, color: MUTED }]);
    for (const unit of units) {
      const unitW = unit.reduce((s, r, i) => s + width(r.text, SHARE_SIZE, r.font) + (i > 0 ? 4 : 0), 0);
      const sep = x > 0 ? SEP : 0;
      if (x > 0 && x + sep + unitW > maxW && unitW <= maxW) {
        lines.push([]);
        x = 0;
      }
      if (unitW <= maxW) {
        unit.forEach((r, i) => place(r, i === 0 ? (x > 0 ? SEP : 0) : 4));
        continue;
      }
      // Wider than a whole line (a very long name): its words flow, the amount stays with the last word.
      const [name, ...rest] = unit;
      const words = pdfSafe(name.text).split(/\s+/);
      words.forEach((wd, i) => place({ ...name, text: wd }, i === 0 ? (x > 0 ? SEP : 0) : 3));
      rest.forEach((r) => place(r, 4));
    }
    return lines;
  };
  const sharesH = (lines: Run[][]) => lines.length * SHARE_LH + 2 * SHARE_PAD - 1;
  const drawShares = (lines: Run[][], top: number) => {
    const h = sharesH(lines);
    box(colX(2), top - h, M + TABLE_W - colX(2) - 0.6, h, SPLIT_TINT);
    hline(colX(2), M + TABLE_W - 0.6, top, NAVY_RULE, 0.6);
    const base = top - SHARE_PAD - SHARE_SIZE + 0.6;
    text(STRIP_LABEL, STRIP_X, base + 0.3, T.label - 0.3, bold, SPLIT);
    lines.forEach((line, li) => {
      for (const r of line) text(r.text, STRIP_FLOW_X + r.x, base - li * SHARE_LH, SHARE_SIZE, r.font, r.color);
    });
  };

  // ---------------- Rows ----------------
  // Each transaction is one unit: the title (regular — the figures carry the weight), a quiet meta line (type ·
  // what it means · cycle), then the money in fixed columns: Original only when it differs from the Amount, the
  // Amount (captioned with whose share it is only beside an Original), Paid, Remaining, and the status chip.
  const layoutRow = (row: StatementViewRow) => {
    const a = row.allocation ?? null;
    const shares = a && a.participants.length >= 2 ? layoutShares(a) : null;
    // The narrower portrait description column wraps more, so it keeps one more line before shortening.
    const titleLines = capLines(wrapWords(row.title, DESC_W, regular, T.title), portrait ? 4 : 3, regular, T.title, DESC_W);
    // A legacy split (no participant list) or a single-carrier allocation that doesn't add up says so here.
    const mismatch = a && !shares && !a.reconciles && a.participants.length > 0 ? `Allocated ${money(a.allocated)} of ${money(a.original)}` : "";
    // The cycle a brought-forward row came from is its group heading, so the meta line never repeats it.
    const metaLines = capLines(wrapWords(row.metaLine, DESC_W, regular, T.meta), 3, regular, T.meta, DESC_W);
    const descBottom = LINE1 + (titleLines.length - 1) * TITLE_LH + metaLines.length * META_LH + (mismatch ? NOTE_LH : 0) + 9;
    const noteLines = row.statusNote ? capLines(wrapWords(row.statusNote, STATUS_W, regular, T.caption), 2, regular, T.caption, STATUS_W) : [];
    const statusBottom = LINE1 + 4 + noteLines.length * NOTE_LH + 9;
    const amountBottom = LINE1 + (row.purchase || row.shareLabel ? 9 : 0) + 9;
    const mainH = Math.max(descBottom, statusBottom, amountBottom, 32);
    const h = mainH + (shares ? sharesH(shares) : 0);
    return { shares, titleLines, metaLines, mismatch, noteLines, mainH, h };
  };
  const drawRow = (row: StatementViewRow, tail = 0) => {
    const l = layoutRow(row);
    ensure(l.h + tail);
    const top = y;
    const line1 = top - LINE1;
    const line2 = line1 - 9;
    const split = row.purchase != null || l.shares != null;
    // A split is marked by a thin slate-blue edge down the whole unit (row + shares).
    // The Remaining column's faint band, and dividers that frame the money columns.
    box(colX(6), top - l.mainH, COL_W[6], l.mainH, REMAIN_TINT);
    for (const i of [3, 7]) vline(colX(i), top, top - l.mainH, RULE, 0.5);
    if (split) box(M + 0.4, top - l.h, 2.2, l.h, SPLIT);
    // # and date — "19 Sep"; a quieter year below only when it isn't the statement period's year.
    textRight(row.no, colRight(0) - 1, line1, T.meta, regular, MUTED);
    const date = statementDate(view, row.date);
    text(date.day, colX(1) + PAD, line1, T.meta + 0.6, regular, INK);
    if (date.year) text(date.year, colX(1) + PAD, line1 - 9, T.caption, regular, MUTED);
    // Description: title, then the meta line.
    const dx = colX(2) + PAD;
    l.titleLines.forEach((t, ti) => text(t, dx, line1 - ti * TITLE_LH, T.title, regular, INK));
    let ly = line1 - (l.titleLines.length - 1) * TITLE_LH - 1;
    for (const m of l.metaLines) {
      ly -= META_LH;
      text(m, dx, ly, T.meta, regular, MUTED);
    }
    if (l.mismatch) text(l.mismatch, dx, ly - NOTE_LH, T.caption, regular, MUTED);
    // Original (split only) → Amount → Paid → Remaining.
    const maxW = (i: number) => COL_W[i] - 2 * PAD;
    if (row.purchase) {
      amountRight(row.purchase, colRight(3), line1, T.money, regular, BODY, maxW(3));
      if (row.purchaseNote) textRight(fit(row.purchaseNote, regular, T.caption, maxW(3)), colRight(3), line2, T.caption, regular, MUTED);
    }
    if (row.original) {
      amountRight(row.original, colRight(4), line1, T.money + 0.2, bold, INK, maxW(4));
      if (row.shareLabel) textRight(fit(row.shareLabel, regular, T.caption, maxW(4)), colRight(4), line2, T.caption, regular, MUTED);
    } else textRight("-", colRight(4), line1, T.money, regular, MUTED);
    // Nothing paid yet reads as a quiet dash, so a column of ₹0 doesn't compete with what's left to pay.
    if (row.paid && row.paid !== ZERO) amountRight(row.paid, colRight(5), line1, T.money, regular, PAID_TEXT, maxW(5));
    else textRight("-", colRight(5), line1, T.money, regular, MUTED);
    if (row.remaining) {
      const zero = row.remaining === ZERO;
      const tone = zero ? MUTED : row.chip === "overdue" ? OVERDUE_TEXT : INK;
      amountRight(row.remaining, colRight(6), line1, T.money + 0.2, zero ? regular : bold, tone, maxW(6));
    } else textRight("-", colRight(6), line1, T.money, regular, MUTED);
    // Status chip + a note only when it says something new.
    // A partly paid row shows how far it is paid down: a thin bar under its Remaining amount.
    if (row.progress != null) {
      const bw = COL_W[6] - 2 * PAD - 6;
      const bx = colRight(6) - bw;
      roundBox(bx, line1 - 9.5, bw, 3, 1.5, WHITE, RULE, 0.4);
      roundBox(bx, line1 - 9.5, Math.max(3, bw * row.progress), 3, 1.5, CHIP.partial.edge);
    }
    chip(row.status, colX(7) + PAD, line1, CHIP[row.chip]);
    l.noteLines.forEach((s, si) => text(s, colX(7) + PAD, line1 - 11 - si * NOTE_LH, T.caption, regular, MUTED));
    if (l.shares) drawShares(l.shares, top - l.mainH);
    y = top - l.h;
    hline(M, M + TABLE_W, y, RULE, 0.6);
  };

  // ---------------- Section rows (inside the table panel, each kept with what follows it) ----------------
  const { previous, showPrevious, groupOf } = statementSections(view);
  /** The carry-forward line: the previous balance on its own, before the obligations it is made of. */
  const carryRow = (next: number) => {
    ensure(CARRY_H + next);
    box(M + 0.3, y - CARRY_H, TABLE_W - 0.6, CARRY_H, SURFACE);
    text(STATEMENT_COPY.carried.label.toUpperCase(), colX(2) + PAD, y - 11.5, T.label + 0.3, bold, CHIP.carried.text);
    const note = [STATEMENT_COPY.carried.note, previous?.side].filter(Boolean).join("  ·  ");
    text(fit(note, regular, T.meta, colX(3) - colX(2) - 2 * PAD), colX(2) + PAD, y - 20.5, T.meta, regular, MUTED);
    if (previous) amountRight(previous.value, colRight(6), y - 11.5, T.money + 0.4, bold, INK, COL_W[6] - 2 * PAD);
    chip("Brought forward", colX(7) + PAD, y - 11.5, CHIP.carried);
    y -= CARRY_H;
    hline(M, M + TABLE_W, y, RULE, 0.5);
  };
  /** THIS CYCLE: a navy-tinted divider row (label + the cycle) — and, when nothing is new, the notice itself. */
  const cycleBand = (note: string, next: number) => {
    ensure(SECTION_H + next);
    box(M + 0.3, y - SECTION_H, TABLE_W - 0.6, SECTION_H, NAVY_TINT);
    const l = STATEMENT_COPY.current.toUpperCase();
    text(l, colX(2) + PAD, y - 12, T.label + 0.5, bold, NAVY);
    const lw = width(l, T.label + 0.5, bold);
    text(fit(note, regular, T.meta, TABLE_W - lw - 120), colX(2) + PAD + lw + 10, y - 12, T.meta, regular, BODY);
    y -= SECTION_H;
    hline(M, M + TABLE_W, y, NAVY_RULE, 0.6);
  };
  /** Group heading (a brought-forward cycle, or a month): a small uppercase label on a light surface row. */
  const monthHeading = (month: string, next: number) => {
    ensure(MONTH_H + next);
    box(M + 0.3, y - MONTH_H, TABLE_W - 0.6, MONTH_H, SURFACE);
    text(month.toUpperCase(), colX(1) + PAD, y - 10.8, T.label + 0.2, bold, NAVY);
    y -= MONTH_H;
    hline(M, M + TABLE_W, y, RULE, 0.5);
  };
  const allRows = [...view.carried, ...view.rows];
  /** `tail` reserves room after the list's last row (the ending balance), so the conclusion never stands alone. */
  const drawRows = (rows: StatementViewRow[], tail = 0) => {
    let group: string | null = null;
    rows.forEach((r, i) => {
      const last = i === rows.length - 1 ? tail : 0;
      const g = groupOf(r);
      if (g && g !== group) monthHeading(g, layoutRow(r).h + last);
      group = g;
      drawRow(r, last);
    });
  };
  const firstUnit = (rows: StatementViewRow[], tail = 0) => (rows.length === 0 ? tail : (groupOf(rows[0]) ? MONTH_H : 0) + layoutRow(rows[0]).h + (rows.length === 1 ? tail : 0));

  // ---------------- Payment history (grouped by real payment) ----------------
  const P_DATE = M + PAD;
  const P_LABEL = colX(2) + PAD;
  const P_APPLIED = colX(3) + PAD;
  const P_APPLIED_RIGHT = colRight(6);
  const P_AMOUNT_RIGHT = M + TABLE_W - PAD - 4;
  const P_LABEL_W = P_APPLIED - P_LABEL - 2 * PAD;
  const P_APPLIED_W = P_APPLIED_RIGHT - P_APPLIED;
  type Payment = (typeof view.payments)[number];
  const paymentLayout = (p: Payment) => {
    const labelLines = capLines(wrapWords(`${p.label}${p.account ? `  ·  ${p.account}` : ""}`, P_LABEL_W, regular, T.title - 0.4), 2, regular, T.title - 0.4, P_LABEL_W);
    const singleLines = p.single != null ? capLines(wrapWords(p.single, P_APPLIED_W, regular, T.meta), 2, regular, T.meta, P_APPLIED_W) : [];
    const appliedLines = p.single != null ? singleLines.length : p.applied.length + (p.applied.length > 1 ? 1 : 0) + (p.held ? 1 : 0);
    const h = Math.max(LINE1 + (labelLines.length - 1) * TITLE_LH, LINE1 + (appliedLines - 1) * 10) + 9;
    return { labelLines, singleLines, h };
  };
  const paymentHeader = () => {
    openPanel();
    panelHeader(HEADER_H);
    text("DATE", P_DATE, y - 11, T.label, bold, BODY);
    text("PAYMENT", P_LABEL, y - 11, T.label, bold, BODY);
    text("APPLIED TO", P_APPLIED, y - 11, T.label, bold, BODY);
    textRight("AMOUNT", P_AMOUNT_RIGHT, y - 11, T.label, bold, BODY);
    y -= HEADER_H;
  };
  const totals = [view.totalReceived && { label: `Total paid by ${first}`, value: view.totalReceived }, view.totalPaid && { label: `Total paid by ${view.ownerShort}`, value: view.totalPaid }].filter(Boolean) as {
    label: string;
    value: string;
  }[];
  const TOTAL_H = 17;
  const drawPayment = (p: Payment, tail: number) => {
    const l = paymentLayout(p);
    ensure(l.h + tail);
    const top = y;
    const line1 = top - LINE1;
    text(p.date, P_DATE, line1, T.meta + 0.4, regular, BODY);
    l.labelLines.forEach((s, i) => text(s, P_LABEL, line1 - i * TITLE_LH, T.title - 0.4, regular, INK));
    amountRight(p.amount, P_AMOUNT_RIGHT, line1, T.money + 0.2, bold, p.inbound ? PAID_TEXT : INK);
    if (p.single != null) {
      l.singleLines.forEach((s, i) => text(s, P_APPLIED, line1 - i * 10, T.meta, regular, BODY));
    } else {
      // Where one payment went: each obligation it cleared, what was applied, and what was held as an advance.
      let ly = line1;
      for (const a of p.applied) {
        text(fit(a.label, regular, T.meta, P_APPLIED_W - 70), P_APPLIED, ly, T.meta, regular, BODY);
        amountRight(a.amount, P_APPLIED_RIGHT, ly, T.meta, regular, INK);
        ly -= 10;
      }
      if (p.applied.length > 1) {
        hline(P_APPLIED, P_APPLIED_RIGHT, ly + 7.2, RULE, 0.5);
        text("Applied to obligations", P_APPLIED, ly, T.meta, bold, INK);
        amountRight(p.appliedTotal ?? "", P_APPLIED_RIGHT, ly, T.meta, bold, INK);
        ly -= 10;
      }
      if (p.held) {
        text("Held as advance", P_APPLIED, ly, T.meta, bold, ADVANCE);
        amountRight(p.held, P_APPLIED_RIGHT, ly, T.meta, bold, ADVANCE);
      }
    }
    y = top - l.h;
    hline(M, M + TABLE_W, y, RULE, 0.5);
  };

  // ---------------- Ending balance ----------------
  // The statement's conclusion, restating the answer in full. Its room is reserved with the last unit above it
  // (see `tail`), so it never lands alone on a page.
  const drawEnding = () => {
    ensure(END_GAP + END_H);
    y -= END_GAP;
    roundBox(M, y - END_H, TABLE_W, END_H, RADIUS, NAVY_TINT, NAVY_RULE, 0.6);
    box(M + 0.3, y - END_H + 0.3, 2.4, END_H - 0.6, NAVY);
    const endLine = settled ? "Settled - nothing left to settle" : view.headline;
    const dueLabel = settled ? "NOTHING DUE" : "AMOUNT DUE";
    const amountSize = sizeToFit(view.amount, 16, amountBold, 240, 10);
    const amountW = width(view.amount, amountSize, amountBold);
    text("ENDING BALANCE", M + 16, y - 15, T.label + 0.3, bold, NAVY);
    text(fit(endLine, bold, 11, TABLE_W - amountW - 80), M + 16, y - 31, 11, bold, INK);
    textRight(dueLabel, M + TABLE_W - 16, y - 15, T.label + 0.3, bold, NAVY);
    textRight(view.amount, M + TABLE_W - 16, y - 32, amountSize, amountBold, settled ? PAID_TEXT : NAVY);
    y -= END_H;
  };
  const ENDING = END_GAP + END_H;

  // ---------------- Compose ----------------
  drawHeader();
  drawSummary();
  y -= 14;
  const count = allRows.length;
  text("Transactions", M, y - 9, 10.5, bold, INK);
  text(`${count} ${count === 1 ? "item" : "items"}`, M + width("Transactions", 10.5, bold) + 10, y - 9, T.meta, regular, MUTED);
  y -= 15;
  const hasPayments = view.payments.length > 0;
  // The table's last unit carries the ending balance with it when no payment history follows.
  const tableTail = hasPayments ? 0 : ENDING;
  ensure(HEADER_H + firstUnit(showPrevious ? view.carried : view.rows, tableTail) + (showPrevious ? CARRY_H : 0));
  panelKind = "table";
  redrawPanelHeader = drawTableHeader;
  drawTableHeader();
  const emptyNote = `${view.cycleLabel}  ·  ${STATEMENT_COPY.empty}`;
  if (showPrevious) {
    carryRow(firstUnit(view.carried, view.rows.length ? 0 : tableTail));
    drawRows(view.carried);
    cycleBand(view.rows.length ? view.cycleLabel : emptyNote, firstUnit(view.rows, tableTail) || tableTail);
  } else if (view.rows.length === 0) cycleBand(emptyNote, tableTail);
  if (view.rows.length > 0) drawRows(view.rows, tableTail);
  closePanel();
  panelKind = null;

  if (hasPayments) {
    const totalsH = totals.length * TOTAL_H;
    const lastTail = totalsH + ENDING;
    const heading = 20;
    // The heading never sits alone at a page foot: it moves with the first payment.
    ensure(14 + heading + HEADER_H + paymentLayout(view.payments[0]).h + (view.payments.length === 1 ? lastTail : 0));
    y -= 14;
    text("Payment history", M, y - 9, 10.5, bold, INK);
    text("Payments this cycle and where each one went", M + width("Payment history", 10.5, bold) + 10, y - 9, T.meta, regular, MUTED);
    y -= 15;
    panelKind = "payments";
    redrawPanelHeader = paymentHeader;
    paymentHeader();
    view.payments.forEach((p, i) => drawPayment(p, i === view.payments.length - 1 ? lastTail : 0));
    for (const t of totals) {
      ensure(TOTAL_H);
      box(M + 0.3, y - TOTAL_H + 0.3, TABLE_W - 0.6, TOTAL_H - 0.3, SURFACE);
      textRight(t.label, P_APPLIED_RIGHT, y - 11.5, T.meta + 0.4, bold, INK);
      amountRight(t.value, P_AMOUNT_RIGHT, y - 11.5, T.money + 0.2, bold, INK);
      y -= TOTAL_H;
    }
    closePanel();
    panelKind = null;
  }
  drawEnding();

  // ---------------- Footer ----------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    // A thin navy band across the top of every page: the statement's mark, even on a page printed alone.
    p.drawRectangle({ x: 0, y: PAGE_H - 5, width: PAGE_W, height: 5, color: NAVY });
    p.drawLine({ start: { x: M, y: FOOTER_RULE_Y }, end: { x: M + TABLE_W, y: FOOTER_RULE_Y }, thickness: 0.5, color: RULE });
    const pageLabel = `Page ${i + 1} of ${pages.length}`;
    const pageW = bold.widthOfTextAtSize(pageLabel, 6.8);
    p.drawText(pageLabel, { x: M + TABLE_W - pageW, y: 15, size: 6.8, font: bold, color: BODY });
    const prepared = fit(`Prepared by ${view.ownerName}  ·  `, regular, 6.8, 220);
    const preparedW = regular.widthOfTextAtSize(prepared, 6.8);
    p.drawText(prepared, { x: M + TABLE_W - pageW - preparedW, y: 15, size: 6.8, font: regular, color: MUTED });
    const left = fit(`FlowFi  ·  Statement for ${view.personName}  ·  ${view.cycleLabel}`, regular, 6.8, TABLE_W - preparedW - pageW - 16);
    p.drawText(left, { x: M, y: 15, size: 6.8, font: regular, color: MUTED });
  });
  // Open on page 1 scaled to the page width, the window fitted to the page — a viewer setting (honoured by
  // Acrobat and most desktop readers; browsers and phone viewers may ignore it). No script is embedded.
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj([pages[0].ref, PDFName.of("FitH"), PDFNull]));
  doc.catalog.getOrCreateViewerPreferences().setFitWindow(true);
  return doc.save();
}
