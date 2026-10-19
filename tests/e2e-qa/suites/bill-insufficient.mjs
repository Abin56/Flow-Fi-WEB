/**
 * Browser QA scenarios (bill-insufficient.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);

scenario("bill-insufficient", "Bills: ₹1,500 bill paid from QA Cash holding only ₹1,000 — insufficient funds", async ({ page }, chk) => {
  // Fixture step via the app's own Add Expense form: spend ₹4,000 of the ₹5,000 cash.
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await page.getByText("Add Expense", { exact: true }).first().waitFor();
  await page.getByText(/^Account\s?\*$/).first().locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: /QA Cash/ }).first().click();
  await page.locator('input[placeholder="0.00"]').first().fill("4000");
  await page.locator('input[placeholder^="e.g."]').first().fill("QA cash spend");
  await page.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  const cashBefore = await bal("QA Cash");

  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /QA Electricity/ }).click();
  await page.getByRole("button", { name: "Pay…" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: /Pay from my account now/ }).click();
  await page.waitForTimeout(500);
  await dlg.getByRole("combobox").click().catch(async () => { await dlg.getByText(/QA Bank · /).click(); });
  await page.getByRole("option", { name: /QA Cash/ }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "bill-insufficient-form");
  const txt = (await dlg.innerText()).split("\n").join(" | ");
  const pay = dlg.getByRole("button", { name: /Pay now/ });
  const warn = txt.match(/[^|]*(not enough|enough balance|insufficient|short by|exceeds)[^|]*/i);
  chk("fixture: QA Cash holds ₹1,000 and the bill is ₹1,500", cashBefore === 1000 && /1,500/.test(txt), `cash ${cashBefore}`);
  chk("user is told why payment can't proceed (insufficient-funds message)", !!warn, warn ? warn[0].trim() : "NO insufficient-funds message; Pay now disabled=" + (await pay.isDisabled()));
  chk("Pay now is disabled or blocked", await pay.isDisabled());
  await page.evaluate(() => window.__reset());
  await pay.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const bodyAfter = (await page.locator("body").innerText()).split("\n").join(" | ");
  chk("payment is NOT recorded: cash unchanged, no commit (persisted)", (await bal("QA Cash")) === cashBefore && (await commits(page)) === 0, `${cashBefore} -> ${await bal("QA Cash")}; commits ${await commits(page)}; after force-click: ${(bodyAfter.match(/[^|]*(not enough|insufficient|short by)[^|]*/i) || ["no message"])[0].trim()}`);
});

