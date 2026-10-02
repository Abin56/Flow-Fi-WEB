/**
 * Landscape A4 People settlement statement — the PDF twin of the Person workspace's settlement table.
 * Rendered solely from `statementView`: every amount, label, type and status comes from the statement
 * engine through the shared presentation layer; nothing here does arithmetic on money (the only numbers
 * computed are layout coordinates).
 *
 * Colour always supports a word: each row names its type and status, and the position names its
 * direction ("Amma owes you" / "You owe Amma"), so it stays clear in greyscale print.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { statementView, type StatementViewOptions, type StatementViewRow } from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementStatusTone, SettlementTone } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";

export function pdfSafe(text: string): string {
  return text.replace(/₹/g, "Rs. ").replace(/−/g, "-").replace(/[–—]/g, "-").replace(/→/g, "->").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

// ---- Palette: the settlement families as PDF-safe solid colours (no transparency) ----
const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.33, 0.36, 0.42);
const RULE = rgb(0.74, 0.75, 0.77);
const RULE_STRONG = rgb(0.46, 0.48, 0.52);
const HEAD_FILL = rgb(0.92, 0.925, 0.92);
const WHITE = rgb(1, 1, 1);
const LIME = rgb(0.73, 0.96, 0.35);
// The brand band (FlowFi near-black) and the colours that read on it.
const BAND = rgb(0.09, 0.094, 0.09);
const ON_DARK_MUTED = rgb(0.68, 0.7, 0.68);
const ON_DARK_RULE = rgb(0.3, 0.31, 0.3);
const ON_DARK_RECEIVABLE = rgb(0.45, 0.88, 0.58);
const ON_DARK_PAYABLE = rgb(1, 0.56, 0.52);

interface Family {
  fill: RGB;
  accent: RGB;
  text: RGB;
}
const F = {
  receivable: { fill: rgb(0.89, 0.965, 0.915), accent: rgb(0.1, 0.55, 0.3), text: rgb(0.04, 0.37, 0.19) },
  payable: { fill: rgb(0.985, 0.905, 0.895), accent: rgb(0.8, 0.2, 0.17), text: rgb(0.6, 0.1, 0.08) },
  emi: { fill: rgb(1, 0.935, 0.81), accent: rgb(0.86, 0.55, 0.05), text: rgb(0.5, 0.3, 0.02) },
  loan: { fill: rgb(0.915, 0.915, 0.99), accent: rgb(0.35, 0.35, 0.8), text: rgb(0.22, 0.22, 0.6) },
  split: { fill: rgb(0.895, 0.935, 0.99), accent: rgb(0.15, 0.45, 0.85), text: rgb(0.07, 0.3, 0.62) },
  assigned: { fill: rgb(0.975, 0.905, 0.965), accent: rgb(0.69, 0.2, 0.6), text: rgb(0.5, 0.11, 0.42) },
  advance: { fill: rgb(0.875, 0.96, 0.95), accent: rgb(0.05, 0.56, 0.53), text: rgb(0.02, 0.37, 0.36) },
  carried: { fill: rgb(0.925, 0.935, 0.95), accent: rgb(0.36, 0.41, 0.48), text: rgb(0.2, 0.24, 0.31) },
} satisfies Record<string, Family>;

const TONE_FAMILY: Record<SettlementTone, Family> = {
  receivable: F.receivable,
  payable: F.payable,
  emi: F.emi,
  loan: F.loan,
  split: F.split,
  assigned: F.assigned,
  received: F.receivable,
  paid: F.carried,
  advance: F.advance,
  neutral: F.carried,
};

/** Status pill: fill, text colour. Settled and overdue are solid so they read at a glance. */
const STATUS: Record<SettlementStatusTone, { fill: RGB; text: RGB }> = {
  due: { fill: F.receivable.fill, text: F.receivable.text },
  payable: { fill: F.payable.fill, text: F.payable.text },
  partial: { fill: rgb(0.99, 0.86, 0.6), text: rgb(0.45, 0.26, 0.01) },
  settled: { fill: F.receivable.accent, text: WHITE },
  overdue: { fill: F.payable.accent, text: WHITE },
  upcoming: { fill: F.carried.fill, text: F.carried.text },
  received: { fill: F.receivable.fill, text: F.receivable.text },
  paid: { fill: F.carried.fill, text: F.carried.text },
  neutral: { fill: F.carried.fill, text: F.carried.text },
};

