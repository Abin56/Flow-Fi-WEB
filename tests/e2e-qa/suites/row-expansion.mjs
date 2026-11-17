/**
 * Browser QA scenarios (row-expansion.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * The expanded People Ledger row is a compact extension of its row: the essentials by default (title/type, who has to pay ·
 * paid · remaining, progress, ONE primary action, payment timing) and everything secondary behind "More details".
 * Opening a row brings it (and its panel) into comfortable view inside the table's own scroll area; a panel the user
 * makes taller (More details, Postpone again) is kept in view too. Display only — every check that touches money
 * reads the persisted documents back.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";

const isMobile = (page) => (page.viewportSize()?.width ?? 1000) < 768;
const sfx = (page) => (isMobile(page) ? "-mobile" : "");
const panel = (page) => page.locator('[data-testid="row-expansion"]:visible').first();

/** Opens QA Priya's EMI share row (table row on a desktop, list item on a phone). */
async function expandShare(page) {
  await f.openPerson(page, "QA Priya");
  if (isMobile(page)) await page.locator('li[data-obligation-key]', { hasText: /EMI share/ }).first().locator("button[aria-expanded]").first().click();
  else await page.locator('tr[data-obligation-key]', { hasText: /EMI share/ }).first().locator("td").nth(2).click();
  await panel(page).waitFor();
  await page.waitForTimeout(900); // the row's own animation + reveal
  return panel(page);
}

/** Where `selector`'s first visible element sits against the visible part of every scroll area it lives in. */
const placement = (page, selector) =>
  page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.offsetParent != null);
    if (!el) return null;
    let top = 0;
    let bottom = window.innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const y = getComputedStyle(p).overflowY;
      if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight + 1) {
        const r = p.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      }
    }
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), viewTop: Math.round(top), viewBottom: Math.round(bottom) };
  }, selector);

const noPageOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

scenario("rexp-default-compact", "People: an expanded EMI share shows the essentials in a compact panel; the rest sits behind 'More details'", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const exp = await expandShare(page);
  const text = (await f.flat(exp)).replace(/\s+/g, " ");
  chk("the money at a glance: who has to pay · paid · remaining, with a progress bar", /has to pay/.test(text) && / paid /.test(text) && /Remaining/.test(text) && (await exp.getByRole("progressbar").count()) === 1, text.slice(0, 220));
  chk("exactly one primary action: Record payment", (await exp.getByRole("button", { name: "Record payment" }).count()) === 1);
  chk("an EMI share shows its two statuses (bank EMI · reimbursement)", /Bank EMI/.test(text) && /reimbursement/.test(text), text.slice(0, 260));
  chk("secondary content is folded: no details region, no Ref / Payment history", (await exp.getByTestId("row-details").count()) === 0 && !/\bRef\b/.test(text) && !/Payment history/.test(text));
  const box = await panel(page).boundingBox();
  chk("compact: the default panel is at most 200px tall (the old one was ~340px)", box != null && box.height <= 200, `${Math.round(box?.height ?? 0)}px`);
  chk("no horizontal page overflow", (await noPageOverflow(page)) <= 1);
  await h.shot(page, `rexp-default${sfx(page)}`);

  const toggle = exp.getByTestId("row-more-details");
  await toggle.click();
  await page.waitForTimeout(500);
  const open = (await f.flat(exp)).replace(/\s+/g, " ");
  chk("More details reveals the transaction facts (EMI, Installment, Due, Ref)", /Installment/.test(open) && /\bDue\b/.test(open) && /\bRef\b/.test(open), open.slice(-260));
  chk("the toggle now reads 'Fewer details' and reports it is expanded", (await toggle.getAttribute("aria-expanded")) === "true" && /Fewer details/.test(await toggle.innerText()));
  await h.shot(page, `rexp-details${sfx(page)}`);
  await toggle.click();
  await page.waitForTimeout(300);
  chk("folds again", (await exp.getByTestId("row-details").count()) === 0);

  const row = page.locator("[data-obligation-key]:visible", { hasText: /EMI share/ }).first();
  await exp.getByTestId("row-collapse").click();
  await page.waitForTimeout(600);
  chk("the panel's own Collapse closes the row", (await panel(page).count()) === 0 && (await row.getAttribute("aria-expanded")) !== "true");
  return await h.timeline(page);
});

