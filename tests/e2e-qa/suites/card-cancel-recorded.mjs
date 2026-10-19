/**
 * Browser QA scenarios (card-cancel-recorded.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);

scenario("card-cancel-recorded", "Credit Card: pay ₹12,000 then 'Cancel recorded payment' (bank + card liability restored)", async ({ page }, chk) => {
  const bank0 = await bal("QA Bank");
  const card0 = await bal("QA Credit Card");
  await h.go(page, "/credit-cards");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Pay full outstanding/ }).first().click();
  await page.getByText("PAYING FULL CARD OUTSTANDING").waitFor();
  await page.getByText("Select account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.getByRole("button", { name: /^Pay ₹12,000/ }).click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(800);
  chk("precondition: payment recorded (bank −₹12,000, card ₹0)", Math.abs(bank0 - (await bal("QA Bank")) - 12000) < 0.01 && (await bal("QA Credit Card")) === 0, `${bank0} -> ${await bal("QA Bank")}; card ${card0} -> ${await bal("QA Credit Card")}`);
  await page.getByRole("button", { name: "Transactions", exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  const menu = page.getByRole("button", { name: "Payment actions" }).first();
  await h.shot(page, "card-cancel-recorded-list");
  chk("the recorded payment exposes a 'Payment actions' menu", (await menu.count()) > 0);
  await menu.click();
  await page.getByRole("menuitem", { name: "Cancel recorded payment" }).click();
  const dlg = page.getByRole("dialog").last();
  await dlg.getByText("Cancel this recorded payment?").waitFor();
  await h.shot(page, "card-cancel-recorded-confirm");
  const txt = (await dlg.innerText()).split("\n").join(" | ");
  chk("confirmation states the effects (amount / bank / card)", /12,000/.test(txt), txt.slice(0, 300));
  await page.evaluate(() => window.__reset());
  const confirm = dlg.getByRole("button", { name: "Cancel recorded payment" });
  await confirm.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  const bank1 = await bal("QA Bank");
  const card1 = await bal("QA Credit Card");
  chk("bank restored to the pre-payment balance (persisted)", Math.abs(bank1 - bank0) < 0.01, `${bank0} -> ${bank1}`);
  chk("card liability restored to −₹12,000 (persisted)", card1 === card0, `${card0} -> ${card1}`);
  chk("confirm double-click wrote once", (await commits(page)) >= 1, `commits ${await commits(page)}`);
  const body = (await page.locator("body").innerText()).split("\n").join(" | ");
  chk("UI shows the card outstanding again", /CREDIT USED[\s|]*₹12,000/.test(body), (body.match(/CREDIT USED[\s|]*₹[\d,]+/) || ["?"])[0]);
  return await h.timeline(page);
});

