/** People → Record payment: screenshots of the sheet (wide = one workspace, narrow = pages) + how much scrolling it needs (prs-*). Local emulator only; nothing is saved. */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const scrollInfo = (page) =>
  page.evaluate(() => {
    const form = document.querySelector("form[aria-label^='Record payment']");
    let n = form;
    while (n && !(n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
    return n ? { scroll: n.scrollHeight, client: n.clientHeight } : { scroll: 0, client: 0 };
  });

for (const [id, vp, scheme, wide] of [
  ["prs-desktop", { width: 1440, height: 900 }, "light", true],
  ["prs-desktop-dark", { width: 1440, height: 900 }, "dark", true],
  ["prs-tablet", { width: 820, height: 1100 }, "light", false],
  ["prs-phone", { width: 390, height: 844 }, "light", false],
]) {
  scenario(id, `People Record payment (${id})`, async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await f.openPerson(page, "QA Priya");
    await f.openRecord(page);
    await page.waitForTimeout(900);
    await h.shot(page, `${id}-1-initial`);
    const sc = await scrollInfo(page);
    console.log(id, "initial scroll", JSON.stringify(sc));
    chk(wide ? "wide sheet shows the workspace (no step pages)" : "narrow sheet pages", wide ? (await page.getByTestId("rp-workspace").count()) === 1 && (await page.getByTestId("rp-step-next").count()) === 0 : (await page.getByTestId("rp-step-next").count()) === 1);
    if (wide) {
      chk("wide sheet (2 items) needs at most a ~30px nudge, no pages", sc.scroll <= sc.client + 40, `${sc.scroll} vs ${sc.client}`);
      try {
        await page.getByLabel(/Amount received/i).first().fill("1000");
        await page.waitForTimeout(400);
        await page.getByRole("radio", { name: /Choose specific items/i }).click();
        await page.waitForTimeout(600);
        await h.shot(page, `${id}-2-items`);
        console.log(id, "items scroll", JSON.stringify(await scrollInfo(page)));
      } catch (e) {
        console.log("items step skipped:", String(e).slice(0, 120));
      }
      for (const [name, re] of [["paid", /Money paid to/], ["postpone", /Not paid yet/]]) {
        try {
          await page.getByRole("radio", { name: re }).click();
          await page.waitForTimeout(700);
          await h.shot(page, `${id}-3-${name}`);
          console.log(id, name, "scroll", JSON.stringify(await scrollInfo(page)));
        } catch (e) {
          console.log(name, "view skipped:", String(e).slice(0, 120));
        }
      }
    }
  }, { viewport: vp, scheme });
}

scenario("prs-person", "People person page: the settlement summary card (screenshot)", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya");
  await page.waitForTimeout(1200);
  await h.shot(page, "prs-person-1-summary");
  chk("summary captured", true);
}, { viewport: { width: 1687, height: 700 }, scheme: "light" });

scenario("prs-add", "People Add transaction sheet (screenshots)", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya");
  await page.getByRole("button", { name: /^Add$/ }).first().click();
  await page.getByRole("radiogroup", { name: "Transaction type" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  await h.shot(page, "prs-add-1-empty");
  await page.getByRole("radio", { name: "Money I Gave" }).click();
  await page.getByLabel("Amount").first().fill("2500");
  await page.waitForTimeout(500);
  await h.shot(page, "prs-add-2-filled");
  chk("add sheet captured", true);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("prs-split", "People Split expense popup: starts small, opens when a total is typed (screenshots)", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya");
  await page.getByRole("button", { name: /^Split$/ }).first().click();
  await page.getByText("Split expense", { exact: false }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await h.shot(page, "prs-split-1-empty");
  await page.getByLabel(/Total amount/i).first().fill("900");
  await page.waitForTimeout(700);
  await h.shot(page, "prs-split-2-filled");
  chk("split captured", true);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
