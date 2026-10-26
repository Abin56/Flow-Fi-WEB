/**
 * Adaptive column layout for the Smart Capture review list — *presentation only*.
 *
 * The parser records, per row, the order its fields appeared in the source line (`CaptureRow.sourceOrder`, each
 * field named from its own contents) and, per statement, the order a header line names (`headerOrder`). This module
 * decides from those whether the source's column order is certain enough to display. If it is not, it says so and
 * the review keeps its standard layout — it never guesses.
 *
 * Nothing here reads or writes a date, amount, direction or merchant: a column is only ever *where a value is drawn*.
 */

import type { CaptureParseResult, SourceField } from "./parse-pasted-statement";

export type DisplayColumn = SourceField;

export const COLUMN_LABEL: Record<DisplayColumn, string> = {
  date: "Date",
  merchant: "Merchant",
  amount: "Amount",
  direction: "Charge/Credit",
  debit: "Debit",
  credit: "Credit",
};

/** The order used when the source's own order is unknown and the user opts to customize. */
export const DEFAULT_COLUMNS: readonly DisplayColumn[] = ["date", "merchant", "amount"];

export interface SourceLayout {
  /** Columns in source order; null when the order couldn't be established reliably. */
  order: DisplayColumn[] | null;
  basis: "header" | "rows" | "none";
  /** Plain-language account of the decision, shown in the layout control. */
  reason: string;
  /** Rows that named an order / rows that agreed with the winning one / all rows. */
  evidence: { voting: number; agreeing: number; total: number };
}

/** A row order must agree this much among voting rows, and these rows must be this share of all rows. */
const MIN_AGREEMENT = 0.8;
const MIN_COVERAGE = 0.6;
/** A separate Charge/Credit column is shown only when this share of voting rows has its own marker cell on the same side. */
const MIN_DIRECTION_SHARE = 0.6;

type Core = "date" | "merchant" | "amount";
const core = (order: readonly DisplayColumn[]): Core[] =>
  order.flatMap((f) => (f === "date" || f === "merchant" ? [f] : f === "amount" || f === "debit" ? ["amount" as const] : []));

/** debit+credit collapse to one amount slot; a header with both counts it once. */
const coreKey = (order: readonly DisplayColumn[]) => [...new Set(core(order))].join(">");

export function detectSourceLayout(parse: Pick<CaptureParseResult, "rows" | "headerOrder">): SourceLayout {
  const total = parse.rows.length;
  const voters = parse.rows.flatMap((r) => (r.sourceOrder ? [r.sourceOrder] : []));
  const evidence = (agreeing: number) => ({ voting: voters.length, agreeing, total });
  const none = (reason: string, agreeing = 0): SourceLayout => ({ order: null, basis: "none", reason, evidence: evidence(agreeing) });

  if (voters.length === 0) return none("No row's columns could be told apart with certainty.");

  const tally = new Map<string, number>();
  for (const order of voters) tally.set(coreKey(order), (tally.get(coreKey(order)) ?? 0) + 1);
  const [winKey, winCount] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  if (winCount / voters.length < MIN_AGREEMENT) return none("Rows disagree about their column order, so it can't be trusted.", winCount);
  if (winCount / total < MIN_COVERAGE) return none("Too few rows could be read column by column to trust the order.", winCount);
  const winning = voters.find((o) => coreKey(o) === winKey)!;
  const base = [...new Set(core(winning))] as Core[];

  if (parse.headerOrder) {
    // The header must name the same date / merchant / amount order the rows show — otherwise one of them is wrong.
    if (coreKey(parse.headerOrder) !== winKey) return none("The header's column order doesn't match the rows, so it can't be trusted.", winCount);
    return { order: [...parse.headerOrder], basis: "header", reason: "Column order taken from the statement's header, confirmed by its rows.", evidence: evidence(winCount) };
  }

  const order: DisplayColumn[] = [...base];
  const marked = voters.filter((o) => o.includes("direction"));
  if (marked.length / voters.length >= MIN_DIRECTION_SHARE) {
    const before = marked.filter((o) => o.indexOf("direction") < o.indexOf("amount")).length;
    // Same side in every marked row; otherwise it stays attached to the amount.
    if (before === marked.length) order.splice(order.indexOf("amount"), 0, "direction");
    else if (before === 0) order.splice(order.indexOf("amount") + 1, 0, "direction");
  }
  return { order, basis: "rows", reason: "Column order read from the rows' own cells (dates, amounts and text identified by what they contain).", evidence: evidence(winCount) };
}

/** Columns a custom layout may reorder: the detected set, or date/merchant/amount when the source order is unknown. */
export function baseColumns(layout: SourceLayout): DisplayColumn[] {
  return layout.order ? [...layout.order] : [...DEFAULT_COLUMNS];
}

/** A saved custom order is usable only if it is exactly a permutation of the columns currently available. */
export function validCustomOrder(order: unknown, available: readonly DisplayColumn[]): order is DisplayColumn[] {
  return Array.isArray(order) && order.length === available.length && new Set(order).size === order.length && order.every((c) => available.includes(c as DisplayColumn));
}

export function moveColumn(order: readonly DisplayColumn[], column: DisplayColumn, delta: -1 | 1): DisplayColumn[] {
  const from = order.indexOf(column);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// --- per-tab preference (column names only — no statement content) -------------------------------------------------

const STORAGE_KEY = "flowfi.smartCapture.columns.v1";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadColumnPreference(available: readonly DisplayColumn[]): DisplayColumn[] | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const order: unknown = raw ? JSON.parse(raw) : null;
    return validCustomOrder(order, available) ? order : null;
  } catch {
    return null;
  }
}

export function saveColumnPreference(order: readonly DisplayColumn[] | null): void {
  try {
    if (order) storage()?.setItem(STORAGE_KEY, JSON.stringify(order));
    else storage()?.removeItem(STORAGE_KEY);
  } catch {
    // A convenience only.
  }
}
