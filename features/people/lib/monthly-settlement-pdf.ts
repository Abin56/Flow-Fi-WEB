/**
 * The Monthly Settlement PDF — the short statement a person shares over WhatsApp for ONE cycle. Portrait A4 so a
 * phone shows it full width. Redesigned (2026-11-25) as a compact, professional account statement: mostly white
 * paper with a single restrained navy accent, one clear answer (the remaining balance), a scannable transaction
 * table with each item's own Paid/Remaining when the engine tracks one, and a plain settlement equation at the
 * bottom. No large navy blocks, no zebra striping, no decorative tracking beyond the smallest meta labels.
 *
 * Rendered solely from `monthlySettlementView`; the only numbers computed here are layout coordinates. The full
 * statement (`renderPersonStatementPdf`) is untouched and stays the complete-history document, built separately.
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFNull, StandardFonts, setCharacterSpacing, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { money2, monthlySettlementView, tidyAccount, type MonthlyPayment, type MonthlySummaryLine } from "@/features/people/lib/monthly-settlement-model";
import { pdfSafe, type StatementAmountFonts, type StatementTextFonts } from "@/features/people/lib/person-statement-pdf";
import type { StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import { hexToUnit, STATEMENT_CHIP, STATEMENT_INK } from "@/features/people/lib/statement-palette";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";

const hex = (h: string) => rgb(...hexToUnit(h));
const INK = hex(STATEMENT_INK.ink);
const BODY = hex(STATEMENT_INK.body);
// Refined for the Monthly PDF only (2026-11-25 polish pass) — the shared palette (`statement-palette.ts`, used by
// the Full PDF and the on-screen preview) is untouched; these three tokens are local overrides.
const MUTED = hex("#64748B");
const FAINT = hex(STATEMENT_INK.faint);
const RULE = hex(STATEMENT_INK.rule);
const RULE_STRONG = hex(STATEMENT_INK.ruleStrong);
const NAVY = hex("#142544");
const NAVY_TINT = hex("#EDF2F8");
const GOLD = hex(STATEMENT_INK.gold);
const WHITE = rgb(1, 1, 1);
const PAID = hex(STATEMENT_CHIP.paid.text);
const RED = hex(STATEMENT_CHIP.overdue.text);
const ADVANCE = hex(STATEMENT_CHIP.advance.text);
const UPCOMING = hex(STATEMENT_CHIP.upcoming.text);

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const W = PAGE_W - 2 * M;
/** Type sizes (pt). Transaction descriptions sit at 9.8 (close to the 10–10.5 a reader expects from a statement);
 * secondary labels at 8.4 read clearly even on a compressed WhatsApp screenshot; nothing is smaller than that
 * except the tiniest tracked column-header caps (`label`), which stay small by design. */
const S = { title: 9.8, money: 9.4, meta: 8.4, label: 6.4 } as const;
/** Line pitch for a wrapped title / note, proportioned to `S.title` / `S.meta` so a size change never cramps lines. */
const LH_TITLE = 11.1;
const LH_META = 9.5;
/** Letter-spacing kept small — only the tiniest meta labels are tracked at all. */
const TRACK = 0.3;
const FOOTER_H = 34;
const BOTTOM = FOOTER_H + 8;
const GENERATED = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** TTF bytes for Inter (Regular/Medium/SemiBold/Bold/ExtraBold, from `public/fonts/inter`) — the Monthly PDF's own
 * text face (the Full PDF keeps Plus Jakarta Sans; this loader is never used there). Static per-weight files from
 * the official rsms/inter v4.1 release (`extras/ttf/`), since Google Fonts now ships Inter only as a variable font
 * that pdf-lib/fontkit can't reliably split into discrete weights. SIL OFL licensed, same as the bundled
 * Plus Jakarta Sans. Falls back to Plus Jakarta Sans (then Helvetica) if these can't be fetched. */
