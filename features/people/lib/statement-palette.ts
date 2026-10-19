/**
 * The shared People statement's palette — one set of hex tokens read by the PDF (converted to RGB) and the
 * Share preview (inline styles), so both carry the same colours for the same meaning.
 *
 * "Midnight & Champagne": a private-banking statement. White paper and near-black ink for the reading surface;
 * a deep midnight for the document's frame (the header band, the closing total, the ending balance) with fine
 * champagne-gold accents; cool, quiet hairlines; and semantic colour only where it carries meaning (green =
 * paid / received, amber = due, red = overdue, teal = advance). Text greys stay dark enough to survive print,
 * zoom, and a WhatsApp-compressed screenshot — only the rules are light.
 */

export const STATEMENT_INK = {
  ink: "#0F1726",
  body: "#384152",
  muted: "#586173",
  /** Placeholders ("-") and the quietest captions. */
  faint: "#8B93A3",
  /** Row and section dividers — light, but kept visible in print and on a phone screen. */
  rule: "#CDD4DE",
  ruleStrong: "#A9B3C2",
  surface: "#F6F7FA",
  head: "#EEF1F6",
  navy: "#1A2B4C",
  navyTint: "#EEF2F8",
  navyRule: "#B4C1D6",
  /** The document frame: header band, closing total, ending balance. */
  midnight: "#0E1A31",
  /** Hairline / ornament strokes drawn on midnight. */
  midnightLine: "#22355A",
  /** Secondary text on midnight. */
  onMidnight: "#C9D2E1",
  onMidnightMuted: "#8E9CB5",
  /** Champagne gold — accents only (rules, labels on midnight, section markers); never a figure. */
  gold: "#B48F55",
  goldLight: "#D9BE8E",
  /** The Remaining column — the figure that matters — sits on a faint band so the eye runs straight down it. */
  remainTint: "#F4F6FA",
  /** Split rows: a quiet slate-blue marker and tint, so a split reads as connected to its shares. */
  split: "#7E90B0",
  splitTint: "#F7F8FB",
  advance: "#0B5E66",
  advanceTint: "#E6F2F2",
  /** A settled balance on midnight. */
  settledOnMidnight: "#8FDDB2",
} as const;

/** A status chip's family. The same family means the same thing everywhere in the statement. */
export type StatementChip = "paid" | "partial" | "due" | "overdue" | "advance" | "upcoming" | "carried" | "neutral";

export const STATEMENT_CHIP: Record<StatementChip, { fill: string; text: string; edge: string }> = {
  paid: { fill: "#E9F5EE", text: "#17603A", edge: "#B3D8C1" },
  partial: { fill: "#FFFFFF", text: "#7A4D00", edge: "#DDB673" },
  due: { fill: "#FDF2DE", text: "#7A4D00", edge: "#E8C88C" },
  overdue: { fill: "#FCEBE9", text: "#991B1B", edge: "#E8B3AC" },
  advance: { fill: "#E6F2F2", text: "#0B5E66", edge: "#A5D0D1" },
  upcoming: { fill: "#EEF2F7", text: "#33496B", edge: "#C1CCDB" },
  carried: { fill: "#F7F1E6", text: "#6E5228", edge: "#E1CFAE" },
  neutral: { fill: "#F2F4F6", text: "#3A404A", edge: "#C7CDD5" },
};

/** "#RRGGBB" → [r, g, b] in 0–1, for pdf-lib's `rgb`. */
export function hexToUnit(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
