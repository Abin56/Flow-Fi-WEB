/**
 * The Monthly Settlement PDF — the short statement a person shares over WhatsApp for ONE cycle. Portrait A4 so a
 * phone shows it full width; midnight / white / champagne like the full statement (same tokens, same fonts), but
 * built for reading in seconds: one strong summary, then only this cycle's items, then the payments.
 *
 * Rendered solely from `monthlySettlementView`; the only numbers computed here are layout coordinates. The full
 * statement (`renderPersonStatementPdf`) is untouched and stays the complete-history document.
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFNull, StandardFonts, setCharacterSpacing, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { monthlySettlementView, type MonthlyItem, type MonthlyPayment } from "@/features/people/lib/monthly-settlement-model";
import { pdfSafe, type StatementAmountFonts, type StatementTextFonts } from "@/features/people/lib/person-statement-pdf";
import type { StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import { hexToUnit, STATEMENT_CHIP, STATEMENT_INK, type StatementChip } from "@/features/people/lib/statement-palette";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";

const hex = (h: string) => rgb(...hexToUnit(h));
const INK = hex(STATEMENT_INK.ink);
const BODY = hex(STATEMENT_INK.body);
const MUTED = hex(STATEMENT_INK.muted);
const FAINT = hex(STATEMENT_INK.faint);
const RULE = hex(STATEMENT_INK.rule);
const RULE_STRONG = hex(STATEMENT_INK.ruleStrong);
const HEAD = hex(STATEMENT_INK.head);
const NAVY = hex(STATEMENT_INK.navy);
const NAVY_TINT = hex(STATEMENT_INK.navyTint);
const MIDNIGHT = hex(STATEMENT_INK.midnight);
const ON_MID = hex(STATEMENT_INK.onMidnight);
const ON_MID_MUTED =hex(STATEMENT_INK.onMidnightMuted);
const GOLD = hex(STATEMENT_INK.gold);
const GOLD_LIGHT = hex(STATEMENT_INK.goldLight);
const WHITE = rgb(1, 1, 1);
const CHIP_TEXT = Object.fromEntries(Object.entries(STATEMENT_CHIP).map(([k, v]) => [k, hex(v.text)])) as Record<StatementChip, RGB>;
const PAID = CHIP_TEXT.paid;

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;
const W = PAGE_W - 2 * M;
const PAD = 7;
/** Date · Description (rest) · Amount · Paid · Remaining · Status */
const FIXED = [46, 0, 72, 64, 72, 90];
const COL_W = FIXED.map((w) => (w === 0 ? W - FIXED.reduce((s, x) => s + x, 0) : w));
const colX = (i: number) => M + COL_W.slice(0, i).reduce((s, w) => s + w, 0);
const colRight = (i: number) => colX(i) + COL_W[i] - PAD;
const DESC_W = COL_W[1] - 2 * PAD;
/** Type sizes (pt): nothing under 8 except the tracked small-caps signposts. */
const S = { title: 10, money: 9.6, meta: 8.2, label: 6.8 } as const;
const TRACK = 0.8;
const FOOTER_H = 48;
const BOTTOM = FOOTER_H + 10;
/** Every rupee amount is drawn with paise ("₹4,630" → "₹4,630.00") so figures line up and read consistently. */
const money2 = (s: string) => s.replace(/₹\d[\d,]*(\.\d+)?/g, (m, dec) => (dec ? m : `${m}.00`));
/** Display-only: "S B I" (single capitals spaced apart) reads as "SBI". Stored names are never changed. */
const tidyAccount = (s: string) => s.replace(/\b[A-Z](?: [A-Z]){2,}\b/g, (m) => m.replace(/ /g, ""));
const GENERATED = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export async function renderMonthlySettlementPdf(
  statement: PersonCycleStatement,
  options: StatementViewOptions & { amountFonts?: StatementAmountFonts | null; textFonts?: StatementTextFonts | null } = {},
): Promise<Uint8Array> {
  const v = monthlySettlementView(statement, options);
  const settled = v.direction === "settled";
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${v.personName} - Monthly Settlement - ${v.cycleLabel}`));
  doc.setAuthor(pdfSafe(v.ownerName));
  doc.setProducer("FlowFi");
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const amountCustom = options.amountFonts ?? null;
  const textCustom = options.textFonts ?? null;
  if (amountCustom || textCustom) doc.registerFontkit(fontkit);
  const embed = (bytes: ArrayBuffer | Uint8Array) => doc.embedFont(bytes, { subset: true });
  const regular = textCustom ? await embed(textCustom.regular) : helvetica;
  const medium = textCustom ? await embed(textCustom.medium) : helvetica;
  const semi = textCustom ? await embed(textCustom.semibold) : helveticaBold;
  const bold = textCustom ? await embed(textCustom.bold) : helveticaBold;
  const heavy = textCustom ? await embed(textCustom.extrabold) : helveticaBold;
  const monoRegular = amountCustom ? await embed(amountCustom.regular) : regular;
  const monoBold = amountCustom ? await embed(amountCustom.bold) : bold;
  const textFaces = new Set<PDFFont>([regular, medium, semi, bold, heavy]);
  const unicodeFaces = new Set<PDFFont>([...(textCustom ? [regular, medium, semi, bold, heavy] : []), ...(amountCustom ? [monoRegular, monoBold] : [])]);
  const heavyFace = (f: PDFFont) => f === semi || f === bold || f === heavy || f === monoBold;
  const mono = (f: PDFFont) => (heavyFace(f) ? monoBold : monoRegular);
  const charsets = new Map<PDFFont, Set<number>>();
  const charset = (f: PDFFont) => {
    let s = charsets.get(f);
    if (!s) charsets.set(f, (s = new Set(f.getCharacterSet())));
    return s;
  };
  const encode = (s: string, f: PDFFont) => {
    if (!unicodeFaces.has(f)) return pdfSafe(s);
    const cs = charset(f);
    let out = "";
    for (const ch of s) out += cs.has(ch.codePointAt(0)!) ? ch : [...pdfSafe(ch)].filter((c) => cs.has(c.codePointAt(0)!)).join("");
    return out;
  };
  // Amounts inside a sentence ("₹3,000.00") use the figure face, so ₹ reads the same everywhere.
  const runs = (s: string, f: PDFFont) => {
    return amountCustom && textFaces.has(f) && s.includes("₹")
      ? s.split(/(₹[\d,]+(?:\.\d+)?)/).filter(Boolean).map((p) => ({ s: p, font: p.startsWith("₹") ? mono(f) : f }))
      : [{ s, font: f }];
  };
  const safe = (t: string) => (textCustom ? t : amountCustom ? pdfSafe(t.replace(/₹/g, "¤")).replace(/¤/g, "₹") : pdfSafe(t));
  const width = (s: string, size: number, f: PDFFont = regular) => runs(s, f).reduce((w, r) => w + r.font.widthOfTextAtSize(encode(r.s, r.font), size), 0);
  const fit = (t: string, f: PDFFont, size: number, w: number) => {
    let s = safe(t);
    while (s.length > 1 && width(s, size, f) > w) s = `${s.slice(0, -4)}...`;
    return s;
  };

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H;
  const text = (s: string, x: number, yy: number, size: number, f: PDFFont = regular, color: RGB = INK) => {
    let cx = x;
    for (const r of runs(s, f)) {
      const e = encode(r.s, r.font);
      if (e) page.drawText(e, { x: cx, y: yy, size, font: r.font, color });
      cx += r.font.widthOfTextAtSize(e, size);
    }
  };
  const textRight = (s: string, right: number, yy: number, size: number, f: PDFFont = regular, color: RGB = INK) => text(s, right - width(s, size, f), yy, size, f, color);
  const trackedW = (s: string, size: number, f: PDFFont = semi, tr = TRACK) => width(s, size, f) + tr * Math.max(0, [...s].length - 1);
  const tracked = (s: string, x: number, yy: number, size: number, f: PDFFont = semi, color: RGB = MUTED, tr = TRACK) => {
    page.pushOperators(setCharacterSpacing(tr));
    text(s, x, yy, size, f, color);
    page.pushOperators(setCharacterSpacing(0));
  };
  const trackedRight = (s: string, right: number, yy: number, size: number, f: PDFFont = semi, color: RGB = MUTED, tr = TRACK) =>
    tracked(s, right - trackedW(s, size, f, tr), yy, size, f, color, tr);
  const box = (x: number, yy: number, w: number, h: number, fill: RGB) => page.drawRectangle({ x, y: yy, width: w, height: h, color: fill });
  const hline = (x0: number, x1: number, yy: number, color = RULE, t = 0.5) => page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness: t, color });
  const sizeToFit = (s: string, size: number, f: PDFFont, maxW: number, min = 7) => {
    let sz = size;
    while (sz > min && width(s, sz, f) > maxW) sz -= 0.25;
    return sz;
  };
  const amount = (s: string, right: number, yy: number, size: number, f: PDFFont, color: RGB, maxW: number) =>
    textRight(money2(s), right, yy, sizeToFit(money2(s), size, mono(f), maxW), mono(f), color);
  /** Word wrap that never truncates an amount: "₹ 5,000" stays whole, long words break by characters. */
  const wrap = (label: string, w: number, f: PDFFont, size: number): string[] => {
    const lines: string[] = [];
    let cur = "";
    for (const word of safe(label.replace(/\s+/g, " ")).split(" ").filter(Boolean)) {
      let piece = word;
      while (width(piece, size, f) > w) {
        let n = piece.length - 1;
        while (n > 1 && width(piece.slice(0, n), size, f) > w) n -= 1;
        if (cur) {
          lines.push(cur);
          cur = "";
        }
        lines.push(piece.slice(0, n));
        piece = piece.slice(n);
      }
      const next = cur ? `${cur} ${piece}` : piece;
      if (width(next, size, f) <= w) cur = next;
      else {
        lines.push(cur);
        cur = piece;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  const cap = (lines: string[], max: number, f: PDFFont, size: number, w: number) => (lines.length <= max ? lines : [...lines.slice(0, max - 1), fit(lines.slice(max - 1).join(" "), f, size, w)]);

  // ---- Header ----
  const HERO_H = 68;
  const drawHero = () => {
    const top = PAGE_H;
    box(0, top - HERO_H, PAGE_W, HERO_H, MIDNIGHT);
    box(0, top - HERO_H, PAGE_W, 1.4, GOLD);
    text("FlowFi", M, top - 25, 16, heavy, WHITE);
    const bx = M + width("FlowFi", 16, heavy) + 10;
    page.drawLine({ start: { x: bx, y: top - 15 }, end: { x: bx, y: top - 28 }, thickness: 0.7, color: GOLD });
    tracked("MONTHLY SETTLEMENT", bx + 10, top - 24.2, 6.8, semi, GOLD_LIGHT, 1.4);
    const nameW = W - 230;
    const nameSize = sizeToFit(v.personName, 20, bold, nameW, 12);
    const generated = GENERATED.format(options.now ?? new Date());
    const meta: [string, string][] = [["PERIOD", v.cycleLabel], ["AS OF", v.asOf]];
    if (generated !== v.asOf) meta.push(["GENERATED", generated]);
    const rows = meta.length === 3 ? [22, 36, 50] : [24, 49];
    meta.forEach(([label, value], i) => {
      const shown = fit(value, medium, 8.8, 150);
      textRight(shown, M + W, top - rows[i], 8.8, medium, ON_MID);
      trackedRight(label, M + W - width(shown, 8.8, medium) - 12, top - rows[i], 5.8, semi, ON_MID_MUTED, 1);
    });
    text(fit(v.personName, bold, nameSize, nameW), M, top - 52, nameSize, bold, WHITE);
    y = top - HERO_H - 16;
  };
  const drawContinued = () => {
    const h = 28;
    box(0, PAGE_H - h, PAGE_W, h, MIDNIGHT);
    box(0, PAGE_H - h, PAGE_W, 1.2, GOLD);
    text("FlowFi", M, PAGE_H - 18, 10.5, heavy, WHITE);
    const x = M + width("FlowFi", 10.5, heavy) + 10;
    text(fit(`Monthly Settlement  ·  ${v.personName}  ·  ${v.cycleLabel}  ·  continued`, medium, 7.6, M + W - x), x, PAGE_H - 17.5, 7.6, medium, ON_MID);
    y = PAGE_H - h - 14;
  };

  // ---- Summary: one strong amount (with due-now / moved beneath it), then the sum that produces it ----
  const drawSummary = () => {
    const LEFT_W = 206;
    const rowH = (l: (typeof v.lines)[number]) => (l.note ? 36 : 25);
    const bodyH = v.lines.reduce((s, l) => s + rowH(l), 0) + 20;
    const H = Math.max(v.split ? 176 : 100, bodyH);
    const top = y;
    page.drawRectangle({ x: M, y: top - H, width: W, height: H, color: WHITE, borderColor: RULE_STRONG, borderWidth: 0.7 });
    box(M + 0.35, top - H + 0.35, LEFT_W, H - 0.7, NAVY_TINT);
    box(M + 0.35, top - H + 0.35, 3, H - 0.7, NAVY);
    const ix = M + 18;
    const ir = M + LEFT_W - 14;
    tracked(settled ? "ALL SETTLED" : "TOTAL OUTSTANDING", ix, top - 21, S.label + 0.4, semi, NAVY, 1.1);
    const total = money2(v.outstanding);
    const size = sizeToFit(total, 25, monoBold, LEFT_W - 32, 14);
    text(total, ix, top - 52, size, monoBold, settled ? PAID : NAVY);
    const hl = cap(wrap(settled ? "Nothing left to settle" : v.headline, LEFT_W - 32, medium, 9.6), 2, medium, 9.6, LEFT_W - 32);
    hl.forEach((t, i) => text(t, ix, top - 69 - i * 12, 9.6, medium, BODY));
    if (v.split) {
      // Due now (strong, gold-marked) and the postponed amount (quiet) — never read as one figure.
      const at = top - 70 - hl.length * 12 - 8;
      hline(ix, ir, at, hex(STATEMENT_INK.navyRule), 0.6);
      const row = (label: string, value: string, note: string, base: number, strong: boolean) => {
        if (strong) box(ix - 8, base - 22, 2, 28, GOLD);
        tracked(label, ix, base, S.label, semi, strong ? NAVY : MUTED, 0.9);
        amount(value, ir, base - 1, 11.5, monoBold, strong ? INK : BODY, 110);
        text(fit(note, regular, S.meta, ir - ix), ix, base - 13, S.meta, regular, MUTED);
      };
      row("DUE NOW", v.split.dueNow, "to collect this cycle", at - 17, true);
      row(v.split.postponedTo.toUpperCase(), v.split.postponed, "postponed · still owed, not cancelled", at - 17 - 38, false);
    }
    const lx = M + LEFT_W + 20;
    const vr = M + W - 16;
    let ly = top - 14;
    for (const l of v.lines) {
      const last = l.key === "outstanding";
      const base = ly - 12;
      if (last) hline(lx, vr, ly - 1, RULE_STRONG, 0.6);
      if (l.op) text(l.op === "−" ? (textCustom ? "−" : "-") : l.op, lx, base, 9, medium, FAINT);
      text(l.label, lx + 14, base, 9.6, last ? semi : medium, last ? INK : BODY);
      amount(l.value, vr, base, 10, last ? monoBold : monoRegular, l.key === "applied" ? PAID : INK, 130);
      if (l.note) text(fit(money2(l.note), regular, S.meta, vr - lx - 14), lx + 14, base - 12, S.meta, regular, MUTED);
      ly -= rowH(l);
    }
    y = top - H - 20;
  };

  const sectionTitle = (title: string, caption: string) => {
    box(M, y - 11, 2.4, 11, GOLD);
    text(title, M + 8, y - 9.4, 12.5, bold, INK);
    text(caption, M + 8 + width(title, 12.5, bold) + 9, y - 9.4, S.meta, regular, MUTED);
    y -= 22;
  };
  const ensure = (h: number, redraw?: () => void) => {
    if (y - h >= BOTTOM) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    drawContinued();
    redraw?.();
  };

  // ---- Items table ----
  const COLS = ["Date", "Description", "Amount", "Paid", "Remaining", "Status"];
  const tableHeader = () => {
    box(M, y - 20, W, 20, HEAD);
    hline(M, M + W, y - 20, RULE_STRONG, 0.7);
    COLS.forEach((c, i) => {
      const label = c.toUpperCase();
      if (i >= 2 && i <= 4) trackedRight(label, colRight(i), y - 13, S.label, semi, BODY);
      else tracked(label, colX(i) + PAD, y - 13, S.label, semi, BODY);
    });
    y -= 20;
  };
  const GROUP_H = 25;
  const groupBand = (label: string) => {
    page.drawCircle({ x: colX(0) + PAD + 1.6, y: y - 14, size: 1.6, color: GOLD });
    tracked(label, colX(0) + PAD + 8, y - 16.6, S.label, semi, NAVY);
    y -= GROUP_H;
  };
  const itemLayout = (it: MonthlyItem) => {
    const titleLines = cap(wrap(it.title, DESC_W, semi, S.title), 3, semi, S.title, DESC_W);
    const noteLines = it.note ? cap(wrap(money2(it.note), DESC_W, regular, S.meta), 2, regular, S.meta, DESC_W) : [];
    return { titleLines, noteLines, h: Math.max(36, 24 + titleLines.length * 12 + noteLines.length * 10.2 - (noteLines.length ? 3 : 0)) };
  };
  const drawItem = (it: MonthlyItem) => {
    const l = itemLayout(it);
    ensure(l.h + 4, tableHeader);
    const top = y;
    const line1 = top - 19;
    const zero = it.remaining.replace(/[^\d]/g, "").replace(/0/g, "") === "";
    const dm = it.date.match(/^(\d{1,2}) ([A-Za-z]{3})(?: (\d{4}))?$/);
    if (dm) {
      text(dm[1], colX(0) + PAD, line1 - 0.5, 12.5, semi, INK);
      tracked(`${dm[2].toUpperCase()}${dm[3] ? ` ${dm[3]}` : ""}`, colX(0) + PAD + 0.3, line1 - 11, 6.4, semi, MUTED, 0.7);
    } else text(it.date, colX(0) + PAD, line1, S.meta, regular, FAINT);
    const dx = colX(1) + PAD;
    l.titleLines.forEach((t, i) => text(t, dx, line1 - i * 12, S.title, semi, INK));
    l.noteLines.forEach((t, i) => text(t, dx, line1 - (l.titleLines.length - 1) * 12 - 11.5 - i * 10.2, S.meta, regular, MUTED));
    amount(it.amount, colRight(2), line1, S.money, monoBold, it.amount === "—" ? FAINT : INK, COL_W[2] - 2 * PAD);
    amount(it.paid, colRight(3), line1, S.money, monoRegular, it.paid === "—" ? FAINT : PAID, COL_W[3] - 2 * PAD);
    amount(it.remaining, colRight(4), line1, S.money + 0.4, zero ? monoRegular : monoBold, zero || it.remaining === "—" ? FAINT : it.chip === "overdue" ? CHIP_TEXT.overdue : INK, COL_W[4] - 2 * PAD);
    // Status: a dot and one short word, in the status colour.
    const color = CHIP_TEXT[it.chip];
    page.drawCircle({ x: colX(5) + PAD + 2.6, y: line1 + 3, size: 2.4, color });
    text(fit(it.status, semi, 8.8, COL_W[5] - 2 * PAD - 9), colX(5) + PAD + 9, line1, 8.8, semi, color);
    y = top - l.h;
    hline(M, M + W, y, RULE, 0.4);
  };

  // ---- Payments: a compact receipt ledger — date · where it arrived · amount, then where it went ----
  const receipt = (p: MonthlyPayment) => {
    const source = p.source ? tidyAccount(p.source) : "";
    // The statement already says who paid (section caption), so a receipt is titled by where it arrived.
    if (p.inbound && !p.advance && source.startsWith("Received in")) return { title: source, sub: "" };
    if (p.inbound && !p.advance) return { title: "Payment received", sub: source };
    return { title: p.label, sub: source };
  };
  const payLayout = (p: MonthlyPayment) => {
    const r = receipt(p);
    const titleLines = cap(wrap(r.title, DESC_W + COL_W[0] - 8, semi, S.title), 2, semi, S.title, DESC_W);
    const subLines = r.sub ? cap(wrap(r.sub, DESC_W + COL_W[0] - 8, regular, S.meta), 2, regular, S.meta, DESC_W) : [];
    const h = 24 + (titleLines.length - 1) * 12 + subLines.length * 10.5 + p.lines.length * 14 + (p.lines.length ? 4 : 0) + 6;
    return { titleLines, subLines, h };
  };
  const drawPayment = (p: MonthlyPayment) => {
    const l = payLayout(p);
    ensure(l.h + 4);
    const top = y;
    let ly = top - 19;
    text(p.date === "Date not known" ? "Date n/k" : p.date.replace(/ \d{4}$/, ""), colX(0) + PAD, ly, 9.6, semi, INK);
    const dx = colX(0) + PAD + 50;
    l.titleLines.forEach((t, i) => text(fit(t, semi, S.title, colRight(4) - dx - 90), dx, ly - i * 12, S.title, semi, INK));
    amount(p.amount, colRight(4), ly, S.money + 0.6, monoBold, p.inbound ? PAID : INK, 100);
    ly -= (l.titleLines.length - 1) * 12;
    l.subLines.forEach((t) => {
      ly -= 10.5;
      text(t, dx, ly, S.meta, regular, MUTED);
    });
    ly -= 4;
    for (const a of p.lines) {
      ly -= 14;
      text(fit(a.label, regular, S.meta + 0.6, colRight(3) - dx - 56), dx, ly, S.meta + 0.6, regular, BODY);
      if (a.amount) amount(a.amount, colRight(4), ly, S.meta + 1, monoRegular, BODY, 80);
      if (a.tail) text(fit(money2(a.tail), a.cleared ? semi : regular, S.meta, COL_W[5] - 2 * PAD), colX(5) + PAD, ly, S.meta, a.cleared ? semi : regular, a.cleared ? PAID : MUTED);
    }
    y = top - l.h;
    hline(M, M + W, y, RULE, 0.4);
  };

  // ---- Compose ----
  drawHero();
  drawSummary();

  const cycleItems = v.items.filter((i) => i.group === "cycle").length;
  const earlier = v.items.filter((i) => i.group !== "cycle").length;
  const openCount = v.items.filter((i) => i.remainingPaise > 0).length;
  sectionTitle("This cycle's items", v.items.length === 0 ? "" : `${v.items.length} ${v.items.length === 1 ? "line" : "lines"}  ·  ${openCount === 0 ? "all settled" : `${openCount} still open`}`);
  ensure(18 + (v.items[0] ? itemLayout(v.items[0]).h : 30), undefined);
  tableHeader();
  if (v.items.length === 0) {
    box(M, y - 26, W, 26, WHITE);
    text("No new items this cycle.", colX(1) + PAD, y - 16, S.title, regular, MUTED);
    y -= 26;
    hline(M, M + W, y, RULE, 0.6);
  }
  let band: "earlier" | "cycle" | null = null;
  const bands = earlier > 0 && cycleItems > 0;
  for (const it of v.items) {
    const g = it.group === "cycle" ? "cycle" : "earlier";
    if (bands && g !== band) {
      ensure(GROUP_H + itemLayout(it).h + 4, tableHeader);
      groupBand(g === "cycle" ? "THIS CYCLE" : "EARLIER BALANCE");
    }
    band = g;
    drawItem(it);
  }
  y -= 4;

  if (v.payments.length > 0) {
    y -= 18;
    ensure(36 + payLayout(v.payments[0]).h);
    sectionTitle("Payments this cycle", `${v.payments.length} ${v.payments.length === 1 ? "payment" : "payments"}${v.payments.every((x) => x.inbound && !x.advance) ? `  ·  received from ${v.personName}` : ""}`);
    hline(M, M + W, y, RULE_STRONG, 0.7);
    v.payments.forEach(drawPayment);
    if (v.payments.length > 1 && v.totalPaid) {
      ensure(26);
      textRight("Total received", colRight(3) - 6, y - 17, S.meta + 0.6, semi, BODY);
      amount(v.totalPaid, colRight(4), y - 17, S.money + 0.4, monoBold, PAID, 100);
      y -= 26;
    }
  }
  if (v.advance) {
    ensure(26);
    y -= 10;
    text(`${v.advance.label} ${v.advance.value} — held apart, not part of the total outstanding.`, M, y - 8, S.meta + 0.4, regular, MUTED);
    y -= 16;
  }

  // ---- Footer (every page) ----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    hline(M, M + W, FOOTER_H, RULE_STRONG, 0.6);
    // The total is stated once, in the summary; a multi-page document repeats it per page so a loose page still says what is owed.
    text(settled ? "Settled — nothing outstanding" : v.headline, M, FOOTER_H - 15, 9.4, semi, INK);
    if (pages.length > 1 && !settled) textRight(`Outstanding ${money2(v.outstanding)}`, M + W, FOOTER_H - 15, 9.4, semi, BODY);
    const left = `Prepared by ${v.ownerName}  ·  Period ${v.cycleLabel}`;
    text(fit(left, regular, S.meta, W - 80), M, FOOTER_H - 30, S.meta, regular, MUTED);
    if (pages.length > 1) textRight(`Page ${i + 1} of ${pages.length}`, M + W, FOOTER_H - 30, S.meta, semi, BODY);
  });
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj([pages[0].ref, PDFName.of("FitH"), PDFNull]));
  return doc.save();
}
