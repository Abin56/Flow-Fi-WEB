/**
 * My Money compact redesign (UI-only) — density, layout and themes on synthetic emulator data. Read-only.
 *   npm run test:e2e-qa -- mmux- --copy
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

async function open(page) {
  await h.go(page, "/my-money");
  await page.getByRole("heading", { level: 1, name: "My Money" }).waitFor({ timeout: 60000 });
  await page.waitForSelector('[aria-label="Period summary"]', { timeout: 60000 });
  await page.waitForTimeout(2500);
}

const errsOf = (logs) => logs.filter((l) => !/Select is changing|status of 400|React DevTools|Download the React/.test(l));

for (const [w, hgt] of [
  [1440, 900],
  [1920, 1080],
]) {
  scenario(`mmux-layout-${w}`, `My Money redesign at ${w}×${hgt}: compact summary + one-line payment rows; light/dark`, async ({ page, logs }, chk, notes) => {
    await page.setViewportSize({ width: w, height: hgt });
    await h.addFixture(page, "shared-emi");
    await open(page);
    const m = await page.evaluate(() => {
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const summary = r(document.querySelector('[aria-label="Period summary"]'));
      const pay = document.querySelector("#mm-to-pay-section");
      const rows = [...(pay?.querySelectorAll("li.group\\/row") ?? [])].map((li) => {
        const line = li.firstElementChild.getBoundingClientRect();
        return Math.round(line.height);
      });
      const collect = r(document.querySelector("#mm-collect-section"));
      return { summaryH: summary && Math.round(summary.height), rows, payTop: pay && Math.round(r(pay).top), collectTop: collect && Math.round(collect.top) };
    });
    notes.push(JSON.stringify(m));
    chk("summary strip ≤ 150px tall (4 figures + Next line)", m.summaryH != null && m.summaryH <= 150, m.summaryH);
    chk("payments panel and money-to-collect start side by side", m.payTop != null && m.payTop === m.collectTop, `${m.payTop} / ${m.collectTop}`);
    chk("payments panel starts in the first screen", m.payTop != null && m.payTop < hgt * 0.5, m.payTop);
    chk("every payment row's main line is ≤ 64px (title, status, amount and action on one line)", m.rows.length > 0 && m.rows.every((x) => x <= 64), m.rows.join(","));
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
    chk("no horizontal overflow", o.sw <= o.cw + 1 && o.mw <= 1, JSON.stringify(o));
    await h.shot(page, `mmux-${w}-light`);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(700);
    await h.shot(page, `mmux-${w}-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
  });
}

scenario("mmux-interactions", "My Money redesign: expand shared breakdown, covered elsewhere and completed; row actions navigate; mobile has no overflow", async ({ page, logs }, chk) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await h.addFixture(page, "shared-emi");
  await open(page);
  const share = page.getByRole("button", { name: /Your share|Includes others' share/ }).first();
  if (await share.count()) {
    await share.click();
    await page.waitForTimeout(300);
    chk("shared breakdown expands", (await share.getAttribute("aria-expanded")) === "true");
    await h.shot(page, "mmux-shared-open");
  }
  const completed = page.getByRole("button", { name: /^Completed/ });
  if (await completed.count()) {
    const before = await completed.getAttribute("aria-expanded");
    await completed.click();
    await page.waitForTimeout(300);
    chk("Completed toggles", (await completed.getAttribute("aria-expanded")) !== before);
  }
  const action = page.locator("#mm-to-pay-section li a").first();
  if (await action.count()) {
    const href = await action.getAttribute("href");
    await action.click();
    const want = href.split("?")[0].replace(/\/+$/, "");
    const ok = await page.waitForFunction((p) => location.pathname.replace(/\/+$/, "") === p, want, { timeout: 60000 }).then(() => true, () => false);
    chk(`row action opens ${want}`, ok, await page.evaluate(() => location.pathname));
  } else chk("payments list has a row action (seed)", false, "none");
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
  chk("mobile 390px: no horizontal overflow", o.sw <= o.cw + 1 && o.mw <= 1, JSON.stringify(o));
  await h.shot(page, "mmux-390-light");
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});
