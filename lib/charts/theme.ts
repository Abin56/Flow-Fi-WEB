/**
 * Sunset chart theme — the single source every recharts instance draws from, so every
 * chart in the app reads as one system instead of each page picking its own colors.
 *
 * Color policy (validated with the dataviz skill's CVD/contrast checker against the
 * Sunset OKLCH tokens in globals.css):
 *  - `success` (sage green) and `expense` (coral-red) fail categorical CVD separation
 *    under deuteranopia (ΔE ~1.6-4.6, well under the ΔE 8 target) — this pair is
 *    unavoidable in a finance app (income vs. expense), so it must NEVER be color-only.
 *    Always pair it with direct labels, a legend, and/or distinct stroke style
 *    (solid vs. dashed), never bare colored lines/bars with no other cue.
 *  - `primary` + `purple` + `success` is the default 3-series categorical set — it
 *    passes lightness, chroma, CVD, and normal-vision checks cleanly.
 *  - `warning` (golden) fails the light-mode lightness band and contrast-vs-surface
 *    floor as a mark color — reserve it for status badges/icons only, never a
 *    primary chart series.
 *  - `primary` itself sits at ~2.9:1 contrast on the cream surface (a WARN, not a
 *    fail) — every chart using it ships direct value labels or a tooltip, satisfying
 *    the checker's required "relief channel".
 */

export const CHART_SERIES = {
  primary: "var(--primary)",
  purple: "var(--purple)",
  success: "var(--success)",
  expense: "var(--expense)",
} as const;

/** Default categorical order for 3-series charts — passes every CVD/contrast check. */
export const CATEGORICAL_ORDER = [CHART_SERIES.primary, CHART_SERIES.purple, CHART_SERIES.success] as const;

export const gridStyle = {
  stroke: "var(--border)",
  strokeOpacity: 0.6,
  strokeDasharray: "0",
  vertical: false,
} as const;

export const axisStyle = {
  stroke: "var(--border)",
  tick: { fill: "var(--muted-foreground)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

/** Recharts tooltip content styled like a mini FloatingCard — matches the app's Clay elevation system. */
export const tooltipContentStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-e3)",
  padding: "0.625rem 0.875rem",
  fontSize: "0.75rem",
};

export const tooltipLabelStyle: React.CSSProperties = {
  color: "var(--muted-foreground)",
  fontWeight: 500,
  marginBottom: "0.25rem",
};

export const tooltipItemStyle: React.CSSProperties = {
  color: "var(--foreground)",
  fontWeight: 600,
};
