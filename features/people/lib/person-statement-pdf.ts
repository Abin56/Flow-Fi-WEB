/**
 * Landscape A4 account-statement PDF for one Person's cycle — rendered purely from
 * `statementPdfModel(statement)`, so every figure is the engine's. pdf-lib's standard fonts are
 * WinAnsi-only, so "₹" is written as "Rs." and "−" as "-" (see `pdfSafe`).
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { statementPdfModel, type StatementPdfRow } from "@/lib/engines/person-cycle-statement-share";

export function pdfSafe(text: string): string {
  return text.replace(/₹/g, "Rs. ").replace(/−/g, "-").replace(/[^\x20-\x7E -ÿ—–·]/g, "");
}

const INK = rgb(0.07, 0.08, 0.1);
const MUTED = rgb(0.38, 0.4, 0.45);
const RULE = rgb(0.82, 0.83, 0.86);
const BAND = rgb(0.96, 0.96, 0.97);
const LIME = rgb(0.49, 0.62, 0.05);
const EMI_TINT = rgb(0.97, 0.99, 0.9);

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const M = 40;
// Date | Description | Type | Added | Settled | Balance
const FIXED_COLS = [78, 320, 110, 100, 100];
const COL_W = [...FIXED_COLS, PAGE_W - 2 * M - FIXED_COLS.reduce((a, b) => a + b, 0)];
const RIGHT_ALIGNED = [false, false, false, true, true, true];

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = pdfSafe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t}...`;
}

export async function renderPersonStatementPdf(statement: PersonCycleStatement): Promise<Uint8Array> {
  const model = statementPdfModel(statement);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${model.personName} — ${model.subtitle} — ${model.cycleLabel}`));
  doc.setProducer("FlowFi");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;
  const text = (p: PDFPage, s: string, x: number, yy: number, size: number, font = regular, color = INK) =>
    p.drawText(pdfSafe(s), { x, y: yy, size, font, color });

  // Header
  text(page, model.title, M, y - 18, 20, bold);
  page.drawRectangle({ x: M, y: y - 24, width: 28, height: 3, color: LIME });
  text(page, model.subtitle, M, y - 42, 12, bold, MUTED);
  const rightX = PAGE_W - M;
  const name = pdfSafe(model.personName);
  text(page, name, rightX - bold.widthOfTextAtSize(name, 14), y - 18, 14, bold);
  const cyc = pdfSafe(`Cycle: ${model.cycleLabel}`);
  text(page, cyc, rightX - regular.widthOfTextAtSize(cyc, 10), y - 36, 10, regular, MUTED);
  y -= 62;
  page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.8, color: RULE });
  y -= 18;

  // Summary strip + position
  const boxW = (PAGE_W - 2 * M - 220) / model.summary.length;
  model.summary.forEach((item, i) => {
    const x = M + i * boxW;
    const isLast = i === model.summary.length - 1;
    text(page, item.label.toUpperCase(), x, y - 10, 7.5, bold, MUTED);
    text(page, item.value, x, y - 28, isLast ? 14 : 12, isLast ? bold : regular);
  });
  const posX = PAGE_W - M - 200;
  page.drawRectangle({ x: posX, y: y - 40, width: 200, height: 46, borderColor: RULE, borderWidth: 0.8, color: BAND });
  text(page, model.positionHeadline, posX + 12, y - 12, 9, bold, MUTED);
  text(page, model.positionAmount, posX + 12, y - 32, 16, bold);
  y -= 64;

  // Table
  const ROW_H = 20;
  const drawHeader = () => {
    page.drawRectangle({ x: M, y: y - ROW_H + 5, width: PAGE_W - 2 * M, height: ROW_H, color: BAND });
    let x = M;
    model.columns.forEach((c, i) => {
      const w = COL_W[i];
      const label = c.toUpperCase();
      const tx = RIGHT_ALIGNED[i] ? x + w - 6 - bold.widthOfTextAtSize(label, 7.5) : x + 6;
      text(page, label, tx, y - 8, 7.5, bold, MUTED);
      x += w;
    });
    y -= ROW_H;
  };
  const drawRow = (row: StatementPdfRow, strong = false) => {
    if (y < M + ROW_H) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - M;
      drawHeader();
    }
    if (row.isEmi) page.drawRectangle({ x: M, y: y - ROW_H + 5, width: PAGE_W - 2 * M, height: ROW_H, color: EMI_TINT });
    if (row.isEmi) page.drawRectangle({ x: M, y: y - ROW_H + 5, width: 2, height: ROW_H, color: LIME });
    const cells = [row.date, row.description, row.type, row.added, row.settled, row.balance];
    let x = M;
    cells.forEach((c, i) => {
      const w = COL_W[i];
      const font = strong ? bold : i === 2 && row.isEmi ? bold : regular;
      const t = fit(c, font, 9, w - 12);
      const tx = RIGHT_ALIGNED[i] ? x + w - 6 - font.widthOfTextAtSize(t, 9) : x + 6;
      text(page, t, tx, y - 9, 9, font, i === 2 ? MUTED : INK);
      x += w;
    });
    y -= ROW_H;
    page.drawLine({ start: { x: M, y: y + 5 }, end: { x: PAGE_W - M, y: y + 5 }, thickness: 0.4, color: RULE });
  };

  drawHeader();
  drawRow(model.openingRow, true);
  for (const r of model.rows) drawRow(r);
  if (model.rows.length === 0) drawRow({ date: "", description: "No activity in this cycle", type: "", isEmi: false, added: "", settled: "", balance: "" });
  drawRow(model.closingRow, true);

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const footer = `FlowFi · ${model.cycleLabel} · Page ${i + 1} of ${pages.length}`;
    p.drawText(pdfSafe(footer), { x: M, y: 20, size: 7.5, font: regular, color: MUTED });
  });

  return doc.save();
}
