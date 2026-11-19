/**
 * Test helpers for the statement row's ⋯ menu — where every per-transaction action now lives (there is no bottom dock).
 * Only used by the reconciliation tests.
 */
import { fireEvent, screen, within } from "@testing-library/react";

/** The statement row the Existing FlowFi sheet is currently describing. */
export const activeRowId = () => screen.getByTestId("existing-comparing").dataset.rowId!;

export const statementRow = (rowId: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === rowId)!;

/** The FlowFi transaction picked in the Existing FlowFi sheet (what Keep existing would keep). */
export const pickedRecordId = () => screen.getByTestId("existing-grid").getAttribute("aria-activedescendant")?.replace("existing-row-", "") ?? null;

export function openRowMenu(rowId: string = activeRowId()) {
  fireEvent.click(within(statementRow(rowId)).getByTestId("quick-decide"));
}

/** One item of a row's ⋯ menu (opens the menu when it is closed). Ids: keep_existing · import · review_later · ignore_match · inbox · details · clear · remove · restore. */
export function menuItem(id: string, rowId?: string): HTMLButtonElement {
  if (!screen.queryByTestId(`resolve-${id}`)) openRowMenu(rowId);
  return screen.getByTestId(`resolve-${id}`) as HTMLButtonElement;
}

/** Import as transaction: menu → the row's editor → its "Import as transaction" button, which opens the confirmation. */
export function openImportConfirm(rowId?: string) {
  fireEvent.click(menuItem("import", rowId));
  fireEvent.click(screen.getByTestId("import-as-transaction"));
}
