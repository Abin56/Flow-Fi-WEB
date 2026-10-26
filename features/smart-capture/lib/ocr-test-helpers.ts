/** Test-only builders for synthetic OCR output (positioned words with confidences). */
import { wordsToLineText, type OcrLine, type OcrWord } from "./tesseract-ocr";

/** Each cell is a group of words; cells are separated by a wide gap (→ tab). `conf` overrides per word text. */
export function ocrLine(y: number, cells: string[], conf: Record<string, number> = {}, height = 20): OcrLine {
  const words: OcrWord[] = [];
  let x = 10;
  for (const cell of cells) {
    // An empty cell is a blank column — just extra horizontal space.
    for (const text of cell.split(" ").filter(Boolean)) {
      const width = text.length * 10;
      words.push({ text, confidence: conf[text] ?? 95, bbox: { x0: x, y0: y, x1: x + width, y1: y + height } });
      x += width + 6;
    }
    x += 80;
  }
  return { text: wordsToLineText(words), bbox: { x0: 10, y0: y, x1: x, y1: y + height }, words };
}

export function ocrText(lines: OcrLine[]): string {
  return lines.map((l) => l.text).join("\n");
}