// ---- Page geometry (A4 landscape, 34pt margins → 773.9pt usable) ----
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const M = 34;
const TABLE_W = PAGE_W - 2 * M;
const COLUMNS = [
  { label: "No.", w: 24, align: "right" },
  { label: "Date", w: 58, align: "left" },
  { label: "What", w: 232, align: "left" },
  { label: "Type", w: 90, align: "left" },
  { label: "Original", w: 70, align: "right" },
  { label: "Paid", w: 70, align: "right" },
  { label: "Remaining", w: 76, align: "right" },
  { label: "Status", w: 0, align: "left" },
] as const;
const COL_W = COLUMNS.map((c, i) => (i === COLUMNS.length - 1 ? TABLE_W - COLUMNS.slice(0, -1).reduce((s, x) => s + x.w, 0) : c.w));
const FOOTER_H = 40;
const PAD = 5;

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = pdfSafe(text);
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = `${t.slice(0, -4)}...`;
  return t;
}

const GENERATED = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/**
 * Renders the statement. `options` (the person's ledger entries, the whole-history statement and
 * account names) only sharpen the wording — assigned vs split, payments made in a later cycle, the
 * account a payment moved through — and never change a figure.
 */
export async function renderPersonStatementPdf(statement: PersonCycleStatement, options: StatementViewOptions = {}): Promise<Uint8Array> {
  const view = statementView(statement, options);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${view.personName} - People Statement - ${view.cycleLabel}`));
  doc.setProducer("FlowFi");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const position = view.direction === "iOwe" ? F.payable : F.receivable;

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;

  const text = (s: string, x: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    page.drawText(pdfSafe(s), { x, y: yy, size, font, color });
  const textRight = (s: string, right: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    text(s, right - font.widthOfTextAtSize(pdfSafe(s), size), yy, size, font, color);
  const box = (x: number, yy: number, w: number, h: number, fill: RGB, border?: RGB, borderWidth = 0.6) =>
    page.drawRectangle({ x, y: yy, width: w, height: h, color: fill, ...(border ? { borderColor: border, borderWidth } : {}) });
  const vline = (x: number, top: number, bottom: number, color = RULE, thickness = 0.4) =>
    page.drawLine({ start: { x, y: bottom }, end: { x, y: top }, thickness, color });
  const hline = (x0: number, x1: number, yy: number, color = RULE, thickness = 0.5) => page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness, color });
  const pill = (label: string, x: number, yy: number, fill: RGB, color: RGB, size = 6.2, border: RGB | undefined = color) => {
    const t = pdfSafe(label);
    const w = bold.widthOfTextAtSize(t, size) + 7;
    box(x, yy - 3, w, size + 5, fill, border, 0.5);
    text(t, x + 3.5, yy, size, bold, color);
    return w;
  };

  // ---------------- Brand band + reconciliation strip (first page) ----------------
  const drawHeader = () => {
    // ---- Brand band: who, which cycle, and the answer — one compact dark strip ----
    const bandH = 66;
    const settled = view.direction === "settled";
    const answer = view.direction === "iOwe" ? ON_DARK_PAYABLE : ON_DARK_RECEIVABLE;
    box(M, y - bandH, TABLE_W, bandH, BAND);
    box(M, y - 2.5, TABLE_W, 2.5, LIME);
    text("FLOWFI", M + 16, y - 19, 7.2, bold, LIME);
    text("People Settlement Statement", M + 16, y - 35, 13, bold, WHITE);
    text(fit(`${view.personName}  |  ${view.cycleLabel}`, regular, 8, 330), M + 16, y - 49, 8, regular, ON_DARK_MUTED);
    text(`Generated ${GENERATED.format(new Date())}`, M + 16, y - 59, 6.2, regular, ON_DARK_MUTED);

    const right = M + TABLE_W - 18;
    const divider = M + TABLE_W - 250;
    page.drawLine({ start: { x: divider, y: y - 14 }, end: { x: divider, y: y - bandH + 12 }, thickness: 0.6, color: ON_DARK_RULE });
    textRight(settled ? "ALL SETTLED" : view.headline.toUpperCase(), right, y - 21, 8, bold, answer);
    textRight(view.amount, right, y - 47, 24, bold, settled ? WHITE : answer);
    textRight(settled ? "Nothing pending this cycle" : "Current pending", right, y - 58, 6.2, regular, ON_DARK_MUTED);
    y -= bandH + 7;

    // ---- Reconciliation strip: the cycle's math on one line ----
    // Operators appear only when every non-zero figure is on the same side (otherwise "+" would mislead);
    // each figure also names its side in words.
    const main = view.reconciliation;
    const sides = new Set(main.filter((l) => l.side).map((l) => l.side));
    const ops = sides.size <= 1;
    const cells = [
      ...main.map((l) => ({
        label: l.label,
        value: l.value,
        side: l.side,
        op: !ops ? "" : l.label === "Added this cycle" ? "+" : l.label === "Total due" ? "=" : l.label === "Previous pending" ? "" : "-",
        strong: l.strong === true,
        tone: l.tone,
        current: false,
      })),
      { label: view.current.label, value: view.current.value, side: null, op: ops ? "=" : "", strong: true, tone: undefined, current: true },
    ];
    const advW = view.advance ? 150 : 0;
    const stripH = 34;
    const cellW = (TABLE_W - advW - (view.advance ? 6 : 0)) / cells.length;
    box(M, y - stripH, TABLE_W - advW - (view.advance ? 6 : 0), stripH, WHITE, RULE, 0.6);
    const toneColor = (t?: string) => (t === "receivable" ? F.receivable.text : t === "payable" ? F.payable.text : t === "advance" ? F.advance.text : t === "carried" ? F.carried.text : INK);
    cells.forEach((c, i) => {
      const x = M + i * cellW;
      if (c.current) {
        box(x, y - stripH, cellW, stripH, position.fill);
        box(x, y - stripH, 2.5, stripH, position.accent);
      } else if (i > 0) vline(x, y - 6, y - stripH + 6, RULE, 0.4);
      if (c.op && i > 0) {
        // The operator sits on the boundary, in a small white disc so it reads over the rule.
        page.drawCircle({ x, y: y - stripH / 2, size: 5.2, color: WHITE, borderColor: RULE_STRONG, borderWidth: 0.5 });
        const cy = y - stripH / 2;
        const stroke = (x0: number, y0: number, x1: number, y1: number) => page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 1, color: INK });
        if (c.op === "+") {
          stroke(x - 2.6, cy, x + 2.6, cy);
          stroke(x, cy - 2.6, x, cy + 2.6);
        } else if (c.op === "-") stroke(x - 2.6, cy, x + 2.6, cy);
        else {
          stroke(x - 2.6, cy + 1.3, x + 2.6, cy + 1.3);
          stroke(x - 2.6, cy - 1.3, x + 2.6, cy - 1.3);
        }
      }
      const tx = x + 11;
      text(fit(c.label.toUpperCase(), bold, 5.8, cellW - 16), tx, y - 10, 5.8, bold, c.current ? position.text : MUTED);
      text(c.value, tx, y - 22.5, c.current ? 11 : 9.5, bold, c.current ? (view.direction === "settled" ? INK : position.text) : c.strong ? INK : toneColor(c.tone));
      if (c.side) text(fit(c.side, regular, 5.8, cellW - 16), tx, y - 30, 5.8, regular, MUTED);
    });
    if (view.advance) {
      const ax = M + TABLE_W - advW;
      box(ax, y - stripH, advW, stripH, F.advance.fill, F.advance.accent, 0.6);
      box(ax, y - stripH, 2.5, stripH, F.advance.accent);
      text(fit(view.advance.label.toUpperCase(), bold, 5.8, advW - 16), ax + 10, y - 10, 5.8, bold, F.advance.text);
      text(view.advance.value, ax + 10, y - 22.5, 11, bold, F.advance.text);
      text(fit("Held apart - not in pending", regular, 5.8, advW - 16), ax + 10, y - 30, 5.8, regular, F.advance.text);
    }
    y -= stripH;
    if (view.cashNote) {
      textRight(fit(view.cashNote, regular, 6.2, TABLE_W), M + TABLE_W, y - 8, 6.2, regular, MUTED);
      y -= 9;
    }
    y -= 14;
  };

  // ---------------- Table header (repeated on every page) ----------------
  const drawTableHeader = (continued: boolean) => {
    if (continued) {
      text(fit(`${view.personName}  -  People Settlement Statement  -  ${view.cycleLabel}`, bold, 8.5, TABLE_W - 80), M, y - 10, 8.5, bold, INK);
      textRight("continued", M + TABLE_W, y - 10, 7.5, regular, MUTED);
      y -= 18;
    }
    const h = 17;
    box(M, y - h, TABLE_W, h, HEAD_FILL, RULE_STRONG, 0.5);
    let x = M;
    COLUMNS.forEach((c, i) => {
      const w = COL_W[i]!;
      const v = c.label.toUpperCase();
      if (c.align === "right") textRight(v, x + w - PAD, y - 11.5, 6.2, bold, MUTED);
      else text(v, x + PAD, y - 11.5, 6.2, bold, MUTED);
      if (i > 0) vline(x, y, y - h, RULE, 0.4);
      x += w;
    });
    y -= h;
  };

  const newPage = (withTableHeader: boolean) => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M;
    if (withTableHeader) drawTableHeader(true);
  };
  const ensure = (h: number, withTableHeader = true) => {
    // Rows are never split across pages: move the whole row (with the repeated header) instead.
    if (y - h < M + FOOTER_H) newPage(withTableHeader);
  };

  // ---------------- Rows ----------------
  const drawRow = (row: StatementViewRow) => {
    const fam = row.carried ? F.carried : TONE_FAMILY[row.tone];
    const typeFam = TONE_FAMILY[row.tone];
    // A split share carries a third line (original expense · split count · their share).
    const h = row.splitNote ? 34 : 27;
    ensure(h);
    const top = y;
    const bottom = y - h;
    // Subtle full-row tint in the row's family + a strong leading edge; figures stay on white-ish tint.
    box(M, bottom, TABLE_W, h, fam.fill);
    box(M, bottom, 3.5, h, fam.accent);
    hline(M, M + TABLE_W, bottom, RULE, 0.5);
    vline(M, top, bottom, RULE, 0.4);
    vline(M + TABLE_W, top, bottom, RULE, 0.4);

    const mid = top - h / 2 - 2.5;
    let x = M;
    COL_W.forEach((w, i) => {
      if (i > 0) vline(x, top, bottom, RULE, 0.35);
      const right = x + w - PAD;
      switch (i) {
        case 0:
          textRight(row.no, right, mid, 7, regular, MUTED);
          break;
        case 1:
          text(row.date, x + PAD, mid, 7.4, bold, INK);
          break;
        case 2:
          text(fit(row.title, bold, 8, w - 2 * PAD), x + PAD, top - 11, 8, bold, INK);
          text(fit(row.carried && row.fromCycle ? `From ${row.fromCycle}  |  ${row.relation}` : row.relation, regular, 6.4, w - 2 * PAD), x + PAD, top - 21, 6.4, regular, MUTED);
          if (row.splitNote) {
            // "Total price ₹X" in bold, the rest of the split line regular.
            const cut = row.splitNote.indexOf(" · ");
            const head = cut < 0 ? row.splitNote : row.splitNote.slice(0, cut);
            const headW = bold.widthOfTextAtSize(pdfSafe(head), 6.4);
            text(head, x + PAD, top - 29, 6.4, bold, INK);
            if (cut >= 0) text(fit(row.splitNote.slice(cut), regular, 6.2, w - 2 * PAD - headW), x + PAD + headW, top - 29, 6.2, regular, MUTED);
          }
          break;
        case 3:
          pill(fit(row.typeLabel, bold, 6.3, w - 2 * PAD - 8), x + PAD, row.carried ? mid + 4 : mid, WHITE, typeFam.text, 6.3, typeFam.accent);
          if (row.carried) text("BROUGHT FORWARD", x + PAD, mid - 8, 5.6, bold, F.carried.text);
          break;
        case 4:
          if (row.original) textRight(row.original, right, mid, 7.6, regular, INK);
          else textRight("-", right, mid, 7.6, regular, MUTED);
          break;
        case 5:
          if (row.paid) textRight(row.paid, right, mid, 7.6, regular, row.paid === money(0) ? MUTED : F.receivable.text);
          else textRight("-", right, mid, 7.6, regular, MUTED);
          break;
        case 6:
          if (row.remaining) {
            const done = row.statusTone === "settled";
            const tone = done ? F.receivable.text : row.statusTone === "overdue" ? F.payable.accent : typeFam === F.payable ? F.payable.text : INK;
            textRight(row.remaining, right, mid, 8.2, bold, tone);
          } else textRight("-", right, mid, 7.6, regular, MUTED);
          break;
        case 7: {
          const st = STATUS[row.statusTone];
          pill(fit(row.status.toUpperCase(), bold, 6.2, w - 2 * PAD), x + PAD, top - 11, st.fill, st.text, 6.2);
          if (row.statusDetail) text(fit(row.statusDetail, regular, 6.3, w - 2 * PAD), x + PAD, top - 22, 6.3, regular, MUTED);
          break;
        }
      }
      x += w;
    });
    y = bottom;
  };

  // ---------------- Compose ----------------
  drawHeader();
  text("TRANSACTIONS", M, y - 2, 8.7, bold, INK);
  textRight(
    `${view.carried.length + view.rows.length} ${view.carried.length + view.rows.length === 1 ? "item" : "items"}  |  Paid and remaining as of ${view.asOf}`,
    M + TABLE_W,
    y - 2,
    7,
    regular,
    MUTED,
  );
  y -= 8;
  drawTableHeader(false);
  const groupBand = (label: string, fill: RGB, color: RGB) => {
    ensure(14 + 27);
    box(M, y - 14, TABLE_W, 14, fill, RULE, 0.4);
    text(label, M + PAD + 2, y - 10, 6.4, bold, color);
    y -= 14;
  };
  if (view.carried.length > 0) {
    groupBand("BROUGHT FORWARD  -  STILL OPEN FROM EARLIER CYCLES", F.carried.fill, F.carried.text);
    view.carried.forEach(drawRow);
    groupBand("THIS CYCLE", HEAD_FILL, MUTED);
  }
  if (view.rows.length === 0) {
    ensure(24);
    box(M, y - 24, TABLE_W, 24, WHITE, RULE, 0.5);
    text(`No activity with ${view.personName.split(" ")[0]} in this cycle.`, M + 32, y - 15, 8, regular, MUTED);
    y -= 24;
  } else {
    view.rows.forEach(drawRow);
  }

  // ---------------- Payment history (grouped by real payment) ----------------
  if (view.payments.length > 0) {
    ensure(50, false);
    y -= 18;
    text("PAYMENT HISTORY  |  THIS CYCLE", M, y, 8.7, bold, INK);
    y -= 8;
    const histW = 470;
    for (const p of view.payments) {
      const h = p.single != null ? 24 : 18 + p.applied.length * 10 + 16 + (p.held ? 13 : 0);
      ensure(h + 2, false);
      const fam = p.advance ? F.advance : p.inbound ? F.receivable : F.carried;
      box(M, y - h, histW, h, WHITE, RULE, 0.4);
      box(M, y - h, 3, h, fam.accent);
      text(p.date, M + 9, y - 11, 7.4, bold, INK);
      text(fit(`${p.label}${p.account ? `  ->  ${p.account}` : ""}`, bold, 7.4, histW - 170), M + 70, y - 11, 7.4, bold, INK);
      textRight(p.amount, M + histW - 8, y - 11, 8.2, bold, p.inbound ? F.receivable.text : INK);
      if (p.single != null) {
        text(fit(p.single, regular, 6.5, histW - 90), M + 70, y - 20, 6.5, regular, MUTED);
      } else {
        let ly = y - 21;
        text("APPLIED TO", M + 70, ly, 5.8, bold, MUTED);
        ly -= 9;
        for (const a of p.applied) {
          text(fit(`+  ${a.label}`, regular, 6.8, 220), M + 76, ly, 6.8, regular, INK);
          textRight(a.amount, M + 330, ly, 6.8, regular, INK);
          ly -= 10;
        }
        hline(M + 70, M + 330, ly + 7, RULE, 0.5);
        text("Applied", M + 76, ly - 1, 6.8, bold, INK);
        textRight(p.appliedTotal ?? "", M + 330, ly - 1, 6.8, bold, INK);
        if (p.held) {
          ly -= 12;
          box(M + 70, ly - 3, 260, 10, F.advance.fill);
          text("Held as advance", M + 76, ly, 6.8, bold, F.advance.text);
          textRight(p.held, M + 330, ly, 6.8, bold, F.advance.text);
        }
      }
      y -= h + 2;
    }
    const totals = [view.totalReceived && `Total received from ${view.personName.split(" ")[0]}  ${view.totalReceived}`, view.totalPaid && `Total paid to ${view.personName.split(" ")[0]}  ${view.totalPaid}`].filter(Boolean) as string[];
    for (const t of totals) {
      ensure(12, false);
      y -= 10;
      textRight(t, M + histW, y, 7.6, bold, INK);
    }
  }

  // ---------------- Ending position ----------------
  // Repeats the hero as the statement's conclusion — skipped when it would sit alone on a new page of a
  // one-page statement (the hero above already states it).
  const endH = 26;
  const fits = y - (endH + 16) >= M + FOOTER_H;
  if (fits || doc.getPageCount() > 1) {
    ensure(endH + 16, false);
    y -= 16;
    const settled = view.direction === "settled";
    box(M, y - endH, TABLE_W, endH, position.fill, position.accent, 0.7);
    box(M, y - endH, 4, endH, position.accent);
    text("ENDING POSITION", M + 12, y - 16, 6.6, bold, position.text);
    text(`${view.headline.toUpperCase()}  |  ${view.cycleLabel}`, M + 110, y - 16.5, 8, bold, position.text);
    textRight(view.amount, M + TABLE_W - 12, y - 17.5, 12, bold, settled ? INK : position.text);
    y -= endH;
  }

  // ---------------- Footer ----------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 30 }, end: { x: M + TABLE_W, y: 30 }, thickness: 0.5, color: RULE });
    p.drawText(pdfSafe(`FlowFi  |  ${view.personName}  |  ${view.cycleLabel}`), { x: M, y: 18, size: 7.2, font: regular, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: M + TABLE_W - regular.widthOfTextAtSize(label, 7.2), y: 18, size: 7.2, font: regular, color: MUTED });
  });
  return doc.save();
}
