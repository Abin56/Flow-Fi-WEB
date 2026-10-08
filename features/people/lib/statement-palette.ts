/**
 * The shared People statement's palette — one set of hex tokens read by the PDF (converted to RGB) and the
 * Share preview (inline styles), so both carry the same colours for the same meaning. A printed statement:
 * white paper, charcoal text, deep navy for structure, cool grey surfaces, and semantic colour only where it
 * carries meaning (green = paid / received, amber = due, red = overdue, teal = advance). Greys are kept dark
 * enough to survive print, zoom, and a WhatsApp-compressed screenshot.
 */

export const STATEMENT_INK = {
  ink: "#151A22",
  body: "#333A46",
  muted: "#535B68",
  rule: "#B4BDC9",
  ruleStrong: "#7F8A99",
  surface: "#F3F5F8",
  head: "#E7ECF2",
  navy: "#1D3658",
  navyTint: "#EDF2F8",
  navyRule: "#A9BACF",
  /** The Remaining column — the figure that matters — sits on a faint band so the eye runs straight down it. */
  remainTint: "#F3F6FA",
  /** Split rows: a quiet slate-blue marker and tint, so a split reads as connected to its shares. */
  split: "#7189AA",
  splitTint: "#F5F7FB",
  advance: "#0B5E66",
  advanceTint: "#E4F2F2",
} as const;

/** A status chip's family. The same family means the same thing everywhere in the statement. */
export type StatementChip = "paid" | "partial" | "due" | "overdue" | "advance" | "upcoming" | "carried" | "neutral";

export const STATEMENT_CHIP: Record<StatementChip, { fill: string; text: string; edge: string }> = {
  paid: { fill: "#E5F3EA", text: "#1B6A3E", edge: "#94C7A6" },
  partial: { fill: "#FFFFFF", text: "#7A4D00", edge: "#CF9C47" },
  due: { fill: "#FCF0D8", text: "#7A4D00", edge: "#DDB468" },
  overdue: { fill: "#FBE8E6", text: "#9B1C1C", edge: "#DF9E97" },
  advance: { fill: "#E4F2F2", text: "#0B5E66", edge: "#86C2C4" },
  upcoming: { fill: "#EBEFF5", text: "#38506B", edge: "#A7B5C7" },
  carried: { fill: "#EBEFF5", text: "#38506B", edge: "#A7B5C7" },
  neutral: { fill: "#F0F2F4", text: "#3A404A", edge: "#A7AEB8" },
};

/** "#RRGGBB" → [r, g, b] in 0–1, for pdf-lib's `rgb`. */
export function hexToUnit(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
