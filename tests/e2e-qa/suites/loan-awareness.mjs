/**
 * Browser QA — the Loan & EMI header's payment-awareness flow (lpa-*). Local emulator only, synthetic data.
 * Presentation only: the indicator must follow the open Record Payment dialog (pay / low balance / direct / recorded),
 * show the next installment while nothing is open, confirm only after a real recorded payment, never overlap the header's
 * name or buttons, never move the header, and settle (no endless animation) — including under reduced motion.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const onDetailPath = () => /^\/loans\/[^/]+\/?$/.test(location.pathname) && !location.pathname.startsWith("/loans/_");
const inline = (page) => page.locator("[data-stack-layer]");
const state = (page) => page.locator('[data-testid="payment-awareness"] [data-awareness]').first().getAttribute("data-awareness").catch(() => null);
const text = (page) => page.locator('[data-testid="payment-awareness"]').innerText().catch(() => "");

async function openLoan(page) {
  await h.go(page, "/loans");
  await page.locator('[role="button"]', { hasText: "QA Loan 12" }).first().click();
  await page.waitForFunction(onDetailPath, null, { timeout: 30000 });
  await page.locator('[data-testid="loan-page"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
}

async function pickAccount(page, layer, name) {
  await layer.getByRole("combobox", { name: "Paid from account" }).click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await page.waitForTimeout(250);
}

scenario("lpa-states", "Header awareness follows the payment dialog: next EMI → pay → low balance → paid directly → past payment → neutral on cancel; no overlap, no shift", async ({ page }, chk) => {
  await openLoan(page);
  const header = page.locator('[data-testid="loan-page"] header').first();
  const slot = page.locator('[data-testid="payment-awareness"]');
  const headerH0 = (await header.boundingBox()).height;

  chk("nothing open: the next installment is shown", (await state(page)) === "upcoming" && /Next · ₹[\d,.]+ · \d+ \w{3}/.test(await text(page)), await text(page));
  chk("a not-yet-due installment is not called overdue", !/Overdue/i.test(await text(page)));
  await h.shot(page, "lpa-1-upcoming");

  await page.getByRole("button", { name: "Record Payment" }).first().click();
  const layer = inline(page);
  await layer.waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  chk("dialog open, no account chosen: asks for an account, shows no balance", (await state(page)) === "choose" && !/₹[\d,]+ available/.test(await text(page)), await text(page));

  await pickAccount(page, layer, "QA Bank");
  chk("sufficient balance: money flows from QA Bank, no warning", (await state(page)) === "pay" && /QA Bank/.test(await text(page)) && !/Low balance/i.test(await text(page)), await text(page));
  await h.shot(page, "lpa-2-pay-bank");

  await pickAccount(page, layer, "QA Cash");
  chk("insufficient balance (QA Cash ₹5,000): low-balance warning with a shortfall", (await state(page)) === "low" && /Short by ₹[\d,.]+/.test(await text(page)), await text(page));
  await h.shot(page, "lpa-3-low-balance");

  await layer.getByRole("radio", { name: /paid directly/i }).click();
  await page.waitForTimeout(400);
  chk("paid directly: no bank warning, account unchanged", (await state(page)) === "direct" && !/Low balance|Short by/i.test(await text(page)) && /My account unchanged/.test(await text(page)), await text(page));
  await h.shot(page, "lpa-4-paid-directly");

  await layer.getByRole("radio", { name: /Past payment/ }).click();
  await page.waitForTimeout(500);
  chk("past payment: already recorded, no new debit", (await state(page)) === "recorded" && /No new debit/.test(await text(page)), await text(page));
  await h.shot(page, "lpa-5-recorded");

  // Geometry at the busiest moment.
  const a = await slot.boundingBox();
  const left = await header.locator("h1").boundingBox();
  const right = await page.locator('[data-testid="agreement-actions"]').boundingBox();
  const overlap = (p, q) => !!p && !!q && p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
  chk("the indicator does not overlap the loan name or the action buttons", !overlap(a, left) && !overlap(a, right), JSON.stringify({ a, left, right }));
  chk("the header never changed height across states", Math.abs((await header.boundingBox()).height - headerH0) <= 1, `${headerH0} → ${(await header.boundingBox()).height}`);

  await layer.getByRole("button", { name: "Back", exact: true }).first().click();
  await layer.waitFor({ state: "detached", timeout: 10000 });
  await page.waitForTimeout(400);
  chk("cancelling the dialog returns the header to the neutral next-installment state", (await state(page)) === "upcoming", String(await state(page)));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("no horizontal overflow", overflow <= 1, `${overflow}px`);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("lpa-complete-and-motion", "Confirmation only after a real recorded payment; the coin animation settles; reduced motion removes the motion", async ({ page }, chk) => {
  await openLoan(page);
  await page.getByRole("button", { name: "Record Payment" }).first().click();
  const layer = inline(page);
  await layer.waitFor({ timeout: 30000 });
  await pickAccount(page, layer, "QA Bank");
  chk("before saving there is no confirmation", (await state(page)) === "pay" && !/recorded/i.test(await text(page)));

  // Motion settles: the coin runs a finite number of times.
  const finite = await page.evaluate(() => {
    const coin = document.querySelector('[data-testid="payment-awareness"] [class*="pa-coin"]');
    return coin ? getComputedStyle(coin).animationIterationCount : null;
  });
  chk("the travelling coin runs a fixed number of times (not infinite)", finite != null && finite !== "infinite", String(finite));

  await layer.getByRole("button", { name: /^Pay ₹[\d,.]+ to lender$/ }).click();
  const gotDone = await page.waitForFunction(() => document.querySelector('[data-testid="payment-awareness"] [data-awareness="done"]'), null, { timeout: 30000 }).then(() => true).catch(() => false);
  chk("after the real payment succeeds the header confirms it", gotDone && /Payment recorded/.test(await text(page)), await text(page));
  await h.shot(page, "lpa-6-done");
  await page.waitForTimeout(6000);
  chk("the confirmation clears by itself", (await state(page)) !== "done", String(await state(page)));

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Record Payment" }).first().click();
  await inline(page).waitFor({ timeout: 30000 });
  await pickAccount(page, inline(page), "QA Bank");
  const dur = await page.evaluate(() => {
    const coin = document.querySelector('[data-testid="payment-awareness"] [class*="pa-coin"]');
    return coin ? parseFloat(getComputedStyle(coin).animationDuration) : null;
  });
  chk("reduced motion: the coin animation collapses to ~0s, the text still states the flow", dur != null && dur < 0.05 && /QA Bank/.test(await text(page)), `${dur}s`);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
