/**
 * Review & Import helpers: every per-transaction action lives in the statement row's ⋯ menu (there is no bottom dock).
 * Menu item ids: keep_existing · import · review_later · ignore_match · inbox · details · clear · remove · restore.
 */
export const activeRowId = (page) => page.locator('[data-testid="recon-row"][aria-selected="true"]').first().getAttribute("data-row-id");

export const rowLoc = (page, rowId) => page.locator(`[data-testid="recon-row"][data-row-id="${rowId}"]`);

/** Open the ⋯ menu of a row (default: the row the Existing FlowFi sheet is describing). */
export async function openMenu(page, rowId) {
  rowId ??= await activeRowId(page);
  await rowLoc(page, rowId).getByTestId("quick-decide").click();
}

export async function menuItem(page, id, rowId) {
  // A menu still animating closed counts as closed: give it a moment to leave the page, then open a fresh one.
  await page.getByRole("menu").waitFor({ state: "detached", timeout: 600 }).catch(() => undefined);
  if ((await page.getByTestId(`resolve-${id}`).count()) === 0) await openMenu(page, rowId);
  return page.getByTestId(`resolve-${id}`);
}

/** Choose an item from a row's ⋯ menu. */
export async function choose(page, id, rowId) {
  await (await menuItem(page, id, rowId)).click();
}

/** Skip is a keyboard shortcut (I) now — the grid must have focus. */
export async function pressOnGrid(page, key) {
  await page.getByRole("grid", { name: "Statement rows" }).press(key);
}

/** Import as transaction: menu → the row's editor → its footer button, which opens the confirmation popover. */
export async function openImportConfirm(page, rowId) {
  await choose(page, "import", rowId);
  await page.getByTestId("import-as-transaction").click();
  await page.getByTestId("import-confirm").waitFor();
}
