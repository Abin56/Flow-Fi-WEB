/**
 * Browser QA — the reusable contextual panel (cpanel-*) on the dev-only /dev/panels showcase. Local emulator run,
 * synthetic data, nothing is written. Checks placement near the trigger, viewport containment, outside / inside /
 * Escape behaviour, nested dropdowns, add/remove rows with internal scrolling, validation + save feedback, and the
 * phone bottom sheet.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const box = async (loc) => (await loc.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
const growth = (page) => page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
const inside = (b, vw, vh) => b.x >= 0 && b.y >= 0 && b.x + b.width <= vw + 0.5 && b.y + b.height <= vh + 0.5;
const open = async (page, trigger, panelId) => {
  await page.getByTestId(trigger).click();
  const p = page.getByTestId(panelId);
  await p.waitFor({ timeout: 15000 });
  await page.waitForTimeout(350);
  return p;
};

scenario("cpanel-desktop", "Panel opens beside its trigger, stays in the viewport, and closes by outside click / Escape but not by inside clicks", async ({ page }, chk) => {
  await h.go(page, "/dev/panels");
  const g0 = await growth(page);
  const t = await box(page.getByTestId("trigger-category"));
  const p = await open(page, "trigger-category", "panel-category");
  const b = await box(p);
  chk("popover (not sheet) on desktop", (await p.getAttribute("data-context-panel")) === "popover");
  chk("opens just below its trigger", b.y >= t.y + t.height && b.y - (t.y + t.height) < 24, `gap ${Math.round(b.y - (t.y + t.height))}`);
  chk("aligned with the trigger's left edge", Math.abs(b.x - t.x) < 4, `${Math.round(b.x)} vs ${Math.round(t.x)}`);
  chk("compact for 6 options (no search field, ≤ 420px)", b.height <= 420 && (await p.getByLabel("Search Categories").count()) === 0, `${Math.round(b.height)}px`);
  chk("inside the viewport", inside(b, page.viewportSize().width, page.viewportSize().height));
  chk("page did not grow", JSON.stringify(await growth(page)) === JSON.stringify(g0));
  await h.shot(page, "cpanel-1-category");

  await p.getByRole("heading", { name: "Category" }).click();
  chk("a click inside does not close it", await p.isVisible());
  await page.keyboard.press("Escape");
  await p.waitFor({ state: "hidden", timeout: 8000 });
  chk("Escape closes it", true);
  chk("focus returns to the trigger", await page.getByTestId("trigger-category").evaluate((el) => el === document.activeElement));

  await open(page, "trigger-category", "panel-category");
  await page.mouse.click(1300, 700);
  await p.waitFor({ state: "hidden", timeout: 8000 });
  chk("an outside click closes it", true);

  const p2 = await open(page, "trigger-category", "panel-category");
  await p2.getByRole("option", { name: /Transport/ }).click();
  await p2.waitFor({ state: "hidden", timeout: 8000 });
  chk("choosing an option applies it and closes", (await page.getByTestId("trigger-category").innerText()).includes("Transport"));

  const pa = await open(page, "trigger-account", "panel-account");
  chk("12 options show a search field", (await pa.getByLabel("Search Accounts").count()) === 1);
  await pa.getByLabel("Search Accounts").fill("Account 7");
  chk("search narrows the list", (await pa.getByRole("option").count()) === 1);
  await h.shot(page, "cpanel-2-account-search");
});

scenario("cpanel-split", "Split panel: add / remove rows, internal scroll, validation, nested dropdown, save feedback", async ({ page }, chk) => {
  await h.go(page, "/dev/panels");
  const g0 = await growth(page);
  const p = await open(page, "trigger-split", "panel-split");
  const rows = p.getByTestId("stacked-row");
  chk("starts with one row, no remove button (minimum 1)", (await rows.count()) === 1 && (await p.getByRole("button", { name: /^Remove/ }).count()) === 0);
  const savebtn = p.getByRole("button", { name: "Save split" });
  chk("₹600 left → Save disabled with the reason shown", (await savebtn.isDisabled()) && (await p.innerText()).includes("₹600 left to assign"));

  await p.getByRole("button", { name: /Add person/ }).click();
  await page.waitForTimeout(500);
  chk("Add person adds a row and keeps the first", (await rows.count()) === 2);
  chk("new row's person field has focus", await rows.nth(1).locator("button[role='combobox']").evaluate((el) => el === document.activeElement));
  chk("new row is pre-filled with the remaining ₹600", (await rows.nth(1).getByLabel("Amount 2").inputValue()) === "600");

  await rows.nth(1).getByRole("combobox", { name: "Person 2" }).click();
  await page.getByRole("option", { name: "Ben" }).click();
  chk("nested dropdown selects without closing the panel", (await p.isVisible()) && (await rows.nth(1).getByRole("combobox", { name: "Person 2" }).innerText()).includes("Ben"));
  chk("fully assigned → Save enabled", await savebtn.isEnabled());

  for (let i = 0; i < 14; i++) await p.getByRole("button", { name: /Add person/ }).click();
  await page.waitForTimeout(500);
  const b = await box(p);
  chk("16 rows: panel still inside the viewport", inside(b, page.viewportSize().width, page.viewportSize().height) && b.height <= 580, `${Math.round(b.height)}px`);
  const sc = await p.getByTestId("panel-body").evaluate((el) => ({ s: el.scrollHeight, c: el.clientHeight }));
  chk("body scrolls internally", sc.s > sc.c, `${sc.s}>${sc.c}`);
  chk("header and footer stay visible", (await p.getByRole("button", { name: "Save split" }).isVisible()) && (await p.getByRole("button", { name: "Close" }).isVisible()));
  const g1 = await growth(page);
  chk("page did not grow", g1.h === g0.h && g1.w <= 0, `${g0.h}→${g1.h}`);
  await h.shot(page, "cpanel-3-split-many");

  await p.getByRole("button", { name: "Remove person 16" }).click();
  await page.waitForTimeout(400);
  chk("Remove deletes just that row", (await rows.count()) === 15);
  for (let i = 15; i >= 3; i--) {
    await p.getByRole("button", { name: `Remove person ${i}` }).click();
    await page.waitForTimeout(260);
  }
  chk("back to two rows", (await rows.count()) === 2);

  await rows.nth(0).getByLabel("Amount 1").fill("700");
  chk("over-assigned shows ₹100 over and disables Save", (await p.innerText()).includes("₹100 over") && (await savebtn.isDisabled()));
  await rows.nth(0).getByLabel("Amount 1").fill("600");
  await savebtn.click();
  await p.waitFor({ state: "hidden", timeout: 8000 });
  chk("Save closes the panel with success feedback", await page.getByTestId("flash").isVisible());
  chk("saved result shown on the page", (await page.getByTestId("split-saved").innerText()).includes("Asha ₹600 · Ben ₹600"));
});

scenario("cpanel-filters", "Filters panel: sections expand / collapse and summarise; Enter applies", async ({ page }, chk) => {
  await h.go(page, "/dev/panels");
  const p = await open(page, "trigger-filters", "panel-filters");
  const notes = p.getByRole("button", { name: /^Notes/ });
  chk("Notes starts collapsed", (await notes.getAttribute("aria-expanded")) === "false");
  await notes.click();
  await page.waitForTimeout(350);
  chk("expands inside the same panel", (await notes.getAttribute("aria-expanded")) === "true" && (await p.getByLabel("Notes contain").isVisible()));
  await p.getByLabel("Notes contain").fill("rent");
  await notes.click();
  await page.waitForTimeout(350);
  chk("collapsed section shows its summary", (await notes.innerText()).includes("rent"));
  await h.shot(page, "cpanel-4-filters");
  await p.getByRole("button", { name: "Apply" }).click();
  await p.waitFor({ state: "hidden", timeout: 8000 });
  chk("Apply updates the page", (await page.getByTestId("filters-applied").innerText()).includes("note"));
});

scenario("cpanel-short-viewport", "On a short window the panel shrinks to the available height and scrolls inside", async ({ page }, chk) => {
  await h.go(page, "/dev/panels");
  const p = await open(page, "trigger-split", "panel-split");
  for (let i = 0; i < 6; i++) await p.getByRole("button", { name: /Add person/ }).click();
  await page.waitForTimeout(500);
  const b = await box(p);
  chk("inside a 420px-high window", inside(b, 1100, 420), `${Math.round(b.y)}–${Math.round(b.y + b.height)}`);
  chk("footer reachable", await p.getByRole("button", { name: "Save split" }).isVisible());
  await h.shot(page, "cpanel-5-short");
}, { viewport: { width: 1100, height: 420 } });

scenario("cpanel-mobile", "Phone: the same panel is a bottom sheet; add/remove still work; no overflow", async ({ page }, chk) => {
  await h.go(page, "/dev/panels");
  const p = await open(page, "trigger-split", "panel-split");
  chk("renders as a sheet", (await p.getAttribute("data-context-panel")) === "sheet");
  const b = await box(p);
  chk("anchored to the bottom, full width", Math.abs(b.y + b.height - 844) < 3 && b.width >= 385, `${Math.round(b.y)}+${Math.round(b.height)} w${Math.round(b.width)}`);
  await p.getByRole("button", { name: /Add person/ }).click();
  await page.waitForTimeout(500);
  chk("rows add on the phone", (await p.getByTestId("stacked-row").count()) === 2);
  chk("no horizontal overflow", (await growth(page)).w <= 0);
  await h.shot(page, "cpanel-6-mobile");
  await page.keyboard.press("Escape");
  await p.waitFor({ state: "hidden", timeout: 8000 });
  chk("Escape closes the sheet", true);
}, { viewport: { width: 390, height: 844 } });
