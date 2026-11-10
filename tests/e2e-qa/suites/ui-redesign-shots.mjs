/** Screenshot sweep of the main screens (desktop / tablet / phone) for the UI redesign review. Read-only; local emulator only. */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const PAGES = ["dashboard", "transactions", "accounts", "people", "loans", "bills", "settings"];
for (const [id, vp] of [["uir-desktop", { width: 1440, height: 900 }], ["uir-tablet", { width: 820, height: 1100 }], ["uir-phone", { width: 390, height: 844 }]]) {
  scenario(id, `Screenshot sweep ${id}`, async ({ page }, chk) => {
    for (const p of PAGES) {
      await h.go(page, `/${p}`);
      await page.waitForTimeout(1800);
      await h.shot(page, `${id}-${p}`);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      chk(`${p}: no horizontal page overflow`, o <= 1, `${o}px`);
    }
  }, { viewport: vp });
}
