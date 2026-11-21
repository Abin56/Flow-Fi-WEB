/**
 * Layout planner for the People Ledger "people wall". Pure presentation maths — it only decides how the people
 * shown are arranged, from how many there are and the width available. No figures are read or changed here.
 *
 * - 1 person  → `spotlight`: one horizontal record with its details already open (no lonely tile, no slab).
 * - 2–5       → `row`: comfortable fixed-width tiles in a natural row (they never stretch to fill the page).
 * - 6+        → `wall`: compact tiles filling as many columns as fit, rows growing downward.
 *
 * Tiles have a fixed footprint; their hover preview overlays the row below instead of pushing it, so the planner
 * also says which tiles sit in the last row (those open upward when there is more than one row).
 */

/** Space between tiles (px) — must match the wall's gap. */
export const GRID_GAP = 12;
/** Tile width for 2–5 people. */
export const ROW_TILE_WIDTH = 236;
/** Narrowest tile in the many-people wall. */
export const WALL_MIN_TILE = 196;
/** Collapsed tile height (px) — the li reserves exactly this; the card inside may grow over neighbours. */
export const TILE_HEIGHT = 128;
/** Upper bound on columns, so very wide screens don't produce a ribbon of tiny tiles. */
export const MAX_COLUMNS = 7;

export type PeopleWallMode = "spotlight" | "row" | "wall";

export interface PeopleWallPlan {
  mode: PeopleWallMode;
  cols: number;
  rows: number;
  /** CSS grid-template-columns for the wall. */
  template: string;
  /** Index of the first tile in the last row. */
  lastRowStart: number;
}

function columnsThatFit(width: number, tile: number): number {
  return Math.max(1, Math.floor((width + GRID_GAP) / (tile + GRID_GAP)));
}

/**
 * @param count people shown
 * @param width available width in px; 0/unknown (before the first measurement) falls back to a safe guess.
 */
export function planPeopleWall(count: number, width: number): PeopleWallPlan {
  if (count <= 1) return { mode: "spotlight", cols: 1, rows: count, template: "minmax(0, 1fr)", lastRowStart: 0 };
  const measured = width > 0 ? width : 1000;

  if (count <= 5) {
    const fit = columnsThatFit(measured, ROW_TILE_WIDTH);
    if (fit >= count) {
      return { mode: "row", cols: count, rows: 1, template: `repeat(${count}, ${ROW_TILE_WIDTH}px)`, lastRowStart: 0 };
    }
  }

  const cols = Math.min(MAX_COLUMNS, columnsThatFit(measured, WALL_MIN_TILE));
  const rows = Math.ceil(count / cols);
  return {
    mode: "wall",
    cols,
    rows,
    template: `repeat(${cols}, minmax(0, 1fr))`,
    lastRowStart: (rows - 1) * cols,
  };
}

/**
 * Neighbour magnification for the hovered tile at `hot`: grid distance (in tiles, Euclidean) → scale and opacity.
 * The hovered tile itself is handled by CSS (`:hover`); adjacent tiles swell a little, the rest recede slightly.
 */
export function neighbourEffect(index: number, hot: number, cols: number): { scale: number; dim: number } {
  if (index === hot) return { scale: 1, dim: 1 };
  const dx = (index % cols) - (hot % cols);
  const dy = Math.floor(index / cols) - Math.floor(hot / cols);
  const d = Math.hypot(dx, dy);
  // Bell curve: the next tile over ≈ +1.6%, a diagonal ≈ +1%, two away ≈ +0.2% — and an opacity that eases with it.
  const lift = Math.exp(-(d * d) / 1.6);
  return { scale: 1 + 0.025 * lift, dim: 0.74 + 0.2 * lift };
}