scenario("rexp-postponed-row", "People: a postponed share keeps Postpone again / Cancel postponement, shows no duplicate 'Received', and stays compact", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const txBefore = (await h.list("transactions")).length;
  let exp = await expandShare(page);
  await exp.getByRole("button", { name: /postpone payment/i }).click();
  const group = page.getByRole("group", { name: "Postpone payment" });
  await group.waitFor();
  await page.waitForTimeout(600);
  const grown = await placement(page, '[role="group"][aria-label="Postpone payment"]');
  chk("opening the Postpone panel keeps it in view (it grew after a click)", grown != null && grown.bottom <= grown.viewBottom + 2, JSON.stringify(grown));
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(1500);

  exp = panel(page);
  const text = (await f.flat(exp)).replace(/\s+/g, " ");
  chk("the postponement reads in the timing line (Moved to … cycle)", /Moved to .* cycle|Postponed until/.test(text), text.slice(0, 260));
  chk("Postpone again and Cancel postponement are visible buttons", (await exp.getByRole("button", { name: /^Postpone again/ }).count()) === 1 && (await exp.getByRole("button", { name: /^(Back to .* cycle|Cancel postponement)$/ }).count()) === 1);
  chk("Record payment is the one payment action — 'Received' is not repeated beside it", (await exp.getByRole("button", { name: "Record payment" }).count()) === 1 && (await exp.getByRole("button", { name: "Received" }).count()) === 0);
  const box = await panel(page).boundingBox();
  chk("still compact after postponing (≤ 200px)", box != null && box.height <= 200, `${Math.round(box?.height ?? 0)}px`);
  await h.shot(page, `rexp-postponed${sfx(page)}`);

  await exp.getByRole("button", { name: /^Postpone again/ }).click();
  await page.waitForTimeout(700);
  const again = await placement(page, '[role="group"][aria-label="Postpone payment"]');
  chk("Postpone again also keeps its panel in view", again != null && again.bottom <= again.viewBottom + 2, JSON.stringify(again));
  chk("no money moved and no transaction was created by any of it", f.close2(await f.bal("QA Bank"), bank0) && (await h.list("transactions")).length === txBefore);
  return await h.timeline(page);
});

/**
 * Opens the LAST row of the ledger (the one nearest the fold) in a window of the given height. `fits` = the window is tall
 * enough for the whole of More details to fit beside its toggle; a shorter one can only lead with the toggle (the rest is
 * one scroll away), which is the intended behaviour for a block taller than the visible area.
 */
const scrollBody = (fits) => async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya");
  const rows = page.locator("tr[data-obligation-key]:visible");
  const n = await rows.count();
  chk("the ledger has rows to open", n >= 2, String(n));
  const last = rows.nth(n - 1);
  const lastKey = await last.getAttribute("data-obligation-key");
  await last.scrollIntoViewIfNeeded();
  const mainBefore = await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
  await last.locator("td").nth(2).click();
  await page.waitForTimeout(1500); // animation (220ms) + reveal + smooth scroll
  const p = await placement(page, '[data-testid="row-expansion"]');
  chk("the panel's bottom is inside the visible area (or its row header leads when it is taller)", p != null && (p.bottom <= p.viewBottom + 2 || (p.height > p.viewBottom - p.viewTop && p.top >= p.viewTop - 2)), JSON.stringify(p));
  const rowBox = await placement(page, "tr[aria-expanded=true]");
  chk("the clicked row itself is still visible, clear of the sticky header", rowBox != null && rowBox.top >= rowBox.viewTop - 1 && rowBox.bottom <= rowBox.viewBottom + 1, JSON.stringify(rowBox));
  const mainAfter = await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
  chk("the page did not jump back to the top", mainAfter >= mainBefore - 2, `${mainBefore} -> ${mainAfter}`);
  await h.shot(page, fits ? "rexp-scroll-tall" : "rexp-scroll");

  await panel(page).getByTestId("row-more-details").click();
  await page.waitForTimeout(1200);
  const d = await placement(page, '[data-testid="row-details"]');
  if (fits) chk("More details, opened at the bottom, is fully in view", d != null && d.bottom <= d.viewBottom + 2 && d.top >= d.viewTop - 2, JSON.stringify(d));
  else chk("More details, opened in a window too short for all of it, starts in view (its toggle leads)", d != null && d.top >= d.viewTop - 2 && d.top < d.viewBottom - 40, JSON.stringify(d));
  await panel(page).getByTestId("row-collapse").click();
  await page.waitForTimeout(900);
  const back = await placement(page, `tr[data-obligation-key="${lastKey}"]`);
  chk("after collapsing, the row you had open is still in view (position preserved, not lost)", back != null && back.bottom > back.viewTop && back.top < back.viewBottom, JSON.stringify(back));
  return await h.timeline(page);
};
scenario("rexp-scroll-into-view", "People: opening a row near the bottom of a short window brings its panel into view — inside the table, without jumping the page", scrollBody(false), { viewport: { width: 1366, height: 560 } });
scenario("rexp-scroll-details-fit", "People: in a window tall enough for it, More details opened at the bottom ends up fully in view", scrollBody(true), { viewport: { width: 1366, height: 800 } });

scenario("rexp-mobile-dark", "People: the compact expansion on a phone, dark — figures wrap, nothing overflows, More details works", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const exp = await expandShare(page);
  const text = (await f.flat(exp)).replace(/\s+/g, " ");
  chk("figures and the primary action are present", /has to pay/.test(text) && /Remaining/.test(text) && (await exp.getByRole("button", { name: "Record payment" }).count()) === 1, text.slice(0, 200));
  chk("no horizontal overflow", (await noPageOverflow(page)) <= 1);
  await h.shot(page, "rexp-mobile-default");
  await exp.getByTestId("row-more-details").click();
  await page.waitForTimeout(600);
  chk("More details opens on a phone", (await exp.getByTestId("row-details").count()) === 1 && (await noPageOverflow(page)) <= 1);
  await h.shot(page, "rexp-mobile-details");
  return await h.timeline(page);
}, { viewport: { width: 390, height: 844 }, scheme: "dark" });