export async function loadMonthlySettlementTextFonts(base = "/fonts/inter"): Promise<StatementTextFonts | null> {
  try {
    const fetchOne = async (file: string) => {
      const res = await fetch(`${base}/${file}`);
      if (!res.ok) throw new Error(file);
      return res.arrayBuffer();
    };
    const [regular, medium, semibold, bold, extrabold] = await Promise.all(
      ["Inter-Regular.ttf", "Inter-Medium.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf", "Inter-ExtraBold.ttf"].map(fetchOne),
    );
    return { regular, medium, semibold, bold, extrabold };
  } catch {
    return null;
  }
}

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
  const hline = (x0: number, x1: number, yy: number, color = RULE, t = 0.6) => page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness: t, color });
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
  /** Left-aligned amount — for a figure that must sit directly under its own label, not right-justified across a
   * wide cell (which visually detaches a value from its label when two stats share one row). */
  const amountLeft = (s: string, x: number, yy: number, size: number, f: PDFFont, color: RGB, maxW: number) => {
    const t = safe(money2(s));
    const sz = figFit(t, size, mono(f), maxW);
    fig(t, x, yy, sz, mono(f), color);
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
  const RIGHT = M + W;

  // ---- Header: a compact, quietly premium masthead — a double hairline signature (not a block), the person
  // named clearly with a small direction pill, and period/prepared-by kept small and secondary. ----
  // The direction pill and the balance card below share one accent colour, so the eye reads them as one
  // statement rather than two separately-styled pieces.
  const accent = settled ? PAID : v.direction === "iOwe" ? RED : NAVY;
  const accentTint = settled ? hex(STATEMENT_CHIP.paid.fill) : v.direction === "iOwe" ? hex(STATEMENT_CHIP.overdue.fill) : NAVY_TINT;
  const drawHero = () => {
    const top = PAGE_H - 26;
    y = top;
    text("FlowFi", M, y, 17, heavy, NAVY);
    const wmW = width("FlowFi", 17, heavy);
    box(M + wmW + 10, y - 3, 3, 9.5, GOLD); // a single quiet accent mark — the page's one touch of gold up top
    tracked("MONTHLY SETTLEMENT", M + wmW + 17, y - 0.2, S.label, semi, MUTED, TRACK);
    textRight(fit(`${v.cycleLabel}  ·  As of ${v.asOf}`, regular, S.meta, 270), RIGHT, y, S.meta, regular, MUTED);
    textRight(fit(`Prepared by ${v.ownerName}`, regular, S.meta - 0.8, 270), RIGHT, y - 11, S.meta - 0.8, regular, MUTED);
    y -= 17;
    // A fine double rule — navy over a hairline of gold — the one bit of "signature" styling, a few points tall.
    hline(M, RIGHT, y, NAVY, 1.1);
    hline(M, RIGHT, y - 2.2, GOLD, 0.6);
    y -= 15;
    tracked("STATEMENT FOR", M, y, S.label, semi, MUTED, TRACK);
    y -= 18;
    text(fit(v.personName, semi, 16, W - 130), M, y, 16, semi, INK);
    // A small direction pill on the same line as the name — reads at a glance, no extra height spent.
    // The statement is read by the person, so it never says "you" — the owner is named instead.
    const pillLabel = settled ? "SETTLED" : v.direction === "iOwe" ? `${v.ownerShort.toUpperCase()} OWES` : "RECEIVABLE";
    const pillW = trackedW(pillLabel, S.label, semi, 0.7) + 16;
    box(RIGHT - pillW, y - 2, pillW, 13, accentTint);
    tracked(pillLabel, RIGHT - pillW + 8, y + 2.2, S.label, semi, accent, 0.7);
    y -= 14;
  };
  const drawContinued = () => {
    const h = 22;
    box(0, PAGE_H - h, PAGE_W, h, NAVY_TINT);
    box(0, PAGE_H - h, PAGE_W, 1.4, NAVY);
    text("FlowFi", M, PAGE_H - 15, 9, bold, NAVY);
    const x = M + width("FlowFi", 9, bold) + 8;
    text(fit(`Monthly Settlement  ·  ${v.personName}  ·  ${v.cycleLabel}  ·  continued`, medium, S.meta, RIGHT - x), x, PAGE_H - 14.5, S.meta, medium, MUTED);
    y = PAGE_H - h - 14;
  };
  const ensure = (h: number, redraw?: () => void) => {
    if (y - h >= BOTTOM) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    drawContinued();
    redraw?.();
  };

  // ---- Balance: one clean, stronger card — a soft tint, a crisp border and a slim top accent edge (never a
  // heavy filled block) — the figure is the one thing on the page drawn large. ----
  const drawBalance = () => {
    const hasStats = Boolean(v.split || v.mixed);
    const H = hasStats ? 60 : 44;
    const top = y;
    page.drawRectangle({ x: M, y: top - H, width: W, height: H, borderColor: RULE_STRONG, borderWidth: 0.8, color: NAVY_TINT });
    box(M, top - 2, W, 2, accent); // a slim top edge, not a full band — the same accent colour as the name's pill
    tracked(settled ? "ALL SETTLED" : "REMAINING BALANCE", M + 16, top - 17, S.label, semi, MUTED, TRACK);
    // The headline never runs into the total figure's column — it wraps to its own line instead, so the two
    // never compete for the same row. It also stays clear of the stat row below when one is drawn.
    const headlineW = RIGHT - 16 - (M + 16) - 150;
    text(fit(settled ? "Nothing left to pay" : v.headline, medium, 9.4, headlineW), M + 16, top - 29, 9.4, medium, BODY);
    const totalStr = money2(v.outstanding);
    const size = figFit(totalStr, 21, bold, 190, 14);
    fig(totalStr, RIGHT - 16 - figWidth(totalStr, size, bold), top - 28, size, bold, settled ? PAID : NAVY);
    // Due now / Postponed / mixed-direction breakdown — two small stat cells in their own quiet sub-band, kept
    // clear of the headline above it.
    if (hasStats) {
      const statTop = top - 38;
      box(M + 1, statTop - 22, W - 2, 22, WHITE);
      hline(M + 14, RIGHT - 14, statTop, RULE, 0.5);
      const stats: { label: string; value: string; color: RGB }[] = v.split
        ? [
            { label: "Due now", value: money2(v.split.dueNow), color: INK },
            { label: `Postponed to ${v.split.postponedTo}`, value: money2(v.split.postponed), color: UPCOMING },
          ]
        : [
            { label: `${first} owes`, value: money2(v.mixed!.theyOwe), color: INK },
            { label: `${v.ownerShort} owes`, value: money2(v.mixed!.ownerOwes), color: INK },
          ];
      // Each label sits directly above its own value, both left-aligned — never a value right-justified across
      // a wide cell, which would visually detach it from the label it belongs to.
      const cellW = (W - 32) / stats.length;
      stats.forEach((st, i) => {
        const cx = M + 16 + i * cellW;
        text(fit(st.label, regular, S.meta, cellW - 20), cx, statTop - 15, S.meta, regular, MUTED);
        amountLeft(st.value, cx, statTop - 29, 11, semi, st.color, cellW - 20);
      });
      for (let i = 1; i < stats.length; i++) {
        const dx = M + 16 + i * cellW - 16;
        page.drawLine({ start: { x: dx, y: statTop - 4 }, end: { x: dx, y: statTop - 20 }, thickness: 0.6, color: RULE });
      }
    }
    y = top - H - 15;
  };

  // ---- Tables: thin navy header row, hairline row separators (no zebra). Date · Description · Amount columns ----
  const COL_DATE = M + 6;
  const COL_WHAT = M + 52;
  const AMT_COLS = 3; // Amount, Paid, Remaining (or Amount, Source/For, Amount for payments)
  const AMT_W = 68;
  const AMT_GAP = 8;
  const colRight = (fromRight: number) => RIGHT - 6 - fromRight * (AMT_W + AMT_GAP);
  const WHAT_W = colRight(AMT_COLS - 1) - AMT_W - COL_WHAT - 10;
  const heading = (title: string, caption: string) => {
    text(title, M, y - 9, 10.5, bold, INK);
    if (caption) textRight(caption, RIGHT, y - 8.5, S.meta, regular, MUTED);
    y -= 16;
  };
  const header = (labels: [string, string, string, string]) => {
    box(M, y - 15, W, 15, NAVY);
    tracked(labels[0].toUpperCase(), COL_DATE, y - 10.2, S.label, semi, WHITE, TRACK);
    tracked(labels[1].toUpperCase(), COL_WHAT, y - 10.2, S.label, semi, WHITE, TRACK);
    trackedRight(labels[2].toUpperCase(), colRight(1), y - 10.2, S.label, semi, WHITE, TRACK);
    trackedRight(labels[3].toUpperCase(), colRight(0), y - 10.2, S.label, semi, WHITE, TRACK);
    y -= 15;
  };
  const dateText = (date: string) => date.replace(/ \d{4}$/, "").replace("Date not known", "Date n/k");
  const row = (
    date: string,
    title: string,
    sub: string,
    // right-most first: [Remaining, Paid] or [Amount] etc — length matches header's amount columns. `muted`
    // (never inferred from the colour itself) picks the de-emphasised regular weight for an untracked figure.
    cols: { value: string; color: RGB; muted?: boolean }[],
    redraw: () => void,
  ) => {
    const titleLines = cap(wrap(title, WHAT_W, semi, S.title), 2, semi, S.title, WHAT_W);
    const subLines = sub ? cap(wrap(money2(sub), WHAT_W, regular, S.meta), 2, regular, S.meta, WHAT_W) : [];
    const h = Math.max(21, 9 + titleLines.length * LH_TITLE + subLines.length * LH_META + 5);
    ensure(h + 1, redraw);
    const top = y;
    const l1 = top - 13.5;
    text(dateText(date), COL_DATE, l1, S.meta, medium, BODY);
    titleLines.forEach((t, i) => text(t, COL_WHAT, l1 - i * LH_TITLE, S.title, semi, INK));
    subLines.forEach((t, i) => text(t, COL_WHAT, l1 - (titleLines.length - 1) * LH_TITLE - (LH_TITLE - 0.6) - i * LH_META, S.meta, regular, MUTED));
    cols.forEach((c, i) => {
      if (c.value) amount(c.value, colRight(cols.length - 1 - i), l1, S.money, c.muted ? monoRegular : monoBold, c.color, AMT_W);
    });
    y = top - h;
    hline(M, RIGHT, y, RULE, 0.5);
  };
  const subLabel = (label: string) => {
    ensure(28);
    tracked(label, COL_DATE, y - 11, S.label, semi, NAVY, TRACK);
    y -= 15;
  };

  // ---- Compose ----
  drawHero();
  drawBalance();

  const itemHeader = () => header(["Date", "Description", "Paid", "Remaining"]);
  const cycleItems = v.items.filter((i) => i.group === "cycle").length;
  const earlier = v.items.filter((i) => i.group !== "cycle").length;
  // A heading that doesn't claim more than the table shows: once anything carries forward from an earlier
  // cycle, "this month" would mislead (the 03 Oct item on a 17 Nov–16 Dec statement is a real example).
  const itemsTitle = earlier > 0 ? "Outstanding Items" : "Items This Cycle";
  heading(itemsTitle, v.items.length === 0 ? "" : `${v.items.length} ${v.items.length === 1 ? "item" : "items"}`);
  ensure(32);
  itemHeader();
  if (v.items.length === 0) {
    text("No new items this month.", COL_WHAT, y - 13, S.title, regular, MUTED);
    y -= 20;
    hline(M, RIGHT, y, RULE, 0.5);
  }
  const bands = earlier > 0 && cycleItems > 0;
  let band: "earlier" | "cycle" | null = null;
  for (const it of v.items) {
    const g = it.group === "cycle" ? "cycle" : "earlier";
    if (bands && g !== band) subLabel(g === "cycle" ? "This cycle" : "From earlier cycles");
    band = g;
    // Item-level Paid/Remaining ONLY when the engine tracks a settlement state for this row (never guessed).
    // Otherwise the row falls back to its plain Amount plus a status word — no invented allocation.
    // cols are given left-to-right, matching the header's own column order ("Paid" then "Remaining").
    const cols =
      it.paid != null && it.remaining != null
        ? [
            { value: it.paid, color: it.paid === "₹0" ? MUTED : PAID, muted: it.paid === "₹0" },
            { value: it.remaining, color: it.tag === "Overdue" ? RED : it.tag === "Moved" ? UPCOMING : INK },
          ]
        : [{ value: "", color: MUTED, muted: true }, { value: it.amount, color: MUTED, muted: true }];
    const sub = it.paid != null ? it.detail : [it.detail, it.status !== "Pending" ? it.status : ""].filter(Boolean).join(" · ");
    row(it.date, it.title, sub, cols, itemHeader);
  }
  y -= 10;

  if (v.generalCreditNote) {
    ensure(22);
    const lines = wrap(v.generalCreditNote, W - 12, regular, S.meta);
    lines.forEach((l, i) => text(l, M + 6, y - 10 - i * 9.4, S.meta, regular, MUTED));
    y -= lines.length * 9.4 + 10;
  }

  if (v.payments.length > 0) {
    ensure(16 + 15 + 24);
    // Direction-aware heading & per-row label — never "Payments received" when a row is money paid OUT.
    const allInbound = v.payments.every((p: MonthlyPayment) => p.inbound && !p.advance);
    const anyAdvance = v.payments.some((p: MonthlyPayment) => p.advance);
    const sectionTitle = allInbound ? "Payments received" : anyAdvance && v.payments.every((p) => p.advance) ? "Advance" : "Payments";
    heading(sectionTitle, `${v.payments.length} ${v.payments.length === 1 ? "entry" : "entries"}`);
    const payHeader = () => header(["Date", "Description", "", "Amount"]);
    payHeader();
    for (const p of v.payments) {
      const src = p.source ? tidyAccount(p.source) : "";
      const directionLabel = p.status === "Advance" ? (p.inbound ? `Advance received from ${first}` : `Advance paid to ${first}`) : p.status === "Received" ? `Received from ${first}` : `Paid to ${first}`;
      const pc = p.status === "Received" ? PAID : p.status === "Paid" ? RED : ADVANCE;
      const sign = p.status === "Paid" ? (textCustom ? "−" : "-") : "+";
      const detail = [src, p.note].filter(Boolean).join(" · ");
      // cols are left-to-right like the header: an empty blank-label column, then the amount under "Amount".
      row(p.date, directionLabel, detail, [{ value: "", color: pc }, { value: `${sign}${p.amount}`, color: pc }], payHeader);
    }
  }
  y -= 4;

  // ---- Settlement summary: a plain equation, ending in one boxed total ----
  {
    const line = (k: MonthlySummaryLine["key"]) => v.lines.find((l) => l.key === k);
    const rows = v.lines.filter((l) => l.key !== "outstanding");
    const TW = 232;
    const x0 = RIGHT - TW;
    const h = rows.length * 15 + 32;
    ensure(h + 6);
    const top = y;
    // Accurate, not a blanket claim: an item's own Paid/Remaining above IS tracked by the engine when it shows
    // one; this note only covers the case a figure alone can't — a general payment applied to the whole balance.
    const noteLines = wrap("Paid and Remaining reflect each item's own tracked status. A general payment affects the overall balance, not a single item.", x0 - M - 16, regular, S.meta);
    noteLines.forEach((t, i) => text(t, M, top - 11 - i * 9.4, S.meta, regular, MUTED));
    let ry = top;
    rows.forEach((r) => {
      const opSign = r.op === "+" ? "+  " : r.op === "−" ? (textCustom ? "−  " : "-  ") : "";
      text(`${opSign}${r.label}`, x0, ry - 11, 8.8, regular, BODY);
      amount(r.value, RIGHT, ry - 11, 9, monoRegular, INK, 90);
      ry -= 15;
    });
    hline(x0, RIGHT, ry - 4, RULE_STRONG, 0.7);
    text(settled ? "All settled" : "Balance to pay", x0, ry - 19, 9.6, bold, INK);
    amount(line("outstanding")?.value ?? v.closing.value, RIGHT, ry - 19, 11, monoBold, settled ? PAID : NAVY, 100);
    y = ry - 34;
  }
  if (v.advance) {
    ensure(22);
    text(`${v.advance.label}: ${v.advance.value} — held apart, not part of the balance above.`, M, y - 8, S.meta, regular, MUTED);
    y -= 14;
  }

  // ---- Footer (every page): one hairline, minimal text ----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    hline(M, RIGHT, FOOTER_H, RULE, 0.5);
    text(fit(`${v.ownerName}  ·  ${v.cycleLabel}`, regular, S.meta, W - 90), M, FOOTER_H - 13, S.meta, regular, MUTED);
    textRight(`Page ${i + 1} of ${pages.length}`, RIGHT, FOOTER_H - 13, S.meta, semi, MUTED);
    text(`Generated ${generated} · FlowFi`, M, FOOTER_H - 24, 6.6, regular, FAINT);
  });
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj([pages[0].ref, PDFName.of("FitH"), PDFNull]));
  return doc.save();
}
