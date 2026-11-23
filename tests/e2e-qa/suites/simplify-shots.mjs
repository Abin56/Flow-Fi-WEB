/**
 * Evidence shots for the simplified History / month totals / Payments-with-people panel — synthetic emulator data only.
 * Screenshots only: `npm run test:e2e-qa -- ssh- --copy`. Temporary; safe to delete.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

scenario("ssh-desktop-light", "Simplified history shots (desktop, light)", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await h.addFixture(page, "history");
  const go = async (p, ms = 7000) => {
    await page.goto(new URL(p, page.url()).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(ms);
  };

  await go("/transactions");
  await page.screenshot({ path: `${h.SHOTS_DIR}/ssh-1-transactions.png`, fullPage: false });
  chk("transactions month heading shows In/Out", (await page.getByText(/^In ₹/).count()) > 0);

  await go("/people");
  await page.screenshot({ path: `${h.SHOTS_DIR}/ssh-2-people-list.png`, fullPage: true });
  chk("Payments with people panel present", (await page.getByTestId("monthly-payment-summary").count()) > 0);

  await page.getByText("QA Priya", { exact: true }).first().click();
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `${h.SHOTS_DIR}/ssh-3-person-top.png`, fullPage: false });
  const allTab = page.getByRole("tab", { name: /All transactions/ });
  if (await allTab.count()) { await allTab.first().click(); await page.waitForTimeout(1500); }
  const list = page.getByTestId("money-in-out-list");
  if (await list.count()) {
    await list.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${h.SHOTS_DIR}/ssh-4-person-money-list.png`, fullPage: false });
  }
  chk("person history shows the Money in & out list", (await list.count()) > 0);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
