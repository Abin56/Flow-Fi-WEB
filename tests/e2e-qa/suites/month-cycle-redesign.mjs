/**
 * Month Cycle compact redesign (UI-only) — density and layout on synthetic emulator data. Read-only.
 *   npm run test:e2e-qa -- mcux- --copy
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

async function open(page) {
  await h.go(page, "/month-cycle");
  await page.getByRole("heading", { level: 1, name: "Month Cycle" }).waitFor({ timeout: 60000 });
  await page.waitForSelector('[aria-label="Cycle summary"]', { timeout: 60000 });
  await page.waitForTimeout(2500);
}

const errsOf = (logs) => logs.filter((l) => !/Select is changing|status of 400|React DevTools|Download the React/.test(l));

for (const [w, hgt] of [
  [1440, 900],
  [1920, 1080],
]) {
  scenario(`mcux-layout-${w}`, `Month Cycle redesign at ${w}×${hgt}: compact panels, no overflow, light/dark`, async ({ page, logs }, chk, notes) => {
    await page.setViewportSize({ width: w, height: hgt });
    await h.addFixture(page, "shared-emi");
    await open(page);
    const m = await page.evaluate(() => {
      const r = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : null; };
      return {
        summaryH: r('section[aria-label="Cycle summary"]'),
        dueH: r('section[aria-label="Upcoming this cycle"]'),
      };
    });
    notes.push(JSON.stringify(m));
    chk("cycle summary panel present and reasonably compact (≤ 320px)", m.summaryH != null && m.summaryH <= 320, m.summaryH);
    chk("due-this-cycle workspace present", m.dueH != null, m.dueH);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
    chk("no horizontal overflow", o.sw <= o.cw + 1 && o.mw <= 1, JSON.stringify(o));
    await h.shot(page, `mcux-${w}-light`);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(700);
    await h.shot(page, `mcux-${w}-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
  });
}

scenario("mcux-interactions", "Month Cycle redesign: view toggle, view-list dialog, due tabs, section nav, cycle nav all still work", async ({ page, logs }, chk) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await h.addFixture(page, "shared-emi");
  await open(page);

  const summary = page.getByRole("region", { name: "Cycle summary" });
  await summary.getByRole("radio", { name: "Combined" }).click();
  await page.waitForTimeout(300);
  chk("Combined view shows 'Total outflow'", /total outflow/i.test(await summary.innerText()));
  await summary.getByRole("radio", { name: "Mine only" }).click();
  await page.waitForTimeout(300);
  chk("Mine only view shows 'My spend'", /my spend/i.test(await summary.innerText()));

  await summary.getByRole("button", { name: /View list/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  chk("expense list dialog opens", (await dlg.count()) === 1);
  await page.getByRole("button", { name: "Close" }).click();
  await dlg.waitFor({ state: "hidden" });

  const tabs = page.getByRole("tablist", { name: "Due this cycle" });
  const tabNames = ["EMI", "Loans", "Card bills", "Bills"];
  for (const name of tabNames) {
    const tab = tabs.getByRole("tab", { name: new RegExp(`^${name}`) });
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(200);
      chk(`"${name}" tab selects`, (await tab.getAttribute("aria-selected")) === "true");
    }
  }

  // "Budget" is the last section — once the page hits max scroll the panel sits wherever the remaining
  // content below it allows, not necessarily pinned to the top, so the real check is "visible", not "near 0".
  const nav = page.getByRole("navigation", { name: "Month cycle sections" });
  const scrollBefore = await page.evaluate(() => document.querySelector("main").scrollTop);
  await nav.getByRole("button", { name: "Budget" }).click();
  const budget = page.locator("#mc-budget");
  let budgetTop = -1;
  let scrollAfter = scrollBefore;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const box = await budget.boundingBox();
    budgetTop = box?.y ?? -1;
    scrollAfter = await page.evaluate(() => document.querySelector("main").scrollTop);
    const viewport = await page.evaluate(() => document.querySelector("main").clientHeight);
    if (budgetTop >= 0 && budgetTop < viewport) break;
  }
  const viewportH = await page.evaluate(() => document.querySelector("main").clientHeight);
  chk("SectionNav 'Budget' scrolls the page (scrollTop increased)", scrollAfter > scrollBefore, `${scrollBefore} → ${scrollAfter}`);
  chk("SectionNav 'Budget' brings the Budget panel into view", budgetTop >= 0 && budgetTop < viewportH, `top ${budgetTop}, viewport ${viewportH}`);

  await page.getByRole("button", { name: "Previous cycle" }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Next cycle" }).first().click();
  await page.waitForTimeout(500);
  chk("cycle nav round-trips without error", errsOf(logs).length === 0, errsOf(logs).slice(0, 3).join(" || "));

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
  chk("mobile 390px: no horizontal overflow", o.sw <= o.cw + 1 && o.mw <= 1, JSON.stringify(o));
  await h.shot(page, "mcux-390-light");
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});
