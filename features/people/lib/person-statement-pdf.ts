/**
 * Landscape A4 People Ledger statement. Rendered solely from `statementPdfModel`: every
 * amount, balance, label and direction comes from the statement engine; nothing here does arithmetic on
 * money (the only numbers computed are layout coordinates).
 *
 * Colour always supports a word: each row states its Type and Status, and the position names its
 * direction ("They owe you" / "You owe them") so it remains clear in low colour or print.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { PersonCycleStatement, StatementCategory } from "@/lib/engines/person-cycle-statement";
import { statementPdfModel, type StatementPdfRow } from "@/lib/engines/person-cycle-statement-share";

export function pdfSafe(text: string): string {
  return text.replace(/₹/g, "Rs. ").replace(/−/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

// ---- Palette: the People Ledger semantic families, as PDF-safe solid colours (no transparency) ----
const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.36, 0.4, 0.46);
const RULE = rgb(0.74, 0.75, 0.77);
const RULE_STRONG = rgb(0.46, 0.48, 0.52);
const SURFACE = rgb(0.985, 0.98, 0.965);
const BAND_FILL = rgb(0.94, 0.945, 0.94);
const BALANCE_FILL = rgb(0.965, 0.972, 0.965);
const LIME = rgb(0.68, 0.84, 0.16);

interface Family {
  fill: RGB;
  accent: RGB;
  text: RGB;
  label: string;
}
/** Solid surfaces chosen to stay clearly off-white on screen AND in print (the violet especially). */
const FAMILY = {
  // One colour per status, by what the money is doing:
  //   They owe you  = BLUE   — money expected to come in (pending receivable)
  //   You owe them  = VIOLET — debt you hold
  //   Received back = GREEN  — money came in, done
  //   Paid back     = TEAL   — your debt reduced, done (completed like green, clearly a different hue)
  //   EMI           = AMBER  — scheduled installment
  receivable: { fill: rgb(0.89, 0.96, 0.93), accent: rgb(0.04, 0.48, 0.37), text: rgb(0.02, 0.32, 0.24), label: "They owe you" },
  debt: { fill: rgb(0.89, 0.85, 0.98), accent: rgb(0.47, 0.26, 0.8), text: rgb(0.33, 0.16, 0.6), label: "You owe them" },
  receivedBack: { fill: rgb(0.86, 0.95, 0.86), accent: rgb(0.13, 0.55, 0.24), text: rgb(0.07, 0.38, 0.15), label: "Received back" },
  paidBack: { fill: rgb(0.83, 0.94, 0.94), accent: rgb(0.05, 0.5, 0.52), text: rgb(0.02, 0.35, 0.37), label: "Paid back" },
  emi: { fill: rgb(0.995, 0.93, 0.8), accent: rgb(0.8, 0.5, 0.04), text: rgb(0.5, 0.3, 0.02), label: "EMI" },
  neutral: { fill: rgb(1, 1, 1), accent: RULE, text: INK, label: "" },
} satisfies Record<string, Family>;

/**
 * Row family from the authoritative statement category (never from the description). Split / EMI / Loan /
 * adjustment rows carry no direction in their category, so theirs comes from the engine row's own
 * `signedAmount` (FlowFi sign: + they owe me) — the stored direction, not a display sign.
 */
function familyOf(row: StatementPdfRow, signed: number | null): Family {
  const theyOwe = signed != null && signed > 0;
  const iOwe = signed != null && signed < 0;
  switch (row.category as StatementCategory | undefined) {
    case "borrowed":
      return FAMILY.debt;
    case "gave":
      return FAMILY.receivable;
    case "received":
      return FAMILY.receivedBack;
    case "repaid":
      return FAMILY.paidBack;
    case "emi":
    case "split":
    case "loan":
    case "adjustment":
      return iOwe ? FAMILY.debt : theyOwe ? FAMILY.receivable : FAMILY.neutral;
    default:
      return FAMILY.neutral;
  }
}

// ---- Page geometry (A4 landscape, 34pt margins → 773.9pt usable) ----
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const M = 34;
const TABLE_W = PAGE_W - 2 * M;
const COLS = [
  { w: 30, align: "right" }, // No.
  { w: 64, align: "left" }, // Date
  { w: 250, align: "left" }, // Description
  { w: 96, align: "left" }, // Type
  { w: 78, align: "right" }, // Added
  { w: 78, align: "right" }, // Settled
  { w: 88, align: "right" }, // Balance
  { w: 0, align: "left" }, // Status — takes the rest
] as const;
const COL_W = COLS.map((c, i) => (i === COLS.length - 1 ? TABLE_W - COLS.slice(0, -1).reduce((s, x) => s + x.w, 0) : c.w));
const FOOTER_H = 40;
const PAD = 6;

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = pdfSafe(text);
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = `${t.slice(0, -4)}...`;
  return t;
}

