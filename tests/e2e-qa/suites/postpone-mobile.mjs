/**
 * Browser QA scenarios (postpone-mobile.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * The People "Postpone payment" panel on a 390×844 phone: the cycle cards, the Selected line, the revealed "What about this
 * EMI?" section and each expanded choice must fit the screen (nothing wider than the phone, no page overflow), and the
 * in-panel "Pay from my account" must still pay the bank EMI exactly once. Money claims are read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";
import { priyaDeferral } from "./postpone-exact-date.mjs";

const SHARED = "QA Shared EMI";
const PHONE = { viewport: { width: 390, height: 844 } };

const noOverflow = async (page, chk, what) => {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk(`${what}: no horizontal page overflow`, o <= 1, `${o}px`);
};
async function fitsScreen(page, locator, chk, what) {
  const b = await locator.boundingBox();
  chk(`${what}: fits inside the phone screen`, b != null && b.x >= -0.5 && b.x + b.width <= 390.5, b ? `x=${Math.round(b.x)} w=${Math.round(b.width)}` : "not visible");
}

/** The row's expansion on a phone is a list, not a table — open the EMI share row, then its Postpone panel. */
async function openShareOnPhone(page) {
  await f.openPerson(page, "QA Priya");
  const row = page.locator("li[data-obligation-key]").filter({ hasText: /EMI share/ }).first();
  await row.locator("button").first().click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /postpone payment/i }).first().click();
  const group = page.getByRole("group", { name: "Postpone payment" });
  await group.waitFor();
  return group;
}

scenario("ppm-panel-fits", "Mobile: the one-panel postpone flow fits a 390px phone in every state (cycles, Custom date, each EMI choice)", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const group = await openShareOnPhone(page);
  await fitsScreen(page, group, chk, "panel");
  await noOverflow(page, chk, "panel");
  await fitsScreen(page, group.getByRole("radiogroup", { name: "Expected cycle" }), chk, "cycle cards");
  await h.shot(page, "ppm-panel");
  await group.getByRole("button", { name: "Custom date" }).click();
  await fitsScreen(page, group.getByLabel("Postpone until date"), chk, "custom date field");
  await group.getByRole("button", { name: "Use the cycle date instead" }).click();
  for (const choice of ["payNow", "paidEarlier", "pending"]) {
    await group.getByTestId(`emi-handling-${choice}`).click();
    await page.waitForTimeout(250);
    await fitsScreen(page, group.getByTestId("emi-handling"), chk, `EMI section (${choice})`);
    await noOverflow(page, chk, `EMI choice ${choice}`);
  }
  await h.shot(page, "ppm-emi-choices");
  chk("nothing was written by exploring the panel", (await priyaDeferral()) == null);
  return await h.timeline(page);
}, PHONE);

scenario("ppm-pay-in-panel", "Mobile: 'Pay from my account' inside the panel — balance preview shown, bank EMI paid exactly once, postponement saved", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const txBefore = (await h.list("transactions")).length;
  const group = await openShareOnPhone(page);
  await group.getByTestId("emi-handling-payNow").click();
  await group.getByRole("combobox", { name: "Pay the EMI from account" }).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(500);
  const summary = group.getByTestId("payment-source-summary");
  await summary.scrollIntoViewIfNeeded();
  chk("balance, EMI and balance-after are shown", /After payment/i.test(await summary.innerText()) && /₹3,000/.test(await summary.innerText()));
  await fitsScreen(page, summary, chk, "balance preview");
  await noOverflow(page, chk, "pay choice");
  const confirm = group.getByTestId("postpone-emi-confirm");
  await confirm.scrollIntoViewIfNeeded();
  await fitsScreen(page, confirm, chk, "confirm button");
  await h.shot(page, "ppm-pay");
  await page.evaluate(() => window.__reset());
  await confirm.click();
  await group.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(3000);
  chk("the postponement was saved", (await priyaDeferral())?.state === "active");
  chk("the bank EMI is paid once (persisted)", f.paidTotal(await f.scheduleState("emi", SHARED)) === 3000);
  chk("the bank was debited exactly ₹3,000 once", f.close2(bank0 - (await f.bal("QA Bank")), 3000), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk("exactly one transaction was created", (await h.list("transactions")).length - txBefore === 1);
  return await h.timeline(page);
}, PHONE);
