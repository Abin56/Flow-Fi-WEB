/**
 * People → Record payment → Remaining money: the notice card under the receipt and the right-side drawer INSIDE the
 * Record Payment sheet. UI-only: nothing is recorded (the drawer never submits). Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const box = async (loc) => {
  const b = await loc.boundingBox();
  return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
};

for (const [id, vp, scheme] of [
  ["rmd-desktop-light", { width: 1366, height: 900 }, "light"],
  ["rmd-mobile-light", { width: 390, height: 844 }, "light"],
  ["rmd-desktop-dark", { width: 1366, height: 900 }, "dark"],
]) {
  scenario(
    id,
    `Remaining money drawer (${id.replace("rmd-", "")}): card under receipt, in-sheet right drawer, back keeps values`,
    async ({ page }, chk) => {
      const mobile = vp.width < 640;
      await f.openPerson(page, "QA Priya");
      await f.openRecord(page);
      await f.amountField(page).fill("1500");
      await page.waitForTimeout(500);
      if (mobile) {
        // Paged sheet: the card lives on the Finish page.
        for (let i = 0; i < 2; i++) {
          await page.getByTestId("rp-step-next").click();
          await page.waitForTimeout(450);
        }
      }

      const card = page.getByTestId("rp-remaining-collapse");
      const sheet = page.getByTestId("payment-sheet");
      const drawer = page.getByTestId("rp-remaining-popup");
      chk("notice card shows when money is left over", (await card.count()) === 1 && (await card.isVisible()));
      chk("card states amount + 'left to use'", /left to use/.test(await card.innerText()), (await card.innerText()).replace(/\s+/g, " ").slice(0, 120));
      chk("no separate Remaining money section elsewhere", (await page.locator("#rp-remaining-heading").count()) === 1);
      if (!mobile) {
        const r = await box(page.getByTestId("rp-receipt"));
        const c = await box(card);
        chk("card sits directly under the receipt card on the right", !!r && !!c && c.y >= r.y + r.h && c.y - (r.y + r.h) < 40 && Math.abs(c.x - r.x) < 4 && c.x > vp.width / 2, JSON.stringify({ r, c }));
      }
      chk("drawer is closed (hidden) to start", !(await drawer.isVisible()));
      await h.shot(page, `${id}-01-card`);

      const urlBefore = page.url();
      const dialogsBefore = await page.getByRole("dialog").count();
      // Click the card body (not the button) — the whole card opens the drawer.
      const cb = await card.boundingBox();
      await page.mouse.click(cb.x + 24, cb.y + cb.height - 10);
      await page.waitForTimeout(120);
      const midX = await drawer.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
      chk("drawer slides in from the right (mid-animation offset > 0)", midX > 1, `translateX≈${Math.round(midX)}`);
      await h.shot(page, `${id}-02-sliding`);
      await page.waitForTimeout(600);
      chk("drawer open", (await drawer.getAttribute("data-state")) === "open" && (await drawer.isVisible()));
      const s = await box(sheet);
      const d = await box(drawer);
      chk("drawer covers the whole Record Payment sheet", !!s && !!d && Math.abs(s.x - d.x) <= 1 && Math.abs(s.y - d.y) <= 1 && Math.abs(s.w - d.w) <= 1 && Math.abs(s.h - d.h) <= 1, JSON.stringify({ s, d }));
      chk("no extra dialog level (still one dialog)", (await page.getByRole("dialog").count()) === dialogsBefore, `${dialogsBefore} → ${await page.getByRole("dialog").count()}`);
      chk("no navigation / URL change", page.url() === urlBefore);
      chk("focus moved to Back", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "rp-remaining-back"));
      chk("status shown once in the drawer", (await page.getByTestId("rp-left-status").count()) === 1 && /All assigned|not yet assigned/.test(await page.getByTestId("rp-left-status").innerText()));
      const overflow = await drawer.evaluate((el) => el.scrollWidth - el.clientWidth);
      chk("no horizontal overflow inside the drawer", overflow <= 1, String(overflow));
      await h.shot(page, `${id}-03-open`);

      // Escape closes only the drawer — the sheet stays with its values.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(550);
      chk("Escape closes the drawer only", !(await drawer.isVisible()) && (await sheet.isVisible()));
      chk("focus returns to the card's button", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "rp-remaining-toggle"));

      // Change the use inside the drawer, come back with Back: the choice and the amount survive.
      await page.getByTestId("rp-remaining-toggle").click();
      await page.waitForTimeout(550);
      const asIncome = page.getByRole("button", { name: "Add as income" });
      if ((await asIncome.count()) > 0) {
        await asIncome.click();
        await page.waitForTimeout(300);
        await h.shot(page, `${id}-04-income`);
        await page.getByTestId("rp-remaining-back").click();
        await page.waitForTimeout(550);
        chk("choice kept after Back (card shows Income)", /Income/.test(await card.innerText()));
        chk("card asks to Finish while the income category is missing", /Finish/.test(await page.getByTestId("rp-remaining-toggle").innerText()));
        await h.shot(page, `${id}-05-back-finish`);
      } else {
        chk("'Add as income' offered (received money, all on advance)", false);
      }
      if (mobile) {
        // Back to page 1 to read the amount.
        await page.getByRole("button", { name: /^Back$/ }).last().click();
        await page.waitForTimeout(400);
        await page.getByRole("button", { name: /^Back$/ }).last().click();
        await page.waitForTimeout(400);
      }
      chk("amount still 1500 (nothing reset)", (await f.amountField(page).inputValue()).replace(/[^\d.]/g, "") === "1500", await f.amountField(page).inputValue());
      chk("sheet still open — nothing submitted", await sheet.isVisible());
    },
    { viewport: vp, scheme },
  );
}
