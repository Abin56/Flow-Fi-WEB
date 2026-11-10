/**
 * Browser QA — the Loan/EMI workspace window (ew-*). Local emulator only, synthetic data.
 * The details window is one wide window (summary rail + schedule); Record Payment / Past payment / Pay several are pages of
 * ONE sheet that takes exactly the window's footprint, with a Back button; a shared EMI's people each have two real buttons.
 * Screenshots land in the QA results folder; geometry and "one sheet, never a second one" are asserted.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const box = async (loc) => (await loc.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
const base = (page) => page.locator("[data-stack-base]");
const layer = (page) => page.locator("[data-stack-layer]");
const pageGrowth = (page) => page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth - document.documentElement.clientWidth }));

async function openEmi(page, name) {
  await h.go(page, "/loans-installments");
  await page.getByText(name).first().click();
  await base(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
}

for (const [id, vp, scheme] of [
  ["ew-desktop", { width: 1440, height: 900 }, "light"],
  ["ew-desktop-dark", { width: 1440, height: 900 }, "dark"],
  ["ew-tablet", { width: 820, height: 1100 }, "light"],
  ["ew-phone", { width: 390, height: 844 }, "light"],
]) {
  scenario(id, `EMI workspace: one window; payment pages swap inside one sheet; Back returns (${id})`, async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await openEmi(page, "QA Shared EMI");
    const wide = vp.width >= 900;
    const b = await box(base(page));
    chk("window fits the viewport", b.width <= vp.width && b.height <= vp.height + 1, `${Math.round(b.width)}×${Math.round(b.height)}`);
    if (wide) {
      chk("window is wide (a real workspace, ≥ 880px)", b.width >= 880, `${Math.round(b.width)}px`);
      const rail = await box(page.getByRole("complementary", { name: "Summary" }));
      chk("summary rail sits beside the schedule", rail.width > 250 && rail.width < 380 && rail.x < b.x + 40, `rail ${Math.round(rail.width)}px`);
    }
    const g0 = await pageGrowth(page);
    await h.shot(page, `${id}-1-window`);
    for (const tab of ["Upcoming", "All", "History"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).first().click();
      await page.waitForTimeout(250);
    }
    await h.shot(page, `${id}-2-history`);
    await page.getByRole("tab", { name: /^Upcoming/ }).first().click();

    await page.getByRole("button", { name: "Record Payment" }).click();
    await layer(page).waitFor({ timeout: 30000 });
    await page.getByText(/TO PAY LENDER/i).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(700);
    const l = await box(layer(page));
    if (wide) chk("the payment sheet takes exactly the window's footprint", Math.abs(l.x - b.x) < 24 && Math.abs(l.width - b.width) < 24 && Math.abs(l.height - b.height) < 24, `window ${Math.round(b.width)}×${Math.round(b.height)} sheet ${Math.round(l.width)}×${Math.round(l.height)}`);
    chk("there is a Back button", (await layer(page).getByRole("button", { name: "Back" }).count()) === 1);
    chk("only one sheet is open", (await layer(page).count()) === 1);
    const g1 = await pageGrowth(page);
    chk("the page did not grow", g1.h === g0.h && g1.w <= 0, `${g0.h}→${g1.h}, overflow ${g1.w}`);
    await h.shot(page, `${id}-3-pay`);

    // Each person has two real, labelled buttons; they open their form right under the list.
    const recv = layer(page).getByRole("button", { name: /Record money received from .* here/ }).first();
    const post = layer(page).getByRole("button", { name: /^Postpone .* share here$/ }).first();
    chk("each person has a 'Record received' and a 'Postpone' button", (await recv.count()) === 1 && (await post.count()) === 1);
    const rb = await box(recv);
    chk("the two buttons are tappable (≥ 36px tall)", rb.height >= 36, `${Math.round(rb.height)}px`);
    await post.click();
    await page.waitForTimeout(500);
    await h.shot(page, `${id}-4-postpone`);
    await recv.click();
    await page.waitForTimeout(500);
    await h.shot(page, `${id}-5-received`);

    // Past payment / Pay several are pages of the SAME sheet: no second sheet, the switch stays, Pay now is one tap back.
    await layer(page).getByRole("radio", { name: /Past payment/ }).click();
    await page.getByText(/Step 1 of/).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    chk("Past payment replaces the page in place (still one sheet)", (await layer(page).count()) === 1);
    chk("the switch is still pinned", (await layer(page).getByRole("radio", { name: /Pay now/ }).count()) === 1);
    await h.shot(page, `${id}-6-past`);
    await layer(page).getByRole("radio", { name: /Pay several/ }).click();
    await page.waitForTimeout(600);
    chk("Pay several is also in place (one sheet)", (await layer(page).count()) === 1);
    await h.shot(page, `${id}-7-several`);
    await layer(page).getByRole("radio", { name: /Pay now/ }).click();
    await layer(page).getByText(/TO PAY LENDER/i).first().waitFor({ timeout: 15000 });
    chk("Pay now brings the payment page back", (await layer(page).count()) === 1);

    await layer(page).getByRole("button", { name: "Back" }).click();
    await layer(page).waitFor({ state: "detached", timeout: 10000 });
    chk("Back returns to the window exactly as it was", (await base(page).isVisible()) && (await page.getByRole("tab", { name: /^Upcoming/ }).first().getAttribute("aria-selected")) === "true");
    await h.shot(page, `${id}-8-back`);
  }, { viewport: vp, scheme });
}

// The pages that used to need a lot of scrolling: how much of each fits without scrolling inside the sheet.
const bodyScroll = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="layer-body"]');
    return el ? { scroll: el.scrollHeight, client: el.clientHeight } : { scroll: 0, client: 0 };
  });

scenario("ew-flows", "EMI workspace: pay-now (own money), past payments steps and pay several review — screenshots + how much scrolling is left", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await openEmi(page, "QA Shared EMI");
  await page.getByRole("button", { name: "Record Payment" }).click();
  await layer(page).getByText(/TO PAY LENDER/i).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  let sc = await bodyScroll(page);
  chk("Pay now (before a choice): fits without scrolling", sc.scroll <= sc.client + 2, `${sc.scroll} vs ${sc.client}`);
  await layer(page).getByRole("radio", { name: /pay the lender from my own money/i }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "ew-flows-1-own-money");
  sc = await bodyScroll(page);
  console.log("own-money page scroll", JSON.stringify(sc));
  chk("Pay now (own money chosen): at most a short scroll (< 120px)", sc.scroll - sc.client < 120, `${sc.scroll} vs ${sc.client}`);

}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

async function addHistoryEmi(page) {
  const testId = "qa-seed-history-emi";
  await page.click(`[data-testid="${testId}"]`);
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`)?.textContent?.includes("Adding"), testId, { timeout: 120000 });
}

scenario("ew-hist", "EMI workspace: Past payments (3 EMIs) and Pay several review — screenshots + scrolling left", async ({ page }, chk) => {
  await addHistoryEmi(page);
  await openEmi(page, "QA 24-Month EMI");
  await page.getByRole("button", { name: "Record past payments" }).click();
  await page.getByText(/Step 1 of/).first().waitFor({ timeout: 30000 });
  for (const n of [1, 2, 3]) await layer(page).getByRole("checkbox", { name: `#${n}`, exact: true }).click();
  await h.shot(page, "ew-hist-1-select");
  let sc = await bodyScroll(page);
  chk("Past payments · choose: fits without scrolling", sc.scroll <= sc.client + 2, `${sc.scroll} vs ${sc.client}`);
  await layer(page).getByRole("button", { name: /^Continue with/ }).click();
  await page.waitForTimeout(500);
  await layer(page).getByRole("radio", { name: /each on its due date/i }).click();
  await page.waitForTimeout(300);
  await h.shot(page, "ew-hist-2-when");
  sc = await bodyScroll(page);
  chk("Past payments · when & how much: fits without scrolling", sc.scroll <= sc.client + 2, `${sc.scroll} vs ${sc.client}`);
  await layer(page).getByRole("button", { name: /^Continue to/ }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "ew-hist-3-people");
  sc = await bodyScroll(page);
  console.log("people step scroll", JSON.stringify(sc));
  await layer(page).getByRole("radio", { name: /Pay several/ }).click();
  await page.waitForTimeout(600);
  for (const n of [1, 2, 3]) await layer(page).getByRole("checkbox", { name: `#${n}`, exact: true }).click();
  await layer(page).getByRole("button", { name: /^Review/ }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "ew-hist-4-several-review");
  sc = await bodyScroll(page);
  chk("Pay several · review: fits without scrolling", sc.scroll <= sc.client + 2, `${sc.scroll} vs ${sc.client}`);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("ew-single", "EMI workspace: one EMI past payment (how much / when on the left, people on the right) — screenshot + scrolling left", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await openEmi(page, "QA Shared EMI");
  await page.getByRole("button", { name: "Record past payments" }).click();
  await page.getByText(/Step 1 of/).first().waitFor({ timeout: 30000 });
  await layer(page).getByRole("checkbox", { name: "#1", exact: true }).click();
  await layer(page).getByRole("button", { name: /^Continue with 1/ }).click();
  await layer(page).getByText(/How much was paid/).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  await h.shot(page, "ew-single-1-form");
  const sc = await bodyScroll(page);
  console.log("single past form scroll", JSON.stringify(sc));
  chk("single past payment: fits without scrolling (≤ 40px)", sc.scroll - sc.client <= 40, `${sc.scroll} vs ${sc.client}`);
  const people = await box(layer(page).getByRole("complementary", { name: "People and effect" }));
  const left = await box(layer(page).getByText(/How much was paid/).first());
  chk("the people questions sit to the right of the amount / date", people.x > left.x + 300, `people x ${Math.round(people.x)} vs left x ${Math.round(left.x)}`);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
