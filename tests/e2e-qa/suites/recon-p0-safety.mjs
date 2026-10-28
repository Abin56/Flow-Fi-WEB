/**
 * Reconciliation P0 safety — real browser, local emulator, synthetic QA data only.
 * A QA Bank statement with a credit card bill payment, a payment naming the user's own card (•••• 4242), a CRED payment,
 * a rent NEFT and a POS purchase. The internal payments can't be imported (blocked with the reason, Import disabled);
 * the rent NEFT needs the explicit "not to my own account or card" confirmation; the approval imports exactly the two
 * genuine expenses and the bank balance moves by exactly their total.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const STATEMENT = [
  `${ddmmyyyy(-2)}\tCREDIT CARD PAYMENT HDFC BANK\t5,000.00 Dr`,
  `${ddmmyyyy(-2)}\tNEFT TO CARD XX4242 BILL\t3,000.00 Dr`,
  `${ddmmyyyy(-2)}\tUPI/CRED/cred.club@axisb/payment\t2,500.00 Dr`,
  `${ddmmyyyy(-2)}\tNEFT-RENT-MR SHARMA OCT\t18,000.00 Dr`,
  `${ddmmyyyy(-2)}\tPOS AMAZON RETAIL\t999.00 Dr`,
].join("\n");

const rowLoc = (page, id) => page.locator(`[data-testid="recon-row"][data-row-id="${id}"]`);

scenario("recon-p0-bank-internal-payments", "P0: bank-side card payments / own card / CRED are blocked, rent NEFT needs the own-account confirmation, approval writes only genuine expenses", async ({ page }, chk) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const bankBefore = (await h.list("accounts")).find((a) => a.name === "QA Bank");
  const txnsBefore = (await h.list("transactions")).length;
  const expense = (await h.list("categories")).find((c) => c.type === "expense" || c.type === "both")?.name;

  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(STATEMENT);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /^QA Bank/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.waitForTimeout(500);

  // ---- internal payments: Import / Keep both unavailable, reason shown ----
  for (const [id, label, reason] of [
    ["r1", "credit card bill payment", /credit card bill payment/],
    ["r2", "own card named by last four", /your own card QA Credit Card \(•••• 4242\)/],
    ["r3", "CRED payment", /credit card bill payment \(or CRED/],
  ]) {
    await rowLoc(page, id).click();
    await page.waitForTimeout(150);
    chk(`${label}: Import new disabled`, await page.getByTestId("resolve-import_new").isDisabled());
    const blocked = await page.getByTestId("dock-import-blocked").getAttribute("title");
    chk(`${label}: the reason is shown`, reason.test(blocked ?? ""), blocked);
    await page.getByRole("grid", { name: "Statement rows" }).focus();
    await page.keyboard.press("n"); // shortcut must not bypass the block
    await page.waitForTimeout(150);
    chk(`${label}: the N shortcut can't import it`, (await page.getByTestId("import-confirm").count()) === 0 && /Undecided/.test(await rowLoc(page, id).innerText()));
    if (id === "r1") await h.shot(page, "p0-blocked-card-payment");
    await page.getByTestId("resolve-skip").click();
  }

  // ---- rent NEFT: importable only with the explicit confirmation ----
  await rowLoc(page, "r4").click();
  chk("rent NEFT: Import new is available", !(await page.getByTestId("resolve-import_new").isDisabled()));
  await page.getByTestId("resolve-import_new").click();
  const pop = page.getByTestId("import-confirm");
  await pop.waitFor();
  chk("rent NEFT: the own-account confirmation is asked", (await pop.getByTestId("own-transfer-confirm").count()) === 1);
  await pop.getByLabel("Category for import").selectOption(expense);
  chk("…submit stays disabled until it is ticked", await pop.getByTestId("import-confirm-submit").isDisabled());
  await h.shot(page, "p0-rent-confirm");
  await pop.getByRole("checkbox", { name: /Not a transfer to \(or from\) my own account or card/ }).click();
  chk("…ticked → submit enabled", !(await pop.getByTestId("import-confirm-submit").isDisabled()));
  await pop.getByTestId("import-confirm-submit").click();
  chk("rent NEFT decided Import new", /Import new/.test(await rowLoc(page, "r4").innerText()));

  // ---- POS purchase: no confirmation needed ----
  await rowLoc(page, "r5").click();
  await page.getByTestId("resolve-import_new").click();
  await pop.waitFor();
  chk("POS purchase: no own-account confirmation", (await pop.getByTestId("own-transfer-confirm").count()) === 0);
  await pop.getByLabel("Category for import").selectOption(expense);
  await pop.getByTestId("import-confirm-submit").click();

  chk("nothing written during review", (await h.list("transactions")).length === txnsBefore);

  // ---- final approval ----
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-confirm").click();
  await dlg.getByTestId("approval-submit").click();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  await h.shot(page, "p0-approval-result");
  const after = await h.list("transactions");
  const created = after.filter((t) => !t.deletedAt).length - txnsBefore;
  chk("exactly the two genuine expenses were imported", created === 2, created);
  chk("no internal payment became a transaction", !after.some((t) => /CREDIT CARD PAYMENT|XX4242|CRED/.test(t.description ?? "")));
  const bankAfter = (await h.list("accounts")).find((a) => a.name === "QA Bank");
  chk("QA Bank balance moved by exactly 18,999", Math.abs(bankBefore.currentBalance - 18999 - bankAfter.currentBalance) < 0.005, `${bankBefore.currentBalance} → ${bankAfter.currentBalance}`);
});
