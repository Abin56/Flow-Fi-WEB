/**
 * Test helpers for the statement row's ⋯ menu — where every per-transaction action now lives (there is no bottom dock).
 * Only used by the reconciliation tests.
 */
import { fireEvent, screen, within } from "@testing-library/react";

/** The statement row in focus: the selected row of the single review sheet. */
export const activeRowId = () => screen.getAllByTestId("recon-row").find((r) => r.getAttribute("aria-selected") === "true")!.dataset.rowId!;

export const statementRow = (rowId: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === rowId)!;

/** The FlowFi transaction shown in the open inline review's comparison (what Keep existing would keep). */
export const pickedRecordId = () => {
  const checked = screen.queryAllByTestId("inline-candidate").find((c) => c.getAttribute("aria-checked") === "true");
  return checked?.dataset.recordId ?? screen.queryByTestId("inline-compare")?.dataset.recordId ?? null;
};

export function openRowMenu(rowId: string = activeRowId()) {
  fireEvent.click(within(statementRow(rowId)).getByTestId("quick-decide"));
}

/** One item of a row's ⋯ menu (opens the menu when it is closed). Ids: keep_existing · import · review_later · ignore_match · inbox · details · clear · remove · restore. */
export function menuItem(id: string, rowId?: string): HTMLButtonElement {
  if (!screen.queryByTestId(`resolve-${id}`)) openRowMenu(rowId);
  return screen.getByTestId(`resolve-${id}`) as HTMLButtonElement;
}

/** The row's category, picked right in the table (2026-11-25 — no confirmation popover). */
export function setRowCategory(rowId: string, category: string) {
  fireEvent.change(within(statementRow(rowId)).getByTestId("row-category"), { target: { value: category } });
}

/** Opens the inline comparison under a row (its "Possible match" chip). */
export function openInlineReview(rowId: string) {
  const row = statementRow(rowId);
  fireEvent.click(row);
  fireEvent.click(within(row).getByRole("button", { name: /^Compare row/ }));
}

/** The row's status (ready · duplicate · fix · imported · skipped · checking). */
export const rowStatusOf = (rowId: string) => statementRow(rowId).dataset.status;