function wrap(text: string, font: PDFFont, size: number, width: number, maxLines = 2): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of pdfSafe(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) out.push(line);
      line = fit(word, font, size, width);
    }
  }
  if (line) out.push(line);
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ${out.slice(maxLines).join(" ")}`, font, size, width);
    return kept;
  }
  return out;
}

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });
const GENERATED = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export async function renderPersonStatementPdf(statement: PersonCycleStatement): Promise<Uint8Array> {
  const model = statementPdfModel(statement);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${model.personName} - People Statement - ${model.cycleLabel}`));
  doc.setProducer("FlowFi");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Position: you owe them = violet, they owe you = blue, settled = green (done).
  const position = statement.direction === "iOwe" ? FAMILY.debt : statement.direction === "settled" ? FAMILY.receivedBack : FAMILY.receivable;

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;

  const text = (s: string, x: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    page.drawText(pdfSafe(s), { x, y: yy, size, font, color });
  const textRight = (s: string, right: number, yy: number, size: number, font: PDFFont = regular, color: RGB = INK) =>
    text(s, right - font.widthOfTextAtSize(pdfSafe(s), size), yy, size, font, color);
  const box = (x: number, yy: number, w: number, h: number, fill: RGB, border?: RGB, borderWidth = 0.6) =>
    page.drawRectangle({ x, y: yy, width: w, height: h, color: fill, ...(border ? { borderColor: border, borderWidth } : {}) });
  const vline = (x: number, top: number, bottom: number, color = RULE, thickness = 0.5) =>
    page.drawLine({ start: { x, y: bottom }, end: { x, y: top }, thickness, color });
  const hline = (top: number, color = RULE, thickness = 0.5) => page.drawLine({ start: { x: M, y: top }, end: { x: M + TABLE_W, y: top }, thickness, color });

  // ---------------- Statement header (first page) ----------------
  const drawStatementHeader = () => {
    // A quiet statement masthead: branding is an accent, not an ink-heavy banner.
    box(M, y - 3, TABLE_W, 3, LIME);
    text("FLOWFI", M, y - 18, 9, bold, INK);
    text("People Statement", M, y - 36, 14.5, bold, INK);
    text(`Generated ${GENERATED.format(new Date())}`, M, y - 49, 6.8, regular, MUTED);
    textRight(fit(model.personName, bold, 15.5, 300), M + TABLE_W, y - 19, 15.5, bold, INK);
    textRight(model.cycleLabel, M + TABLE_W, y - 35, 7.8, regular, MUTED);
    textRight("Current cycle", M + TABLE_W, y - 47, 6.7, regular, MUTED);
    y -= 59;

    // Hero: the reader's answer is intentionally stronger than every supporting figure.
    const heroH = 60;
    box(M, y - heroH, TABLE_W, heroH, position.fill, position.accent, 0.8);
    box(M, y - heroH, 5, heroH, position.accent);
    text("CURRENT POSITION", M + 15, y - 14, 6.8, bold, position.text);
    text(model.positionHeadline, M + 15, y - 29, 10.5, bold, position.text);
    text(model.positionAmount, M + 15, y - 50, 20, bold, position.text);
    textRight(`As of ${model.closingRow.date}`, M + TABLE_W - 12, y - 47, 7.2, regular, position.text);
    y -= heroH + 8;

    // The reconciliation remains easy to scan, while clearly subordinate to the position.
    const items = model.summary.filter((item) => item.label !== "Current Pending");
    const stripH = 30;
    const cellW = TABLE_W / Math.max(items.length, 1);
    box(M, y - stripH, TABLE_W, stripH, SURFACE, RULE, 0.6);
    items.forEach((item, i) => {
      const x = M + i * cellW;
      if (i > 0) vline(x, y - 5, y - stripH + 5, RULE, 0.45);
      text(fit(item.label.toUpperCase(), bold, 6.1, cellW - 2 * PAD), x + PAD + 2, y - 11, 6.1, bold, MUTED);
      text(item.value, x + PAD + 2, y - 24, 9.2, regular, INK);
    });
    y -= stripH + 13;
  };

  // ---------------- Table header (repeated on every page) ----------------
  const drawTableHeader = (continued: boolean) => {
    if (continued) {
      text(fit(`${model.personName}  -  People Statement  -  ${model.cycleLabel}`, bold, 8.5, TABLE_W - 80), M, y - 10, 8.5, bold, INK);
      textRight("continued", M + TABLE_W, y - 10, 7.5, regular, MUTED);
      y -= 18;
    }
    const h = 17;
    box(M, y - h, TABLE_W, h, BAND_FILL);
    let x = M;
    model.columns.forEach((label, i) => {
      const w = COL_W[i]!;
      const v = label.toUpperCase();
      if (COLS[i]!.align === "right") textRight(v, x + w - PAD, y - 11.5, 6.2, bold, MUTED);
      else text(v, x + PAD, y - 11.5, 6.2, bold, MUTED);
      if (i > 0) vline(x, y - 3, y - h + 3, RULE, 0.35);
      x += w;
    });
    y -= h;
  };

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M;
    drawTableHeader(true);
  };
  const ensure = (h: number) => {
    // Rows are never split across pages: move the whole row (with the repeated header) instead.
    if (y - h < M + FOOTER_H) newPage();
  };

  // ---------------- Rows ----------------
  const drawGroupLabel = (label: string) => {
    const h = 16;
    ensure(h + 25);
    text(label, M, y - 10, 7.5, bold, INK);
    page.drawLine({ start: { x: M + 82, y: y - 7 }, end: { x: M + TABLE_W, y: y - 7 }, thickness: 0.6, color: RULE });
    y -= h;
  };

  const drawRow = (row: StatementPdfRow, no: string, variant: "row" | "opening" | "closing" = "row", signed: number | null = null) => {
    const strong = variant !== "row";
    const fam = strong ? FAMILY.neutral : familyOf(row, signed);
    const descW = COL_W[2]! - 2 * PAD;
    const lines = wrap(row.description, bold, 7.8, descW);
    const detail = row.detail ? fit(row.detail, regular, 6.3, descW) : "";
    const h = Math.max(22, 8 + lines.length * 9 + (detail ? 7.5 : 0) + 3);
    ensure(h);
    const top = y;
    const bottom = y - h;
    const fill = strong ? BAND_FILL : rgb(1, 1, 1);

    // Information leads: a narrow semantic rail and a restrained tint replace coloured spreadsheet rows.
    box(M, bottom, TABLE_W, h, fill);
    if (!strong && fam !== FAMILY.neutral) box(M + 3, bottom, TABLE_W - 3, h, fam.fill);
    const balX = M + COL_W.slice(0, 6).reduce((s, w) => s + w, 0);
    box(balX, bottom, COL_W[6]!, h, strong ? BAND_FILL : BALANCE_FILL);
    box(M, bottom, 3, h, strong ? RULE_STRONG : fam.accent);
    hline(bottom, strong ? RULE_STRONG : RULE, strong ? 0.8 : 0.5);
    vline(M + TABLE_W, top, bottom, RULE, 0.35);

    const mid = top - h / 2 - 3;
    let x = M;
    COL_W.forEach((w, i) => {
      if (i > 0) vline(x, top - 4, bottom + 4, RULE, 0.3);
      const right = x + w - PAD;
      switch (i) {
        case 0:
          textRight(no, right, mid, 7.4, regular, MUTED);
          break;
        case 1:
          text(fit(row.date, strong ? bold : regular, 8, w - 2 * PAD), x + PAD, mid, 8, strong ? bold : regular, INK);
          break;
        case 2: {
          let ty = top - 12;
          for (const line of lines) {
            text(line, x + PAD, ty, 7.8, bold, INK);
            ty -= 9;
          }
          if (detail) text(detail, x + PAD, ty + 1, 6.3, regular, MUTED);
          break;
        }
        case 3: {
          if (!row.type) break;
          const label = fit(row.type, bold, 7, w - 2 * PAD - 8);
          const bw = bold.widthOfTextAtSize(label, 7) + 8;
          const isEmi = row.isEmi;
          const badge = isEmi ? FAMILY.emi : fam === FAMILY.neutral ? null : fam;
          if (badge) box(x + PAD, mid - 3.5, bw, 12, badge.fill, badge.accent, 0.55);
          text(label, x + PAD + 4, mid, 7, bold, badge ? badge.text : MUTED);
          break;
        }
        case 4:
          if (row.added) textRight(row.added, right, mid, 7.6, regular, strong ? INK : fam === FAMILY.neutral ? INK : fam.text);
          break;
        case 5:
          if (row.settled) textRight(row.settled, right, mid, 7.6, regular, strong ? INK : fam === FAMILY.neutral ? INK : fam.text);
          break;
        case 6:
          textRight(row.balance, right, mid, strong ? 8.5 : 7.9, bold, INK);
          break;
        case 7:
          if (row.status) text(fit(row.status, bold, 7.4, w - 2 * PAD), x + PAD, mid, 7.4, bold, fam === FAMILY.neutral ? MUTED : fam.text);
          break;
      }
      x += w;
    });
    y = bottom;
  };

  // ---------------- Compose ----------------
  drawStatementHeader();
  text("ACTIVITY", M, y - 2, 8.7, bold, INK);
  textRight(`${model.rows.length} ${model.rows.length === 1 ? "transaction" : "transactions"}`, M + TABLE_W, y - 2, 7.2, regular, MUTED);
  y -= 8;
  drawTableHeader(false);
  drawRow(model.openingRow, "", "opening");

  if (model.rows.length === 0) {
    drawRow({ date: "", description: "No activity in this cycle", type: "", isEmi: false, added: "", settled: "", balance: "" }, "--");
  } else {
    // Month labels only when the cycle's rows span more than one calendar month (dates from the engine rows).
    const months = statement.rows.map((r) => MONTH.format(r.date));
    const grouped = new Set(months).size > 1;
    model.rows.forEach((row, i) => {
      if (grouped && months[i] !== months[i - 1]) drawGroupLabel(months[i]!);
      drawRow(row, String(i + 1).padStart(2, "0"), "row", statement.rows[i]?.signedAmount ?? null);
    });
  }
  // Ending position is deliberately outside the transaction table: it is a conclusion, not activity.
  const endH = 42;
  ensure(endH + 12);
  y -= 12;
  box(M, y - endH, TABLE_W, endH, position.fill, position.accent, 0.7);
  box(M, y - endH, 4, endH, position.accent);
  text("ENDING POSITION", M + 12, y - 13, 6.6, bold, position.text);
  text(model.closingRow.date, M + 12, y - 25, 6.8, regular, position.text);
  text(model.positionHeadline, M + 160, y - 18, 8.5, bold, position.text);
  textRight(model.positionAmount, M + TABLE_W - 12, y - 24, 13.5, bold, position.text);
  y -= endH;

  // ---------------- Final reconciliation (engine lines only, as a ledger block) ----------------
  const recH = 24 + model.summary.length * 14 + 22;
  if (y - recH - 14 < M + FOOTER_H) newPage();
  y -= 14;
  const recW = 382;
  const rx = M + TABLE_W - recW;
  text("STATEMENT SUMMARY", M, y - 10, 9, bold, INK);
  text("Cycle reconciliation", M, y - 22, 7.4, regular, MUTED);
  box(rx, y - recH, recW, recH, rgb(1, 1, 1), RULE);
  let ry = y - 16;
  model.summary.forEach((item, i) => {
    const last = i === model.summary.length - 1;
    if (last) {
      page.drawLine({ start: { x: rx + PAD, y: ry + 8 }, end: { x: rx + recW - PAD, y: ry + 8 }, thickness: 0.8, color: RULE_STRONG });
      ry -= 3;
    }
    text(item.label, rx + PAD + 4, ry, last ? 9 : 8.2, last ? bold : regular, last ? INK : MUTED);
    textRight(item.value, rx + recW - PAD - 4, ry, last ? 10 : 8.4, last ? bold : regular, INK);
    ry -= 14;
  });
  box(rx, ry - 8, recW, 20, position.fill, position.accent, 0.9);
  text(model.positionHeadline.toUpperCase(), rx + PAD + 4, ry - 1.5, 8.1, bold, position.text);
  textRight(model.positionAmount, rx + recW - PAD - 4, ry - 1.5, 10, bold, position.text);

  // ---------------- Footer ----------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 30 }, end: { x: M + TABLE_W, y: 30 }, thickness: 0.5, color: RULE });
    p.drawText(pdfSafe(`FlowFi  |  ${model.personName}  |  ${model.cycleLabel}`), { x: M, y: 18, size: 7.2, font: regular, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: M + TABLE_W - regular.widthOfTextAtSize(label, 7.2), y: 18, size: 7.2, font: regular, color: MUTED });
  });
  return doc.save();
}
