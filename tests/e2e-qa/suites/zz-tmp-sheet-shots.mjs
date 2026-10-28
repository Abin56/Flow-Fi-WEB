// TEMPORARY — screenshot-only scenario for the Card activity sheet redesign. Delete after use.
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const goTo = async (page, href) => {
  await page.evaluate((x) => window.next.router.push(x), href);
  for (let i = 0; i < 120; i++) { if ((await page.evaluate(() => location.pathname)).replace(/[/]$/, "") === href) return; await page.waitForTimeout(250); }
};

for (const scheme of ["light", "dark"]) {
  scenario(`zzsheet-${scheme}`, `Card activity sheet screenshots (${scheme})`, async ({ page }, chk) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((s) => { document.documentElement.classList.toggle("dark", s === "dark"); try { localStorage.setItem("theme", s); } catch {} }, scheme);
    await goTo(page, "/credit-cards");
    await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
    await page.waitForTimeout(3000);
    await h.shot(page, `zzsheet-${scheme}-0-page`);
    const tile = page.locator("main [role=button], main article").first();
    const sheet = page.getByRole("dialog", { name: "Card activity" });
    await page.getByRole("button", { name: /^Bills/ }).first().click();
    await sheet.waitFor();
    await page.waitForTimeout(1200);
    await h.shot(page, `zzsheet-${scheme}-1-bills`);
    for (const t of ["Transactions", "Spending"]) {
      await sheet.getByRole("tab", { name: new RegExp(t) }).click();
      await page.waitForTimeout(1200);
      await h.shot(page, `zzsheet-${scheme}-2-${t.toLowerCase()}`);
    }
    await sheet.getByRole("tab", { name: /Bills/ }).click();
    await sheet.getByRole("radio", { name: /All cards/ }).click();
    await page.waitForTimeout(1200);
    await h.shot(page, `zzsheet-${scheme}-3-bills-all`);
    chk("sheet opened", (await sheet.count()) === 1, "");
    void tile;
  });
}
