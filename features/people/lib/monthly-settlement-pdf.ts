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
import { money2, monthlySettlementView, tidyAccount, type MonthlySummaryLine } from "@/features/people/lib/monthly-settlement-model";
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
const NAVY = hex(STATEMENT_INK.navy);
const MIDNIGHT = hex(STATEMENT_INK.midnight);
const ON_MID = hex(STATEMENT_INK.onMidnight);
const GOLD = hex(STATEMENT_INK.gold);
const WHITE = rgb(1, 1, 1);
const CHIP_TEXT = Object.fromEntries(Object.entries(STATEMENT_CHIP).map(([k, v]) => [k, hex(v.text)])) as Record<StatementChip, RGB>;
const PAID = CHIP_TEXT.paid;

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;
const W = PAGE_W - 2 * M;
const RED = CHIP_TEXT.overdue;
/** Type sizes (pt): nothing under 7.4 except the tracked small-caps signposts. */
const S = { title: 8.8, money: 8.8, meta: 7.4, label: 5.8 } as const;
const TRACK = 0.8;
const FOOTER_H = 42;
const BOTTOM = FOOTER_H + 10;
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
  // Figures share the text face (Plus Jakarta Sans) so amounts read like the rest of the page; `fig*` below sets the digits
  // on a fixed advance (tabular numerals), so a column of amounts lines up digit for digit.
  const monoRegular = textCustom ? regular : amountCustom ? await embed(amountCustom.regular) : regular;
  const monoBold = textCustom ? semi : amountCustom ? await embed(amountCustom.bold) : bold;
  const textFaces = new Set<PDFFont>([regular, medium, semi, bold, heavy]);
  const unicodeFaces = new Set<PDFFont>([...(textCustom ? [regular, medium, semi, bold, heavy] : []), ...(amountCustom && !textCustom ? [monoRegular, monoBold] : [])]);
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
    return amountCustom && !textCustom && textFaces.has(f) && s.includes("₹")
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
  // Tabular figures: every digit takes the widest digit's advance (a narrow "1" is centred in its cell); separators keep
  // their own width. Right-aligned, so thousands separators and decimals fall in the same place on every row.
  const digitCell = new Map<PDFFont, number>();
  const cellOf = (f: PDFFont, size: number) => {
    let w = digitCell.get(f);
    if (w === undefined) {
      w = Math.max(...[..."0123456789"].map((d) => f.widthOfTextAtSize(encode(d, f), 1)));
      digitCell.set(f, w);
    }
    return w * size;
  };
  const figWidth = (str: string, size: number, f: PDFFont) =>
    [...str].reduce((w, ch) => w + (/\d/.test(ch) ? cellOf(f, size) : f.widthOfTextAtSize(encode(ch, f), size)), 0);
  const fig = (str: string, x: number, yy: number, size: number, f: PDFFont, color: RGB) => {
    let cx = x;
    for (const ch of str) {
      const e = encode(ch, f);
      const w = f.widthOfTextAtSize(e, size);
      const cell = /\d/.test(ch) ? cellOf(f, size) : w;
      if (e) page.drawText(e, { x: cx + (cell - w) / 2, y: yy, size, font: f, color });
      cx += cell;
    }
  };
  const figFit = (str: string, size: number, f: PDFFont, maxW: number, min = 7) => {
    let sz = size;
    while (sz > min && figWidth(str, sz, f) > maxW) sz -= 0.25;
    return sz;
  };
  const amount = (s: string, right: number, yy: number, size: number, f: PDFFont, color: RGB, maxW: number) => {
    const t = safe(money2(s));
    const sz = figFit(t, size, mono(f), maxW);
    fig(t, right - figWidth(t, sz, mono(f)), yy, sz, mono(f), color);
  };
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

  const first = v.personName.split(" ")[0];
  const generated = GENERATED.format(options.now ?? new Date());

  // ---- Header: invoice-style masthead — wordmark left, statement details right ----
  const SURFACE = hex(STATEMENT_INK.surface);
  const RIGHT = M + W - 8;
  const drawHero = () => {
    const top = PAGE_H;
    box(0, top - 6, PAGE_W, 6, MIDNIGHT);
    box(0, top - 7.2, PAGE_W, 1.2, GOLD);
    y = top - 40;
    text("FlowFi", M, y, 20, heavy, NAVY);
    tracked("MONTHLY SETTLEMENT", M + 1, y - 14, 6, semi, GOLD, 1.5);
    const meta: [string, string][] = [["PERIOD", v.cycleLabel], ["AS OF", v.asOf], ["PREPARED BY", v.ownerName]];
    meta.forEach(([label, value], i) => {
      const yy = y + 4 - i * 12.5;
      tracked(label, M + W - 215, yy, 5.6, semi, MUTED, 1);
      text(fit(value, semi, 8.6, 135), M + W - 135, yy, 8.6, semi, INK);
    });
    y -= 36;
    hline(M, M + W, y, RULE_STRONG, 0.7);
    // From / For
    y -= 16;
    tracked("STATEMENT FOR", M, y, 5.6, semi, MUTED, 1);
    text(fit(v.personName, bold, 12.5, 240), M, y - 15, 12.5, bold, INK);
    tracked("FROM", M + 280, y, 5.6, semi, MUTED, 1);
    text(fit(v.ownerName, bold, 12.5, 240), M + 280, y - 15, 12.5, bold, INK);
    y -= 32;
  };
  const drawContinued = () => {
    const h = 26;
    box(0, PAGE_H - h, PAGE_W, h, MIDNIGHT);
    box(0, PAGE_H - h, PAGE_W, 1.2, GOLD);
    text("FlowFi", M, PAGE_H - 17, 10.5, heavy, WHITE);
    const x = M + width("FlowFi", 10.5, heavy) + 10;
    text(fit(`Monthly Settlement  ·  ${v.personName}  ·  ${v.cycleLabel}  ·  continued`, medium, 7.4, M + W - x), x, PAGE_H - 16.5, 7.4, medium, ON_MID);
    y = PAGE_H - h - 14;
  };
  const ensure = (h: number, redraw?: () => void) => {
    if (y - h >= BOTTOM) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    drawContinued();
    redraw?.();
  };

  // ---- Amount due: one slim band, like the "amount due" line of an invoice ----
  const drawDue = () => {
    const H = 46;
    const top = y;
    box(M, top - H, W, H, MIDNIGHT);
    box(M, top - 1.2, W, 1.2, GOLD);
    tracked(settled ? "ALL SETTLED" : "BALANCE TO PAY", M + 14, top - 17, 5.8, semi, GOLD, 1.3);
    text(fit(settled ? "Nothing left to pay" : v.headline, medium, 9.2, 300), M + 14, top - 32, 9.2, medium, WHITE);
    const total = money2(v.outstanding);
    const size = figFit(total, 22, bold, 200, 14);
    fig(total, M + W - 14 - figWidth(total, size, bold), top - 30, size, bold, settled ? hex(STATEMENT_INK.settledOnMidnight) : WHITE);
    y = top - H - 6;
    // Due now vs postponed, one plain line under the band.
    const sub = v.split
      ? `${money2(v.split.dueNow)} to pay now  ·  ${money2(v.split.postponed)} postponed to ${v.split.postponedTo}`
      : v.mixed
        ? `${first} owes ${money2(v.mixed.theyOwe)}  ·  ${v.ownerShort} owes ${money2(v.mixed.ownerOwes)}`
        : "";
    if (sub) {
      textRight(sub, M + W, y - 8, 8, semi, v.split ? CHIP_TEXT.upcoming : MUTED);
      y -= 14;
    }
    y -= 14;
  };

  // ---- Tables: navy header row, zebra rows. Date · Description · Type/Note · Amount ----
  const COL_DATE = M + 8;
  const COL_WHAT = M + 58;
  const MIDW = 104;
  const COL_MID = M + W - 100 - MIDW;
  const WHAT_W = COL_MID - COL_WHAT - 8;
  const heading = (title: string, caption: string) => {
    text(title, M, y - 9, 10, bold, INK);
    if (caption) textRight(caption, M + W, y - 8.5, S.meta, regular, MUTED);
    y -= 17;
  };
  const header = (labels: [string, string, string, string]) => {
    box(M, y - 16, W, 16, MIDNIGHT);
    tracked(labels[0].toUpperCase(), COL_DATE, y - 10.6, 5.6, semi, WHITE, 0.9);
    tracked(labels[1].toUpperCase(), COL_WHAT, y - 10.6, 5.6, semi, WHITE, 0.9);
    tracked(labels[2].toUpperCase(), COL_MID, y - 10.6, 5.6, semi, WHITE, 0.9);
    trackedRight(labels[3].toUpperCase(), RIGHT, y - 10.6, 5.6, semi, WHITE, 0.9);
    y -= 16;
  };
  const dateText = (date: string) => date.replace(/ \d{4}$/, "").replace("Date not known", "Date n/k");
  let stripe = 0;
  const row = (date: string, title: string, sub: string, mid: string, value: string, color: RGB, redraw: () => void) => {
    const titleLines = cap(wrap(title, WHAT_W, semi, S.title), 2, semi, S.title, WHAT_W);
    const subLines = sub ? cap(wrap(money2(sub), WHAT_W, regular, S.meta), 2, regular, S.meta, WHAT_W) : [];
    const h = Math.max(22, 10 + titleLines.length * 10.4 + subLines.length * 8.8 + 4);
    ensure(h + 2, redraw);
    const top = y;
    if (stripe++ % 2 === 1) box(M, top - h, W, h, SURFACE);
    const l1 = top - 14;
    text(dateText(date), COL_DATE, l1, 8.2, medium, BODY);
    titleLines.forEach((t, i) => text(t, COL_WHAT, l1 - i * 10.4, S.title, semi, INK));
    subLines.forEach((t, i) => text(t, COL_WHAT, l1 - (titleLines.length - 1) * 10.4 - 9.8 - i * 8.8, S.meta, regular, MUTED));
    if (mid) text(fit(mid, regular, 8, MIDW - 8), COL_MID, l1, 8, regular, BODY);
    amount(value, RIGHT, l1, S.money, monoBold, color, 96);
    y = top - h;
  };
  const subLabel = (label: string) => {
    ensure(30);
    tracked(label, COL_DATE, y - 12, 5.6, semi, NAVY, 1);
    y -= 17;
    stripe = 0;
  };

  // ---- Compose ----
  drawHero();
  drawDue();

  const itemHeader = () => {
    stripe = 0;
    header(["Date", "Description", "Type", "Amount"]);
  };
  heading("Items this month", v.items.length === 0 ? "" : `${v.items.length} ${v.items.length === 1 ? "item" : "items"}`);
  ensure(34);
  itemHeader();
  if (v.items.length === 0) {
    text("No new items this month.", COL_WHAT, y - 14, S.title, regular, MUTED);
    y -= 22;
  }
  const cycleItems = v.items.filter((i) => i.group === "cycle").length;
  const earlier = v.items.filter((i) => i.group !== "cycle").length;
  const bands = earlier > 0 && cycleItems > 0;
  let band: "earlier" | "cycle" | null = null;
  for (const it of v.items) {
    const g = it.group === "cycle" ? "cycle" : "earlier";
    if (bands && g !== band) subLabel(g === "cycle" ? "THIS MONTH" : "FROM EARLIER MONTHS");
    band = g;
    row(it.date, it.title, it.detail, it.type, it.amount, it.amount === "—" ? FAINT : INK, itemHeader);
  }
  hline(M, M + W, y, RULE_STRONG, 0.7);
  y -= 18;

  if (v.payments.length > 0) {
    ensure(17 + 16 + 26);
    heading("Payments received", `${v.payments.length} ${v.payments.length === 1 ? "payment" : "payments"}`);
    const payHeader = () => {
      stripe = 0;
      header(["Date", "Received in", "Toward", "Amount"]);
    };
    payHeader();
    for (const p of v.payments) {
      const src = p.source ? tidyAccount(p.source) : "";
      const m = src.match(/^(?:Received in|Paid from) (.+)$/);
      const inbound = p.inbound && !p.advance;
      const title = inbound ? (m ? m[1] : src || "Payment received") : p.label;
      const pc = p.status === "Received" ? PAID : p.status === "Paid" ? RED : CHIP_TEXT.advance;
      const sign = p.status === "Paid" ? (textCustom ? "−" : "-") : "+";
      row(p.date, title, !inbound && src ? src : "", p.note ?? "", `${sign}${p.amount}`, pc, payHeader);
    }
    hline(M, M + W, y, RULE_STRONG, 0.7);
    y -= 18;
  }

  // ---- Totals: the invoice's closing block, bottom right; the plain-words note sits to its left ----
  {
    const line = (k: MonthlySummaryLine["key"]) => v.lines.find((l) => l.key === k);
    const none = money2("₹0");
    const got = line("applied");
    const rows = [
      { label: "Balance from earlier months", value: line("previous")?.value ?? none, color: INK },
      { label: "Added this month", value: line("new")?.value ?? none, color: INK },
      { label: `Paid by ${first}`, value: got ? `${textCustom ? "−" : "-"}${got.value}` : none, color: got ? PAID : FAINT },
    ];
    const TW = 236;
    const x0 = M + W - TW;
    const h = rows.length * 15 + 34;
    ensure(h + 6);
    const top = y;
    const noteLines = wrap("Payments are counted against the whole balance, not against one item. Item amounts are the original amounts.", x0 - M - 24, regular, S.meta);
    noteLines.forEach((t, i) => text(t, M, top - 11 - i * 9.6, S.meta, regular, MUTED));
    let ry = top;
    rows.forEach((r) => {
      text(r.label, x0, ry - 11, 8.6, regular, BODY);
      amount(r.value, RIGHT, ry - 11, 8.8, monoRegular, r.color, 90);
      ry -= 15;
    });
    box(x0, ry - 24, TW, 22, SURFACE);
    box(x0, ry - 3.2, TW, 1.2, NAVY);
    text(settled ? "All settled" : "Balance to pay", x0 + 0, ry - 17, 9.4, bold, INK);
    amount(line("outstanding")?.value ?? v.closing.value, RIGHT, ry - 17, 10, monoBold, settled ? PAID : NAVY, 96);
    y = ry - 32;
  }
  if (v.advance) {
    ensure(26);
    y -= 6;
    text(`${v.advance.label} ${v.advance.value} — held apart, not part of the total outstanding.`, M, y - 8, S.meta + 0.4, regular, MUTED);
    y -= 16;
  }

  // ---- Footer (every page) ----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    hline(M, M + W, FOOTER_H, RULE_STRONG, 0.6);
    text(fit(`Prepared by ${v.ownerName}  ·  Period ${v.cycleLabel}`, medium, S.meta, W - 90), M, FOOTER_H - 14, S.meta, medium, BODY);
    textRight(`Page ${i + 1} of ${pages.length}`, M + W, FOOTER_H - 14, S.meta, semi, BODY);
    text(`Generated ${generated} by FlowFi`, M, FOOTER_H - 26, 6.8, regular, MUTED);
  });
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj([pages[0].ref, PDFName.of("FitH"), PDFNull]));
  return doc.save();
}
