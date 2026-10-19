/**
 * A4 People settlement statement (landscape by default, portrait on request) — the PDF twin of the Share Statement
 * preview, laid out as a private-banking statement, never a dashboard: no charts, no KPI tiles, one balance answer.
 * Rendered solely from `statementView`: every amount, label, type and status comes from the statement engine through
 * the shared presentation layer; nothing here does arithmetic on money (the only numbers computed are layout
 * coordinates).
 *
 * The statement is read by the person, so it never says "you": both parties are named ("Sojan owes Abin John").
 *
 * Design ("Midnight & Champagne", tokens in `statement-palette`): a midnight header band carries the brand, who the
 * statement is for and the one answer (the balance due); the body is white paper — the reconciliation card, then
 * each section as one connected panel (column header → rows) with quiet hairlines and fixed money columns, so
 * figures line up down the page. The document closes on a midnight panel (the table's total, the ending balance)
 * that mirrors the header. Type: Plus Jakarta Sans (the app's face) for words, Geist Mono for figures, small-caps
 * labels with letter-spacing — each when its bytes are given; otherwise Helvetica with "Rs.". Every colour supports
 * a word, so the statement stays clear in greyscale print.
 */
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PDFName,
  PDFNull,
  StandardFonts,
  clip,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setCharacterSpacing,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import {
  STATEMENT_COPY,
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
const FAINT = hex(STATEMENT_INK.faint);
const RULE = hex(STATEMENT_INK.rule);
const RULE_STRONG = hex(STATEMENT_INK.ruleStrong);
const SURFACE = hex(STATEMENT_INK.surface);
const HEAD = hex(STATEMENT_INK.head);
const NAVY = hex(STATEMENT_INK.navy);
const NAVY_TINT = hex(STATEMENT_INK.navyTint);
const NAVY_RULE = hex(STATEMENT_INK.navyRule);
const MIDNIGHT = hex(STATEMENT_INK.midnight);
const MIDNIGHT_LINE = hex(STATEMENT_INK.midnightLine);
const ON_MID = hex(STATEMENT_INK.onMidnight);
const ON_MID_MUTED = hex(STATEMENT_INK.onMidnightMuted);
const GOLD = hex(STATEMENT_INK.gold);
const GOLD_LIGHT = hex(STATEMENT_INK.goldLight);
const SETTLED_ON_MID = hex(STATEMENT_INK.settledOnMidnight);
const REMAIN_TINT = hex(STATEMENT_INK.remainTint);
const SPLIT = hex(STATEMENT_INK.split);
const ADVANCE = hex(STATEMENT_INK.advance);
const ADVANCE_TINT = hex(STATEMENT_INK.advanceTint);
const WHITE = rgb(1, 1, 1);
type Tone = { fill: RGB; text: RGB; edge: RGB };
const CHIP = Object.fromEntries(
  Object.entries(STATEMENT_CHIP).map(([k, v]) => [k, { fill: hex(v.fill), text: hex(v.text), edge: hex(v.edge) }]),
) as Record<StatementChip, Tone>;
const PAID_TEXT = CHIP.paid.text;
const OVERDUE_TEXT = CHIP.overdue.text;

/** Type roles (pt). Hierarchy comes from size, weight and tracking; figures are monospaced so columns align. */
const T = {
  title: 9,
  money: 8.5,
  label: 5.9,
  meta: 7,
  caption: 6.5,
  chip: 6.2,
} as const;
/** Letter-spacing of the small-caps labels (pt per glyph). */
const TRACK = 0.7;

export type StatementOrientation = "portrait" | "landscape";

/** TTF bytes for the amount figures (Geist Mono Regular / SemiBold, from `public/fonts/geist-mono`). */
export interface StatementAmountFonts {
  regular: ArrayBuffer | Uint8Array;
  bold: ArrayBuffer | Uint8Array;
}

/** TTF bytes for the words (Plus Jakarta Sans — the app's face — from `public/fonts/plus-jakarta-sans`). */
export interface StatementTextFonts {
  regular: ArrayBuffer | Uint8Array;
  medium: ArrayBuffer | Uint8Array;
  semibold: ArrayBuffer | Uint8Array;
  bold: ArrayBuffer | Uint8Array;
  extrabold: ArrayBuffer | Uint8Array;
}

async function fetchAll(base: string, files: string[]): Promise<ArrayBuffer[]> {
  return Promise.all(
    files.map(async (file) => {
      const res = await fetch(`${base}/${file}`);
      if (!res.ok) throw new Error(file);
      return res.arrayBuffer();
    }),
  );
}

/** Fetches the amount fonts in the browser; null when they can't be loaded (the PDF then keeps Helvetica and "Rs."). */
export async function loadStatementAmountFonts(base = "/fonts/geist-mono"): Promise<StatementAmountFonts | null> {
  try {
    const [regular, bold] = await fetchAll(base, ["GeistMono-Regular.ttf", "GeistMono-SemiBold.ttf"]);
    return { regular, bold };
  } catch {
    return null;
  }
}

/** Fetches the text faces in the browser; null when they can't be loaded (the PDF then keeps Helvetica). */
export async function loadStatementTextFonts(base = "/fonts/plus-jakarta-sans"): Promise<StatementTextFonts | null> {
  try {
    const [regular, medium, semibold, bold, extrabold] = await fetchAll(
      base,
      ["Regular", "Medium", "SemiBold", "Bold", "ExtraBold"].map((w) => `PlusJakartaSans-${w}.ttf`),
    );
    return { regular, medium, semibold, bold, extrabold };
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
/** The first page's midnight header band, and the slimmer band that opens every later page. */
const HERO_H = 84;
const CONT_H = 30;
/** The footer rule's height; footer text sits below it. */
const FOOTER_RULE_Y = 26;
/** The lowest point any content may reach — every keep-together check uses this one floor. */
const CONTENT_BOTTOM = FOOTER_RULE_Y + 8;
const RADIUS = 6;
/** A row's first baseline, below its top. */
const LINE1 = 15;
const TITLE_LH = 10.6;
const META_LH = 8.7;
const NOTE_LH = 8.2;
const HEADER_H = 18;
/** Divider weight inside a panel; every tinted area starts just below the line above it (TOP_GAP) so no rule is painted over. */
const LINE_W = 0.7;
const TOP_GAP = 0.45;
const MONTH_H = 16;
const SECTION_H = 18;
const CARRY_H = 26;
/** The ending balance panel and the gap above it. */
const END_H = 42;
const END_GAP = 12;
/** The share pills under a split row: text size, line pitch, room below the last line, and how far they tuck up. */
const SHARE_SIZE = 7;
const SHARE_LH = 15;
const SHARE_PAD = 5;
const SHARE_TUCK = 5;

const GENERATED = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Grid columns for N participants: one row up to 6, then two balanced rows (8 → 4 + 4), capped at 6 per row. */
export function allocationColumns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 6) return n;
  return Math.min(6, Math.ceil(n / 2));
}

/** Which corners of a box are rounded. */
type Corners = "all" | "top" | "bottom" | "left" | "right" | "none" | { tl: boolean; tr: boolean; br: boolean; bl: boolean };

/**
 * Renders the statement. `options` (the person's ledger entries, the whole-history statement, account names and
 * the owner's display name) only sharpen the wording — assigned vs split, payments made in a later cycle, the
 * account a payment moved through, who the owner is — and never change a figure. `textFonts` / `amountFonts` only
 * change the typeface.
 */
export async function renderPersonStatementPdf(
  statement: PersonCycleStatement,
  options: StatementViewOptions & { orientation?: StatementOrientation; amountFonts?: StatementAmountFonts | null; textFonts?: StatementTextFonts | null } = {},
): Promise<Uint8Array> {
  const { portrait, PAGE_W, PAGE_H, M, PAD, TABLE_W, COLUMNS, COL_W, colX, colRight, DESC_W, STATUS_W } = pageGeometry(options.orientation ?? "landscape");
  const view = statementView(statement, options);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${view.personName} - People Statement - ${view.cycleLabel}`));
  doc.setAuthor(pdfSafe(view.ownerName));
  doc.setProducer("FlowFi");
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const amountCustom = options.amountFonts ?? null;
  const textCustom = options.textFonts ?? null;
  if (amountCustom || textCustom) doc.registerFontkit(fontkit);
  const embed = (bytes: ArrayBuffer | Uint8Array) => doc.embedFont(bytes, { subset: true });
  // Words in Plus Jakarta Sans (five weights) when given; otherwise Helvetica / Helvetica-Bold stand in.
  const regular = textCustom ? await embed(textCustom.regular) : helvetica;
  const medium = textCustom ? await embed(textCustom.medium) : helvetica;
  const semi = textCustom ? await embed(textCustom.semibold) : helveticaBold;
  const bold = textCustom ? await embed(textCustom.bold) : helveticaBold;
  const heavy = textCustom ? await embed(textCustom.extrabold) : helveticaBold;
  // Figures in Geist Mono (the app's figure face) when given: even-width digits that line up down a column, and
  // the real ₹ sign. Without it every figure stays in the text face.
  const amountRegular = amountCustom ? await embed(amountCustom.regular) : regular;
  const amountBold = amountCustom ? await embed(amountCustom.bold) : bold;
  const textFaces = new Set<PDFFont>([regular, medium, semi, bold, heavy]);
  const isHeavy = (font: PDFFont) => font === semi || font === bold || font === heavy || font === amountBold;
  const amountFace = (font: PDFFont) => (isHeavy(font) ? amountBold : amountRegular);
  /** Embedded faces draw Unicode (₹, −, →); a glyph a face lacks falls back to its WinAnsi spelling, or is left out. */
  const unicodeFaces = new Set<PDFFont>([...(textCustom ? [regular, medium, semi, bold, heavy] : []), ...(amountCustom ? [amountRegular, amountBold] : [])]);
  const charsets = new Map<PDFFont, Set<number>>();
  const charset = (font: PDFFont) => {
    let set = charsets.get(font);
    if (!set) charsets.set(font, (set = new Set(font.getCharacterSet())));
    return set;
  };
  const encode = (s: string, font: PDFFont) => {
    if (!unicodeFaces.has(font)) return pdfSafe(s);
    const cs = charset(font);
    let out = "";
    for (const ch of s) {
      if (cs.has(ch.codePointAt(0)!)) out += ch;
      else out += [...pdfSafe(ch)].filter((c) => cs.has(c.codePointAt(0)!)).join("");
    }
    return out;
  };
  const first = view.personName.split(" ")[0];
  const settled = view.direction === "settled";
  const ZERO = money(0);
  const generated = GENERATED.format(options.now ?? new Date());

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H;

  /**
   * With the figure face loaded, a sentence's amounts ("₹1,715.25") are drawn in it too, so ₹ reads the same in
   * prose as in the columns: the string is split into text runs and amount runs.
   */
  const runs = (s: string, font: PDFFont): { s: string; font: PDFFont }[] =>
    amountCustom && textFaces.has(font) && s.includes("₹")
      ? s.split(/(₹[\d,]+(?:\.\d+)?)/).filter(Boolean).map((part) => ({ s: part, font: part.startsWith("₹") ? amountFace(font) : font }))
      : [{ s, font }];
  /** The text as it will be drawn: Unicode with embedded faces, WinAnsi (`pdfSafe`, ₹ kept for the figure face) without. */
  const safeText = (t: string) => (textCustom ? t : amountCustom ? pdfSafe(t.replace(/₹/g, "¤")).replace(/¤/g, "₹") : pdfSafe(t));
  const width = (s: string, size: number, font: PDFFont = regular) => runs(s, font).reduce((w, r) => w + r.font.widthOfTextAtSize(encode(r.s, r.font), size), 0);
  /** Shortens to `w` with "...", measuring mixed text and amount runs. */
  const fit = (t: string, font: PDFFont, size: number, w: number) => {
    let s = safeText(t);
    while (s.length > 1 && width(s, size, font) > w) s = `${s.slice(0, -4)}...`;
    return s;
  };
  const text = (s: string, x: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) => {
    let cx = x;
    for (const r of runs(s, font)) {
      const e = encode(r.s, r.font);
      if (e) page.drawText(e, { x: cx, y: yy, size, font: r.font, color });
      cx += r.font.widthOfTextAtSize(e, size);
    }
  };
  const textRight = (s: string, right: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    text(s, right - width(s, size, font), yy, size, font, color);
  /** A small-caps label with letter-spacing — the statement's quiet signposts. */
  const trackedWidth = (s: string, size: number, font: PDFFont = semi, track = TRACK) => width(s, size, font) + track * Math.max(0, [...s].length - 1);
  const tracked = (s: string, x: number, yy: number, size: number, font: PDFFont = semi, color: RGB = MUTED, track = TRACK) => {
    page.pushOperators(setCharacterSpacing(track));
    text(s, x, yy, size, font, color);
    page.pushOperators(setCharacterSpacing(0));
  };
  const trackedRight = (s: string, right: number, yy: number, size: number, font: PDFFont = semi, color: RGB = MUTED, track = TRACK) =>
    tracked(s, right - trackedWidth(s, size, font, track), yy, size, font, color, track);
  const box = (x: number, yy: number, w: number, h: number, fill: RGB) => page.drawRectangle({ x, y: yy, width: w, height: h, color: fill });
  /**
   * A rounded rectangle (bottom-left at x, yy). `corners` picks which corners round. With no fill it is an outline.
   */
  const roundBox = (x: number, yy: number, w: number, h: number, r: number, fill?: RGB, border?: RGB, borderWidth = 0.6, corners: Corners = "all") => {
    const rr = Math.min(r, w / 2, h / 2);
    const c =
      typeof corners === "object"
        ? corners
        : {
            tl: corners === "all" || corners === "top" || corners === "left",
            tr: corners === "all" || corners === "top" || corners === "right",
            br: corners === "all" || corners === "bottom" || corners === "right",
            bl: corners === "all" || corners === "bottom" || corners === "left",
          };
    const [tl, tr, br, bl] = [c.tl, c.tr, c.br, c.bl].map((on) => (on ? rr : 0));
    // SVG space: y grows downward from the path origin (the box's top-left).
    const path = [
      `M ${tl} 0 H ${w - tr}`,
      tr ? `A ${tr} ${tr} 0 0 1 ${w} ${tr}` : "",
      `V ${h - br}`,
      br ? `A ${br} ${br} 0 0 1 ${w - br} ${h}` : "",
      `H ${bl}`,
      bl ? `A ${bl} ${bl} 0 0 1 0 ${h - bl}` : "",
      `V ${tl}`,
      tl ? `A ${tl} ${tl} 0 0 1 ${tl} 0` : "",
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
  /**
   * Fine concentric rings, clipped to a midnight area — the guilloché of a banknote or a premium card, drawn as
   * hairlines one shade off the ground so they never compete with the text.
   */
  const ornament = (cx: number, cy: number, area: { x: number; y: number; w: number; h: number }, radii: number[]) => {
    page.pushOperators(pushGraphicsState(), rectangle(area.x, area.y, area.w, area.h), clip(), endPath());
    for (const r of radii) page.drawCircle({ x: cx, y: cy, size: r, borderColor: MIDNIGHT_LINE, borderWidth: 0.7 });
    page.pushOperators(popGraphicsState());
  };
  /** "+ / − / =" in a small ring on a boundary — the reconciliation read as one sum. */
  const opGlyph = (op: "+" | "−" | "=") => (op === "−" ? (textCustom ? "−" : "–") : op);
  const operator = (op: "+" | "−" | "=", cx: number, cy: number, onMidnight = false) => {
    page.drawCircle({ x: cx, y: cy, size: 6, color: onMidnight ? MIDNIGHT : WHITE, borderColor: onMidnight ? MIDNIGHT_LINE : RULE_STRONG, borderWidth: 0.6 });
    const g = opGlyph(op);
    const f = textCustom ? medium : helvetica;
    const w = f.widthOfTextAtSize(g, 8.5);
    page.drawText(g, { x: cx - w / 2, y: cy - 3, size: 8.5, font: f, color: onMidnight ? ON_MID : MUTED });
  };
  /**
   * A status icon, drawn as strokes in a 10×10 box (top-left at x, top) so it needs no glyph: a clock for due, a check
   * for paid, a half-filled ring for part paid, "!" for overdue, an arrow for moved / upcoming, a return arrow for
   * brought forward, "+" for an advance.
   */
  const statusIcon = (kind: StatementChip, x: number, top: number, color: RGB) => {
    const s = 0.82;
    const stroke = (d: string) => page.drawSvgPath(d, { x, y: top, scale: s, borderColor: color, borderWidth: 1.15, borderLineCap: 1 });
    const ring = () => page.drawCircle({ x: x + 5 * s, y: top - 5 * s, size: 4 * s, borderColor: color, borderWidth: 0.95 });
    switch (kind) {
      case "due":
        ring();
        stroke("M5 2.8 V5.2 L6.6 6.2");
        break;
      case "paid":
        stroke("M1.8 5.4 L4.1 7.6 L8.4 2.8");
        break;
      case "partial":
        ring();
        page.drawSvgPath("M5 1 A4 4 0 0 1 5 9 Z", { x, y: top, scale: s, color });
        break;
      case "overdue":
        ring();
        stroke("M5 2.7 V5.6");
        page.drawCircle({ x: x + 5 * s, y: top - 7.3 * s, size: 0.62, color });
        break;
      case "upcoming":
        stroke("M1.8 5 H8.2 M5.6 2.4 L8.2 5 L5.6 7.6");
        break;
      case "carried":
        stroke("M8 2.2 V4.9 Q8 7 5.9 7 H2.2 M4.3 4.9 L2.2 7 L4.3 9.1");
        break;
      case "advance":
        ring();
        stroke("M5 3 V7 M3 5 H7");
        break;
      default:
        page.drawCircle({ x: x + 5 * s, y: top - 5 * s, size: 1.7, color });
    }
  };
  /**
   * A status tag whose text baseline is `yy`: a soft tinted fill with a hairline edge (so it prints), its icon, and
   * the status in semibold — one shape and one colour family per meaning, everywhere in the statement.
   */
  const chip = (label: string, x: number, yy: number, kind: StatementChip) => {
    const tone = CHIP[kind];
    const ICON = 9.5;
    const padL = 5;
    const padR = 6.5;
    const room = STATUS_W - padL - ICON - padR;
    // A narrow (portrait) status column steps the text down rather than cutting a status word.
    const size = sizeToFit(label, T.chip + 0.3, semi, room, 5.4);
    const s = fit(label, semi, size, room);
    const w = padL + ICON + width(s, size, semi) + padR;
    const h = T.chip + 8;
    const bottom = yy - 4.3;
    roundBox(x, bottom, w, h, 4, tone.fill, tone.edge, 0.45);
    statusIcon(kind, x + padL - 0.6, bottom + h / 2 + 4.1, tone.text);
    text(s, x + padL + ICON, yy, size, semi, tone.text);
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
    const units = safeText(label.replace(/\s+/g, " ")).replace(/Rs\. /g, "Rs. ").replace(/ · /g, " · ");
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
    return lines.length ? lines.map((l) => l.replace(/ /g, " ")) : [""];
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
    hline(M, M + TABLE_W, y - h, RULE_STRONG, 0.8);
  };

  // ---------------- Header band (first page) ----------------
  // Midnight, full bleed: the brand and the document's name, who it is for, the period and date, and — on the
  // right, the largest figure in the document — the balance due with who owes whom.
  const drawHero = () => {
    const bottom = PAGE_H - HERO_H;
    const top = PAGE_H;
    box(0, bottom, PAGE_W, HERO_H, MIDNIGHT);
    // Brand row.
    text("FlowFi", M, top - 24, 14, heavy, WHITE);
    const bx = M + width("FlowFi", 14, heavy) + 9;
    vline(bx, top - 14.5, top - 26, GOLD, 0.8);
    tracked("PEOPLE SETTLEMENT STATEMENT", bx + 9, top - 23, 6.2, semi, GOLD_LIGHT, 1.1);
    trackedRight(`GENERATED ${generated.toUpperCase()}`, M + TABLE_W, top - 23, 5.6, semi, ON_MID_MUTED, 0.8);
    // Who it is for, the period, the date the figures are read at.
    const leftW = TABLE_W * (portrait ? 0.54 : 0.58);
    tracked("STATEMENT FOR", M, top - 42, 5.8, semi, ON_MID_MUTED, 0.9);
    text(fit(view.personName, bold, 20, leftW), M, top - 61, sizeToFit(view.personName, 20, bold, leftW, 11), bold, WHITE);
    let fx = M;
    for (const [label, value] of [
      ["PERIOD", view.cycleLabel],
      ["AMOUNTS AS OF", view.asOf],
    ] as const) {
      if (fx > M + leftW - 60) break;
      tracked(label, fx, top - 75, 5.6, semi, ON_MID_MUTED, 0.8);
      const lx = fx + trackedWidth(label, 5.6, semi, 0.8) + 6;
      const v = fit(value, medium, 7.8, M + leftW - lx);
      text(v, lx, top - 75, 7.8, medium, ON_MID);
      fx = lx + width(v, 7.8, medium) + 18;
    }
    const leftEnd = Math.max(fx - 18, M + Math.min(leftW, width(view.personName, 20, bold)));
    // The answer.
    const R = M + TABLE_W;
    const rightW = TABLE_W - leftW - 16;
    const amountSize = sizeToFit(view.amount, portrait ? 24 : 27, amountBold, rightW, 12);
    const headline = fit(settled ? "Nothing left to settle" : view.headline, medium, 7.8, rightW);
    const answerW = Math.max(width(view.amount, amountSize, amountBold), width(headline, 7.8, medium));
    trackedRight(view.current.label.toUpperCase(), R, top - 40, 6.2, semi, GOLD_LIGHT, 1);
    textRight(view.amount, R, top - 62, amountSize, amountBold, settled ? SETTLED_ON_MID : WHITE);
    textRight(headline, R, top - 75, 7.8, medium, ON_MID);
    // Ripples spreading from the answer, kept to the open ground between the two blocks so no text is crossed.
    const gapL = leftEnd + 24;
    const gapR = R - answerW - 22;
    if (gapR - gapL > 40) ornament(gapR + 26, bottom + HERO_H * 0.42, { x: gapL, y: bottom + 2, w: gapR - gapL, h: HERO_H - 2 }, [36, 58, 80, 102, 124, 146, 168]);
    box(0, bottom, PAGE_W, 1.6, GOLD);
    y = bottom - 12;
  };

  // ---------------- Reconciliation card: the sum that produces the balance ----------------
  const drawSummary = () => {
    const cells = statementSummaryCells(view);
    const recon = cells.filter((c) => !c.current && !c.advance);
    const primary = { ...cells.find((c) => c.current)!, note: `As of ${view.asOf}` };
    const advance = cells.find((c) => c.advance) ?? null;
    type Cell = (typeof cells)[number];
    /** One figure: label, value, note — the result larger, on a navy tint. `withOp` draws its operator on the boundary. */
    const cell = (c: Cell, x: number, w: number, top: number, h: number, withOp: boolean, corners: Corners = "none") => {
      if (c.current) {
        roundBox(x, top - h, w, h, RADIUS, NAVY_TINT, undefined, 0, corners);
        const c2 = typeof corners === "object" ? corners : null;
        const inset = (on: boolean | undefined) => (on ? RADIUS : 0);
        box(x, top - h + inset(c2?.bl), 2.6, h - inset(c2?.bl) - inset(c2?.tl), NAVY);
      } else if (c.advance) roundBox(x, top - h, w, h, RADIUS, ADVANCE_TINT, undefined, 0, corners);
      else if (x > M + 1) vline(x, top - 10, top - h + 10, RULE, 0.6);
      const ix = x + (portrait ? 12 : 15);
      const iw = x + w - ix - (portrait ? 5 : 8);
      const valueY = c.current ? top - 31 : top - 29.5;
      tracked(fit(c.label.toUpperCase(), semi, T.label, iw - 10), ix, top - 13.5, T.label, semi, c.current ? NAVY : c.advance ? ADVANCE : MUTED);
      const zero = c.value === ZERO;
      if (c.current) {
        text(c.value, ix, valueY, sizeToFit(c.value, 15, amountBold, iw, 9), amountBold, settled ? PAID_TEXT : NAVY);
        text(fit(c.note, regular, T.caption, iw), ix, top - 41.5, T.caption, regular, BODY);
      } else {
        text(c.value, ix, valueY, sizeToFit(c.value, 11.5, amountBold, iw, 6.5), zero ? amountRegular : amountBold, c.advance ? ADVANCE : zero ? FAINT : INK);
        if (c.note) text(fit(c.note, regular, T.caption, iw), ix, top - 40.5, T.caption, regular, MUTED);
      }
      if (withOp && c.op && x > M + 1) operator(c.op, x, valueY + 3.2);
    };
    const top = y;
    const H = 48;
    {
      // One row read left to right as a sum, ending in the balance; an advance is held apart after it. (The header
      // band already states the answer large, so the card stays one line in portrait too.)
      const PRIMARY_W = portrait ? 122 : 196;
      const ADVANCE_W = portrait ? 104 : 150;
      const reconW = (TABLE_W - PRIMARY_W - (advance ? ADVANCE_W : 0)) / Math.max(1, recon.length);
      roundBox(M, top - H, TABLE_W, H, RADIUS, WHITE, undefined, 0);
      recon.forEach((c, i) => cell(c, M + i * reconW, reconW, top, H, true));
      const px = M + recon.length * reconW;
      cell(primary, px, PRIMARY_W, top, H, false, advance ? "none" : { tl: false, tr: true, br: true, bl: false });
      if (advance) cell(advance, px + PRIMARY_W, ADVANCE_W, top, H, false, "right");
      if (primary.op) operator(primary.op, px, top - 31 + 3.2);
      roundBox(M, top - H, TABLE_W, H, RADIUS, undefined, RULE_STRONG, 0.7);
      y = top - H;
    }
    // Settlement progress: how much of the total due is already cleared, as one bar with its words.
    const p = view.settleProgress;
    if (p) {
      const by = y - 12.5;
      tracked("SETTLEMENT", M + 1, by, T.label, semi, MUTED);
      const bx = M + 1 + trackedWidth("SETTLEMENT", T.label) + 10;
      const labelW = width(p.label, T.meta + 0.3, medium);
      const bw = Math.max(60, TABLE_W * 0.42 - (bx - M));
      roundBox(bx, by - 0.8, bw, 5, 2.5, HEAD, undefined, 0);
      if (p.ratio > 0) roundBox(bx, by - 0.8, Math.max(5, bw * p.ratio), 5, 2.5, p.ratio >= 1 ? PAID_TEXT : NAVY);
      text(p.label, bx + bw + 10, by, T.meta + 0.3, medium, p.ratio >= 1 ? PAID_TEXT : BODY);
      if (view.cashNote) {
        const room = M + TABLE_W - (bx + bw + 10 + labelW + 20);
        if (room > 80) textRight(fit(view.cashNote, regular, T.meta, room), M + TABLE_W, by, T.meta, regular, MUTED);
        else {
          textRight(fit(view.cashNote, regular, T.meta, TABLE_W), M + TABLE_W, by - 11, T.meta, regular, MUTED);
          y -= 11;
        }
      }
      y -= 17;
    } else if (view.cashNote) {
      textRight(fit(view.cashNote, regular, T.meta, TABLE_W), M + TABLE_W, y - 11, T.meta, regular, MUTED);
      y -= 12;
    }
  };

  /** A section's title: a short champagne marker, the title, a quiet caption. */
  const sectionTitle = (title: string, caption: string) => {
    box(M, y - 11.5, 2.4, 11, GOLD);
    text(title, M + 8, y - 9.5, 11.5, bold, INK);
    text(caption, M + 8 + width(title, 11.5, bold) + 10, y - 9.5, T.meta, regular, MUTED);
    y -= 15;
  };

  // ---------------- Continued band + column header (repeated on every page) ----------------
  /** Pages after the first: a slim midnight band with enough context that a printed page stands on its own. */
  const drawContinued = () => {
    const bottom = PAGE_H - CONT_H;
    box(0, bottom, PAGE_W, CONT_H, MIDNIGHT);
    box(0, bottom, PAGE_W, 1.2, GOLD);
    const base = bottom + 11;
    text("FlowFi", M, base, 10.5, heavy, WHITE);
    const lead = M + width("FlowFi", 10.5, heavy) + 8;
    vline(lead, base - 1.5, base + 8, GOLD, 0.7);
    const amountW = width(view.current.value, 9, amountBold);
    const labelW = trackedWidth(view.current.label.toUpperCase(), 5.8, semi, 0.9);
    const contW = width("continued", T.caption, regular);
    text(
      fit(`People Settlement Statement  ·  ${view.personName}  ·  ${view.cycleLabel}`, medium, 7.4, M + TABLE_W - amountW - labelW - contW - 40 - (lead + 8)),
      lead + 8,
      base + 0.5,
      7.4,
      medium,
      ON_MID,
    );
    textRight(view.current.value, M + TABLE_W, base, 9, amountBold, settled ? SETTLED_ON_MID : WHITE);
    trackedRight(view.current.label.toUpperCase(), M + TABLE_W - amountW - 7, base + 0.8, 5.8, semi, GOLD_LIGHT, 0.9);
    textRight("continued", M + TABLE_W - amountW - labelW - 20, base + 0.5, T.caption, regular, ON_MID_MUTED);
    y = bottom - 14;
  };
  const drawTableHeader = () => {
    openPanel();
    panelHeader(HEADER_H);
    COLUMNS.forEach((c, i) => {
      // The Amount column names whose share it is when that holds for every row ("SHAMBU'S SHARE").
      // A long label ("SHAMBU'S SHARE" in a narrow portrait column) tightens and steps down before it is ever cut.
      const raw = (i === 4 ? view.amountHeader : c.label).toUpperCase();
      const room = COL_W[i] - 2 * PAD;
      const track = trackedWidth(raw, T.label) <= room ? TRACK : 0.2;
      const size = sizeToFit(raw, T.label, semi, room - track * raw.length, 4.8);
      const label = fit(raw, semi, size, room - track * raw.length);
      if (c.align === "right") trackedRight(label, colRight(i), y - 11.5, size, semi, BODY, track);
      else tracked(label, colX(i) + PAD, y - 11.5, size, semi, BODY, track);
    });
    y -= HEADER_H;
  };

  type PanelKind = "table" | "payments" | null;
  let panelKind: PanelKind = null;
  let redrawPanelHeader: () => void = () => {};
  const newPage = () => {
    closePanel();
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H;
    drawContinued();
    if (panelKind) redrawPanelHeader();
  };
  /** A unit (a transaction with its shares, a heading with what follows it) is never split across pages. */
  const ensure = (h: number) => {
    if (y - h < CONTENT_BOTTOM) newPage();
  };

  // ---------------- Shares (part of a split row) ----------------
  // A genuine split (2+ people) lists every stored allocation under its row as a quiet pill — "Name ₹amount" —
  // the recipient's pill solid midnight, so their share is found at a glance. A pill never breaks; a name too long
  // for a whole line is shortened.
  const STRIP_X = colX(2) + PAD;
  const STRIP_LABEL = "SHARES";
  const STRIP_FLOW_X = STRIP_X + trackedWidth(STRIP_LABEL, T.label - 0.3, semi) + 9;
  const STRIP_RIGHT = M + TABLE_W - PAD;
  const PILL_PAD = 5.5;
  const PILL_GAP = 4;
  const PILL_H = 12;
  type Pill = { x: number; w: number; name: string; amount: string | null; focus: boolean; zero: boolean };
  const layoutShares = (a: SplitAllocation): Pill[][] => {
    const maxW = STRIP_RIGHT - STRIP_FLOW_X;
    const lines: Pill[][] = [[]];
    let x = 0;
    const add = (name: string, amount: string | null, focus: boolean, zero: boolean) => {
      const nameFont = focus ? semi : regular;
      const amountW = amount ? width(amount, SHARE_SIZE, amountBold) + 4 : 0;
      const shown = fit(name, nameFont, SHARE_SIZE, maxW - 2 * PILL_PAD - amountW);
      const w = 2 * PILL_PAD + width(shown, SHARE_SIZE, nameFont) + amountW;
      if (x > 0 && x + w > maxW) {
        lines.push([]);
        x = 0;
      }
      lines[lines.length - 1].push({ x, w, name: shown, amount, focus, zero });
      x += w + PILL_GAP;
    };
    for (const p of a.participants) add(p.label, money(p.amount), p.isFocus, p.amount === 0);
    if (!a.reconciles) add(`Allocated ${money(a.allocated)} of ${money(a.original)}`, null, false, true);
    return lines;
  };
  const sharesH = (lines: Pill[][]) => lines.length * SHARE_LH + SHARE_PAD;
  const drawShares = (lines: Pill[][], top: number) => {
    tracked(STRIP_LABEL, STRIP_X, top - PILL_H + 3.6, T.label - 0.3, semi, SPLIT);
    lines.forEach((line, li) => {
      const pillTop = top - li * SHARE_LH;
      const base = pillTop - PILL_H + 3.6;
      for (const p of line) {
        const x = STRIP_FLOW_X + p.x;
        roundBox(x, pillTop - PILL_H, p.w, PILL_H, PILL_H / 2, p.focus ? NAVY : SURFACE, p.focus ? undefined : RULE, 0.5);
        const nameFont = p.focus ? semi : regular;
        text(p.name, x + PILL_PAD, base, SHARE_SIZE, nameFont, p.focus ? WHITE : p.zero ? MUTED : BODY);
        if (p.amount) textRight(p.amount, x + p.w - PILL_PAD, base, SHARE_SIZE, amountBold, p.focus ? WHITE : p.zero ? FAINT : INK);
      }
    });
  };
  /**
   * A date as a tile: the day large, the month small and tracked beneath ("25" / "JUL"), with the year only when
   * it isn't the statement period's. Anything that isn't a date ("Date not known") is drawn as quiet text.
   */
  const dateTile = (label: string, x: number, line1: number) => {
    const m = label.match(/^(\d{1,2}) ([A-Za-z]{3})(?: (\d{4}))?$/);
    if (!m) {
      const lines = capLines(wrapWords(label, COL_W[1] - 2 * PAD, regular, T.caption), 2, regular, T.caption, COL_W[1] - 2 * PAD);
      lines.forEach((l, i) => text(l, x, line1 - i * NOTE_LH, T.caption, regular, MUTED));
      return;
    }
    const year = m[3] && !view.cycleLabel.endsWith(m[3]) ? m[3] : null;
    text(m[1], x, line1 - 1, 12.5, semi, INK);
    tracked(year ? `${m[2].toUpperCase()} ${year}` : m[2].toUpperCase(), x + 0.4, line1 - 10.5, 5.6, semi, MUTED, 0.8);
  };

  // ---------------- Rows ----------------
  // Each transaction is one unit: the title (medium — the figures carry the weight), a quiet meta line (type · what
  // it means), then the money in fixed columns: Original only when it differs from the Amount, the Amount
  // (captioned with whose share it is only beside an Original), Paid, Remaining, and the status chip.
  const layoutRow = (row: StatementViewRow) => {
    const a = row.allocation ?? null;
    const shares = a && a.participants.length >= 2 ? layoutShares(a) : null;
    // The narrower portrait description column wraps more, so it keeps one more line before shortening.
    const titleLines = capLines(wrapWords(row.title, DESC_W, medium, T.title), portrait ? 4 : 3, medium, T.title, DESC_W);
    // A legacy split (no participant list) or a single-carrier allocation that doesn't add up says so here.
    const mismatch = a && !shares && !a.reconciles && a.participants.length > 0 ? `Allocated ${money(a.allocated)} of ${money(a.original)}` : "";
    // The cycle a brought-forward row came from is its group heading, so the meta line never repeats it.
    const metaLines = capLines(wrapWords(row.metaLine, DESC_W, regular, T.meta), 3, regular, T.meta, DESC_W);
    const descBottom = LINE1 + (titleLines.length - 1) * TITLE_LH + metaLines.length * META_LH + (mismatch ? NOTE_LH : 0) + 9;
    const noteLines = row.statusNote ? capLines(wrapWords(row.statusNote, STATUS_W, regular, T.caption), 2, regular, T.caption, STATUS_W) : [];
    // Under the chip: how long the item has been open, then any note. A caption needs less room below than the chip.
    const statusLines = noteLines.length + (row.age ? 1 : 0);
    const statusBottom = LINE1 + 4 + statusLines * NOTE_LH + (statusLines ? 5 : 9);
    const amountBottom = LINE1 + (row.purchase || row.shareLabel ? 9 : 0) + 9;
    const mainH = Math.max(descBottom, statusBottom, amountBottom, 32);
    // The pills tuck up under the description, so a split reads as one block with its shares.
    const h = mainH + (shares ? sharesH(shares) - SHARE_TUCK : 0);
    return { shares, titleLines, metaLines, mismatch, noteLines, mainH, h };
  };
  const drawRow = (row: StatementViewRow, tail = 0) => {
    const l = layoutRow(row);
    ensure(l.h + tail);
    const top = y;
    const line1 = top - LINE1;
    const line2 = line1 - 9;
    // The Remaining column's faint band runs the whole item, so the eye runs straight down what is left.
    box(colX(6), top - l.h, COL_W[6], l.h - TOP_GAP, REMAIN_TINT);
    // # and the date tile.
    textRight(row.no, colRight(0) - 1, line1, T.meta - 0.4, regular, FAINT);
    dateTile(row.date, colX(1) + PAD, line1);
    // Description: title, then the meta line.
    const dx = colX(2) + PAD;
    l.titleLines.forEach((t, ti) => text(t, dx, line1 - ti * TITLE_LH, T.title, medium, INK));
    let ly = line1 - (l.titleLines.length - 1) * TITLE_LH - 1;
    for (const m of l.metaLines) {
      ly -= META_LH;
      text(m, dx, ly, T.meta, regular, MUTED);
    }
    if (l.mismatch) text(l.mismatch, dx, ly - NOTE_LH, T.caption, regular, MUTED);
    // Original (split only) → Amount → Paid → Remaining.
    const maxW = (i: number) => COL_W[i] - 2 * PAD;
    if (row.purchase) {
      amountRight(row.purchase, colRight(3), line1, T.money - 0.2, regular, MUTED, maxW(3));
      if (row.purchaseNote) textRight(fit(row.purchaseNote, regular, T.caption, maxW(3)), colRight(3), line2, T.caption, regular, FAINT);
    }
    if (row.original) {
      amountRight(row.original, colRight(4), line1, T.money + 0.4, bold, INK, maxW(4));
      if (row.shareLabel) textRight(fit(row.shareLabel, regular, T.caption, maxW(4)), colRight(4), line2, T.caption, regular, MUTED);
    } else textRight("—", colRight(4), line1, T.money, regular, FAINT);
    // Nothing paid yet reads as a quiet dash, so a column of ₹0 doesn't compete with what's left to pay.
    if (row.paid && row.paid !== ZERO) amountRight(row.paid, colRight(5), line1, T.money, regular, PAID_TEXT, maxW(5));
    else textRight("—", colRight(5), line1, T.money, regular, FAINT);
    if (row.remaining) {
      const zero = row.remaining === ZERO;
      const tone = zero ? FAINT : row.chip === "overdue" ? OVERDUE_TEXT : INK;
      amountRight(row.remaining, colRight(6), line1, T.money + 0.6, zero ? regular : bold, tone, maxW(6));
    } else textRight("—", colRight(6), line1, T.money, regular, FAINT);
    // A partly paid row shows how far it is paid down: a thin bar under its Remaining amount.
    if (row.progress != null) {
      const bw = COL_W[6] - 2 * PAD - 6;
      const bx = colRight(6) - bw;
      roundBox(bx, line1 - 9.5, bw, 3, 1.5, HEAD);
      roundBox(bx, line1 - 9.5, Math.max(3, bw * row.progress), 3, 1.5, CHIP.partial.edge);
    }
    // Status chip + a note only when it says something new.
    chip(row.status, colX(7) + PAD, line1, row.chip);
    let sy = line1 - 11.5;
    if (row.age) {
      // How long it has been open: a dot and the words, deepening from grey to amber to red as it ages.
      const tone = row.age.tone === "old" ? OVERDUE_TEXT : row.age.tone === "aging" ? CHIP.due.text : MUTED;
      page.drawCircle({ x: colX(7) + PAD + 2.2, y: sy + 2.1, size: 1.5, color: row.age.tone === "fresh" ? FAINT : tone });
      text(fit(row.age.label, medium, T.caption, STATUS_W - 7), colX(7) + PAD + 7, sy, T.caption, row.age.tone === "fresh" ? regular : medium, tone);
      sy -= NOTE_LH;
    }
    l.noteLines.forEach((s, si) => text(s, colX(7) + PAD, sy - si * NOTE_LH, T.caption, regular, MUTED));
    if (l.shares) drawShares(l.shares, top - l.mainH + SHARE_TUCK);
    y = top - l.h;
    hline(M, M + TABLE_W, y, RULE, LINE_W);
  };

  // ---------------- Section rows (inside the table panel, each kept with what follows it) ----------------
  const { previous, showPrevious, groupOf } = statementSections(view);
  /**
   * The carry-forward band: the previous balance stated once, beside its label — never in the Remaining column,
   * which holds only what each item still has open, so that column adds up (see the subtotals).
   */
  const carryRow = (next: number) => {
    ensure(CARRY_H + next);
    box(M + 0.35, y - CARRY_H, TABLE_W - 0.7, CARRY_H - TOP_GAP, SURFACE);
    box(M + 0.35, y - CARRY_H, 2.4, CARRY_H - TOP_GAP, GOLD);
    const label = STATEMENT_COPY.carried.label.toUpperCase();
    tracked(label, colX(2) + PAD, y - 11.5, T.label + 0.3, semi, CHIP.carried.text);
    if (previous) text(previous.value, colX(2) + PAD + trackedWidth(label, T.label + 0.3) + 9, y - 12, T.money + 0.8, amountBold, INK);
    const note = [view.previousNote, previous?.side].filter(Boolean).join("  ·  ");
    text(fit(note, regular, T.meta, colX(6) - colX(2) - 2 * PAD), colX(2) + PAD, y - 21, T.meta, regular, MUTED);
    chip("Brought forward", colX(7) + PAD, y - 11.5, "carried");
    y -= CARRY_H;
    hline(M, M + TABLE_W, y, RULE, LINE_W);
  };
  /**
   * A sum line under a section: its label right-aligned against the Remaining column, the figure in it under a
   * short rule — the way a paper statement totals a column. `strong` is the closing line (the balance due): a
   * midnight bar that closes the panel, mirroring the header band.
   */
  const SUB_H = 19;
  const TOTAL_ROW_H = 26;
  const sumRow = (label: string, value: string, opts: { op?: "+" | "−" | "=" | null; strong?: boolean; tail?: number } = {}) => {
    const strong = opts.strong === true;
    const h = strong ? TOTAL_ROW_H : SUB_H;
    ensure(h + (opts.tail ?? 0));
    if (strong) roundBox(M + 0.35, y - h + 0.35, TABLE_W - 0.7, h - 0.35 - TOP_GAP, RADIUS - 0.4, MIDNIGHT, undefined, 0, "bottom");
    else box(M + 0.35, y - h, TABLE_W - 0.7, h - TOP_GAP, SURFACE);
    const base = y - (strong ? 16.5 : 12.5);
    hline(colX(6) + PAD + 4, colRight(6), y - (strong ? 5 : 3), strong ? GOLD : RULE_STRONG, strong ? 0.8 : 0.6);
    if (strong) trackedRight(label.toUpperCase(), colX(6) - PAD - 6, base + 0.5, T.label + 1, semi, GOLD_LIGHT, 1);
    else textRight(label, colX(6) - PAD - 6, base, T.meta + 0.3, semi, BODY);
    if (opts.op) operator(opts.op, colX(6) + PAD - 1, base + 3, strong);
    amountRight(value, colRight(6), base, strong ? T.money + 2.6 : T.money + 0.5, bold, strong ? (settled ? SETTLED_ON_MID : WHITE) : INK, COL_W[6] - 2 * PAD - 12);
    y -= h;
    if (!strong) hline(M, M + TABLE_W, y, RULE, LINE_W);
  };
  /** THIS CYCLE: a navy-tinted divider row (label + the cycle) — and, when nothing is new, the notice itself. */
  const cycleBand = (note: string, next: number) => {
    ensure(SECTION_H + next);
    box(M + 0.35, y - SECTION_H, TABLE_W - 0.7, SECTION_H - TOP_GAP, NAVY_TINT);
    box(M + 0.35, y - SECTION_H, 2.4, SECTION_H - TOP_GAP, NAVY);
    const l = STATEMENT_COPY.current.toUpperCase();
    tracked(l, colX(2) + PAD, y - 12, T.label + 0.5, semi, NAVY);
    const lw = trackedWidth(l, T.label + 0.5);
    text(fit(note, regular, T.meta, TABLE_W - lw - 120), colX(2) + PAD + lw + 10, y - 12, T.meta, regular, BODY);
    y -= SECTION_H;
    hline(M, M + TABLE_W, y, NAVY_RULE, LINE_W);
  };
  /** Group heading (a brought-forward cycle, or a month): a tracked label after a champagne dot, and its item count. */
  const monthHeading = (month: string, next: number, items: number) => {
    ensure(MONTH_H + next);
    box(M + 0.35, y - MONTH_H, TABLE_W - 0.7, MONTH_H - TOP_GAP, SURFACE);
    page.drawCircle({ x: colX(1) + PAD + 1.6, y: y - 8.6, size: 1.6, color: GOLD });
    const label = month.toUpperCase();
    tracked(label, colX(1) + PAD + 7, y - 10.8, T.label + 0.2, semi, NAVY);
    text(`${items} ${items === 1 ? "item" : "items"}`, colX(1) + PAD + 7 + trackedWidth(label, T.label + 0.2) + 8, y - 10.8, T.caption, regular, MUTED);
    y -= MONTH_H;
    hline(M, M + TABLE_W, y, RULE, LINE_W);
  };
  const allRows = [...view.carried, ...view.rows];
  /** `tail` reserves room after the list's last row (the ending balance), so the conclusion never stands alone. */
  const drawRows = (rows: StatementViewRow[], tail = 0) => {
    let group: string | null = null;
    rows.forEach((r, i) => {
      const last = i === rows.length - 1 ? tail : 0;
      const g = groupOf(r);
      if (g && g !== group) monthHeading(g, layoutRow(r).h + last, rows.filter((x) => groupOf(x) === g).length);
      group = g;
      drawRow(r, last);
    });
  };
  const firstUnit = (rows: StatementViewRow[], tail = 0) => (rows.length === 0 ? tail : (groupOf(rows[0]) ? MONTH_H : 0) + layoutRow(rows[0]).h + (rows.length === 1 ? tail : 0));

  // ---------------- Payment history (grouped by real payment) ----------------
  const P_DATE = M + PAD + 2;
  const P_LABEL = colX(2) + PAD;
  const P_APPLIED = colX(3) + PAD;
  const P_APPLIED_RIGHT = colRight(6);
  const P_AMOUNT_RIGHT = M + TABLE_W - PAD - 4;
  /** The payment's text starts after its direction badge. */
  const BADGE = 19;
  const P_LABEL_W = P_APPLIED - P_LABEL - 2 * PAD - BADGE;
  const P_APPLIED_W = P_APPLIED_RIGHT - P_APPLIED;
  /** Pitch of the allocation lines. */
  const APPLIED_LH = 11.5;
  type Payment = (typeof view.payments)[number];
  const paymentLayout = (p: Payment) => {
    const labelLines = capLines(wrapWords(p.label, P_LABEL_W, medium, T.title), 2, medium, T.title, P_LABEL_W);
    const sub = [p.account, p.note].filter(Boolean).join("  ·  ");
    const singleLines = p.single != null ? capLines(wrapWords(p.single, P_APPLIED_W, regular, T.meta), 2, regular, T.meta, P_APPLIED_W) : [];
    const appliedLines = p.single != null ? singleLines.length : p.applied.length + (p.applied.length > 1 ? 1 : 0) + (p.held ? 1 : 0);
    const h = Math.max(LINE1 + (labelLines.length - 1) * TITLE_LH + (sub ? META_LH : 0) + 2, LINE1 + 10.5, LINE1 + (appliedLines - 1) * APPLIED_LH + (p.applied.length > 1 ? 2.5 : 0)) + 10;
    return { labelLines, sub, singleLines, h };
  };
  /**
   * The payment's direction as a small round badge with an arrow drawn as lines (no glyph, so it survives every
   * face): money in from the person green ↙, money out to them navy ↗, an advance teal.
   */
  const directionBadge = (p: Payment, cx: number, cy: number) => {
    const tone = p.advance ? { fill: ADVANCE_TINT, edge: CHIP.advance.edge, ink: ADVANCE } : p.inbound ? { fill: CHIP.paid.fill, edge: CHIP.paid.edge, ink: PAID_TEXT } : { fill: NAVY_TINT, edge: NAVY_RULE, ink: NAVY };
    page.drawCircle({ x: cx, y: cy, size: 6.8, color: tone.fill, borderColor: tone.edge, borderWidth: 0.5 });
    const s = 2.6;
    const dir = p.inbound ? -1 : 1;
    const tip = { x: cx + dir * s, y: cy + dir * s };
    const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => page.drawLine({ start: a, end: b, thickness: 0.9, color: tone.ink, lineCap: 1 });
    seg({ x: cx - dir * s, y: cy - dir * s }, tip);
    seg(tip, { x: tip.x - dir * 3, y: tip.y });
    seg(tip, { x: tip.x, y: tip.y - dir * 3 });
  };
  /** One allocation: the item's # in a small badge (as in the table), its title, then its date and what it left. */
  const appliedLine = (a: Payment["applied"][number], yy: number) => {
    let x = P_APPLIED;
    if (a.ref) {
      const bw = Math.max(15, width(a.ref, 6, semi) + 7);
      roundBox(x, yy - 2.7, bw, 9.6, 2.6, SURFACE, RULE, 0.5);
      text(a.ref, x + (bw - width(a.ref, 6, semi)) / 2, yy - 0.2, 6, semi, MUTED);
      x += bw + 6;
    }
    const tail = [a.date, a.note].filter(Boolean).join("  ·  ");
    const tailW = tail ? width(tail, T.caption) + 8 : 0;
    const label = fit(a.label, regular, T.meta, Math.max(40, P_APPLIED_RIGHT - 64 - x - tailW));
    text(label, x, yy, T.meta, regular, BODY);
    if (tail) {
      const tx = x + width(label, T.meta) + 6;
      if (a.date) text(a.date, tx, yy, T.caption, regular, MUTED);
      if (a.note) text(`${a.date ? "  ·  " : ""}${a.note}`, tx + (a.date ? width(a.date, T.caption) : 0), yy, T.caption, a.note === "cleared" ? medium : regular, a.note === "cleared" ? PAID_TEXT : MUTED);
    }
    amountRight(a.amount, P_APPLIED_RIGHT, yy, T.meta, regular, INK);
  };
  const paymentHeader = () => {
    openPanel();
    panelHeader(HEADER_H);
    tracked("DATE", P_DATE, y - 11.5, T.label, semi, BODY);
    tracked("PAYMENT", P_LABEL, y - 11.5, T.label, semi, BODY);
    tracked("APPLIED TO", P_APPLIED, y - 11.5, T.label, semi, BODY);
    trackedRight("AMOUNT", P_AMOUNT_RIGHT, y - 11.5, T.label, semi, BODY);
    y -= HEADER_H;
  };
  const totals = [view.totalReceived && { label: `Total paid by ${first}`, value: view.totalReceived }, view.totalPaid && { label: `Total paid by ${view.ownerShort}`, value: view.totalPaid }].filter(Boolean) as {
    label: string;
    value: string;
  }[];
  const TOTAL_H = 19;
  const drawPayment = (p: Payment, tail: number) => {
    const l = paymentLayout(p);
    ensure(l.h + tail);
    const top = y;
    const line1 = top - LINE1;
    dateTile(p.date, P_DATE, line1);
    directionBadge(p, P_LABEL + 6.8, line1 + 2.6);
    l.labelLines.forEach((s, i) => text(s, P_LABEL + BADGE, line1 - i * TITLE_LH, T.title, medium, INK));
    if (l.sub) text(fit(l.sub, regular, T.caption, P_LABEL_W), P_LABEL + BADGE, line1 - (l.labelLines.length - 1) * TITLE_LH - META_LH, T.caption, regular, MUTED);
    amountRight(p.amount, P_AMOUNT_RIGHT, line1, T.money + 1.2, bold, p.inbound ? PAID_TEXT : INK);
    if (p.single != null) {
      l.singleLines.forEach((s, i) => text(s, P_APPLIED, line1 - i * 10, T.meta, regular, BODY));
    } else {
      // Where one payment went: each item it paid (by its # in the table), what was applied, any advance held.
      let ly = line1;
      for (const a of p.applied) {
        appliedLine(a, ly);
        ly -= APPLIED_LH;
      }
      if (p.applied.length > 1) {
        ly -= 2.5;
        hline(P_APPLIED, P_APPLIED_RIGHT, ly + 8.5, RULE_STRONG, 0.5);
        text("Applied to obligations", P_APPLIED, ly, T.meta, semi, INK);
        amountRight(p.appliedTotal ?? "", P_APPLIED_RIGHT, ly, T.meta, bold, INK);
        ly -= APPLIED_LH;
      }
      if (p.held) {
        text("Held as advance", P_APPLIED, ly, T.meta, semi, ADVANCE);
        amountRight(p.held, P_APPLIED_RIGHT, ly, T.meta, bold, ADVANCE);
      }
    }
    y = top - l.h;
    hline(M, M + TABLE_W, y, RULE, LINE_W);
  };

  // ---------------- Ending balance ----------------
  // The statement's conclusion, restating the answer in full on a midnight panel that mirrors the header. Its room
  // is reserved with the last unit above it (see `tail`), so it never lands alone on a page.
  const drawEnding = () => {
    ensure(END_GAP + END_H);
    y -= END_GAP;
    const top = y;
    roundBox(M, top - END_H, TABLE_W, END_H, RADIUS, MIDNIGHT);
    box(M + RADIUS, top - END_H, TABLE_W - 2 * RADIUS, 1.4, GOLD);
    const endLine = settled ? "Settled — nothing left to settle" : view.headline;
    const dueLabel = settled ? "NOTHING DUE" : "AMOUNT DUE";
    const amountSize = sizeToFit(view.amount, 20, amountBold, 260, 11);
    const amountW = width(view.amount, amountSize, amountBold);
    tracked("ENDING BALANCE", M + 18, top - 14, T.label + 0.4, semi, GOLD_LIGHT, 1);
    text(fit(endLine, bold, 12.5, TABLE_W - amountW - 90), M + 18, top - 30, 12.5, bold, WHITE);
    trackedRight(dueLabel, M + TABLE_W - 18, top - 14, T.label + 0.4, semi, GOLD_LIGHT, 1);
    textRight(view.amount, M + TABLE_W - 18, top - 32, amountSize, amountBold, settled ? SETTLED_ON_MID : WHITE);
    y = top - END_H;
    // The fine print, when there is room for it: what the statement covers, and whom to ask.
    const fine = `Covers every item open at the start of this period or added during it, with each split share exactly as recorded. All amounts in Indian Rupees (INR). Questions about an item? Contact ${view.ownerName}.`;
    const lines = capLines(wrapWords(fine, TABLE_W, regular, T.caption), 2, regular, T.caption, TABLE_W);
    if (y - 8 - lines.length * NOTE_LH >= CONTENT_BOTTOM) {
      lines.forEach((ln, i) => text(ln, M, y - 12 - i * NOTE_LH, T.caption, regular, MUTED));
      y -= 8 + lines.length * NOTE_LH;
    }
  };
  const ENDING = END_GAP + END_H;

  // ---------------- Compose ----------------
  drawHero();
  drawSummary();
  y -= 10;
  const count = allRows.length;
  const sums = view.totals;
  sectionTitle("Transactions", `${count} ${count === 1 ? "item" : "items"}${count > 0 ? `  ·  ${view.openCount === 0 ? "all paid" : `${view.openCount} still open`}` : ""}`);
  const hasPayments = view.payments.length > 0;
  // The table's last unit carries the ending balance with it when no payment history follows.
  const tableTail = hasPayments ? 0 : ENDING;
  const closingH = sums ? (sums.current ? SUB_H : 0) + (sums.other ? SUB_H : 0) + TOTAL_ROW_H : 0;
  ensure(HEADER_H + firstUnit(showPrevious ? view.carried : view.rows, tableTail) + (showPrevious ? CARRY_H : 0));
  panelKind = "table";
  redrawPanelHeader = drawTableHeader;
  drawTableHeader();
  const n = view.rows.length;
  const emptyNote = `${view.cycleLabel}  ·  ${STATEMENT_COPY.empty}`;
  const bandNote = n ? `${view.cycleLabel}  ·  ${n} new ${n === 1 ? "item" : "items"}` : emptyNote;
  if (showPrevious) {
    carryRow(firstUnit(view.carried, view.rows.length ? 0 : tableTail));
    // With nothing new, the last brought-forward row keeps the closing lines (and the ending) with it — the
    // conclusion never stands alone on a page.
    drawRows(view.carried, (sums?.carried ? SUB_H : 0) + (view.rows.length ? 0 : SECTION_H + closingH + tableTail));
    if (sums?.carried) sumRow("Still open from earlier cycles", sums.carried, { tail: view.rows.length ? 0 : SECTION_H + closingH + tableTail });
    cycleBand(bandNote, firstUnit(view.rows, closingH + tableTail) || closingH + tableTail);
  } else if (view.rows.length === 0) cycleBand(emptyNote, closingH + tableTail);
  if (view.rows.length > 0) drawRows(view.rows, closingH + tableTail);
  if (sums) {
    if (sums.current) sumRow("Still open from this cycle", sums.current, { op: sums.carried ? "+" : null, tail: TOTAL_ROW_H + tableTail });
    if (sums.other) sumRow(sums.other.label, sums.other.value, { op: sums.other.op, tail: TOTAL_ROW_H + tableTail });
    sumRow(sums.total.label, sums.total.value, { op: sums.carried || sums.current || sums.other ? "=" : null, strong: true, tail: tableTail });
  }
  closePanel();
  panelKind = null;

  if (hasPayments) {
    const totalsH = totals.length * TOTAL_H;
    const lastTail = totalsH + ENDING;
    const heading = 20;
    // The heading never sits alone at a page foot: it moves with the first payment.
    ensure(14 + heading + HEADER_H + paymentLayout(view.payments[0]).h + (view.payments.length === 1 ? lastTail : 0));
    y -= 14;
    sectionTitle("Payment history", "Payments this cycle and the items (#) each one paid");
    panelKind = "payments";
    redrawPanelHeader = paymentHeader;
    paymentHeader();
    view.payments.forEach((p, i) => drawPayment(p, i === view.payments.length - 1 ? lastTail : 0));
    totals.forEach((t, i) => {
      ensure(TOTAL_H);
      const last = i === totals.length - 1;
      if (last) roundBox(M + 0.35, y - TOTAL_H + 0.35, TABLE_W - 0.7, TOTAL_H - 0.35 - TOP_GAP, RADIUS - 0.4, SURFACE, undefined, 0, "bottom");
      else box(M + 0.35, y - TOTAL_H, TABLE_W - 0.7, TOTAL_H - TOP_GAP, SURFACE);
      textRight(t.label, P_APPLIED_RIGHT, y - 12.5, T.meta + 0.4, semi, INK);
      amountRight(t.value, P_AMOUNT_RIGHT, y - 12.5, T.money + 0.5, bold, INK);
      y -= TOTAL_H;
    });
    closePanel();
    panelKind = null;
  }
  drawEnding();

  // ---------------- Footer ----------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    hline(M, M + TABLE_W, FOOTER_RULE_Y, RULE, 0.5);
    const size = 6.6;
    const pageLabel = `Page ${i + 1} of ${pages.length}`;
    textRight(pageLabel, M + TABLE_W, 15, size, semi, BODY);
    const pageW = width(pageLabel, size, semi);
    const prepared = fit(`Prepared by ${view.ownerName}  ·  `, regular, size, 220);
    textRight(prepared, M + TABLE_W - pageW, 15, size, regular, MUTED);
    text("FlowFi", M, 15, size, bold, NAVY);
    const brandW = width("FlowFi", size, bold);
    const left = fit(`  ·  Statement for ${view.personName}  ·  ${view.cycleLabel}`, regular, size, TABLE_W - width(prepared, size) - pageW - brandW - 16);
    text(left, M + brandW, 15, size, regular, MUTED);
  });
  // Open on page 1 scaled to the page width, the window fitted to the page — a viewer setting (honoured by
  // Acrobat and most desktop readers; browsers and phone viewers may ignore it). No script is embedded.
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj([pages[0].ref, PDFName.of("FitH"), PDFNull]));
  doc.catalog.getOrCreateViewerPreferences().setFitWindow(true);
  return doc.save();
}
