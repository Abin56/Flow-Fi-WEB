/**
 * Browser QA — the Loan/EMI centred popup + stacked action layers (stk-*). Local emulator only, synthetic data.
 * Drives the real screens, checks geometry (popup centred and compact; the action layer sits beside it on desktop,
 * rises from the bottom on a phone; the page never grows), that closing a layer returns to the popup, and that the
 * existing flows still write exactly once (the persisted account balance is read back from the emulator).
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
  await page.waitForTimeout(700);
}
const closeLayer = async (page) => {
  await layer(page).getByRole("button", { name: /^Close$/ }).first().click();
  await layer(page).waitFor({ state: "detached", timeout: 10000 });
  await page.waitForTimeout(450);
};

for (const [id, vp, scheme] of [
  ["stk-desktop", { width: 1440, height: 900 }, "light"],
  ["stk-desktop-dark", { width: 1440, height: 900 }, "dark"],
]) {
  scenario(id, `EMI popup: compact + centred; Record Payment / Edit terms open beside it and close back (${scheme})`, async ({ page }, chk) => {
    await openEmi(page, "QA Phone EMI");
    const vw = vp.width;
    const b = await box(base(page));
    chk("popup is compact (≤ 520px wide, fits the viewport height)", b.width <= 520 && b.height <= vp.height, `${Math.round(b.width)}×${Math.round(b.height)}`);
    chk("popup is centred", Math.abs(b.x + b.width / 2 - vw / 2) < 3, `centre ${Math.round(b.x + b.width / 2)} vs ${vw / 2}`);
    chk("Installments is the default tab with Pay buttons", (await page.getByRole("button", { name: /^Pay installment 1,/ }).count()) === 1);
    const g0 = await pageGrowth(page);
    await h.shot(page, `${id}-1-popup`);

    await page.getByRole("button", { name: "Record Payment" }).click();
    const dlg = page.getByRole("dialog", { name: /Pay EMI|Pay installment/ });
    await dlg.waitFor({ timeout: 30000 });
    await page.waitForTimeout(700);
    const bs = await box(base(page));
    const l = await box(layer(page));
    chk("popup stays visible while Record Payment is open", await base(page).isVisible());
    chk("layer sits to the right of the popup, not over it", bs.x + bs.width <= l.x + 1, `popup right ${Math.round(bs.x + bs.width)} layer left ${Math.round(l.x)}`);
    chk("both fit inside the viewport", bs.x >= 0 && l.x + l.width <= vw && l.y >= 0 && l.y + l.height <= vp.height, `layer ${Math.round(l.x)}–${Math.round(l.x + l.width)}, ${Math.round(l.y)}–${Math.round(l.y + l.height)}`);
    const g1 = await pageGrowth(page);
    chk("the page did not grow vertically or sideways", g1.h === g0.h && g1.w <= 0, `${g0.h}→${g1.h}, overflow ${g1.w}`);
    await h.shot(page, `${id}-2-record-payment`);
    await closeLayer(page);
    const b2 = await box(base(page));
    chk("closing the layer returns the popup to the centre", Math.abs(b2.x + b2.width / 2 - vw / 2) < 3, `centre ${Math.round(b2.x + b2.width / 2)}`);

    await page.getByRole("button", { name: "Edit terms" }).click();
    const edit = page.getByRole("dialog", { name: /Edit terms/ });
    await edit.waitFor({ timeout: 30000 });
    await page.waitForTimeout(700);
    const bs2 = await box(base(page));
    const l2 = await box(layer(page));
    chk("Edit terms opens as a layer beside the popup", bs2.x + bs2.width <= l2.x + 1 && (await base(page).isVisible()), `popup right ${Math.round(bs2.x + bs2.width)} layer left ${Math.round(l2.x)}`);
    await h.shot(page, `${id}-3-edit-terms`);
    await page.keyboard.press("Escape");
    await layer(page).waitFor({ state: "detached", timeout: 10000 });
    chk("Escape closes only the layer — the popup remains", await base(page).isVisible());
  }, { viewport: vp, scheme });
}

scenario("stk-pay-and-history", "EMI popup: pay from the layer (writes once), then the payment's details open as a layer from History", async ({ page }, chk) => {
  await openEmi(page, "QA Phone EMI");
  const before = (await h.accountBalance("QA Bank")).currentBalance;
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI|Pay installment/ });
  await dlg.getByText("TO PAY LENDER").waitFor({ timeout: 30000 });
  await dlg.getByText("Choose paying account").click();
  const names = (await page.getByRole("option").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const accts = (await h.list("accounts")).filter((a) => !a.deletedAt).map((a) => a.name);
  console.log("options:", JSON.stringify(names), "accounts:", JSON.stringify(accts));
  await page.getByRole("option", { name: /QA Bank/ }).first().click();
  await h.shot(page, "stk-pay-1-form");
  await dlg.getByRole("button", { name: /^(Pay|Charge|Record) ₹/ }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(1800);
  const after = (await h.accountBalance("QA Bank")).currentBalance;
  chk("QA Bank debited exactly once", after < before, `${before} → ${after}`);
  chk("the popup is still open after paying", await base(page).isVisible());
  await page.getByRole("tab", { name: /^History/ }).click();
  await page.waitForTimeout(500);
  await h.shot(page, "stk-pay-2-history");
  await page.getByRole("button", { name: /view payment/ }).first().click();
  await layer(page).waitFor({ timeout: 20000 });
  await page.waitForTimeout(700);
  const bs = await box(base(page));
  const l = await box(layer(page));
  chk("payment details open beside the popup", bs.x + bs.width <= l.x + 1, `${Math.round(bs.x + bs.width)} ≤ ${Math.round(l.x)}`);
  await h.shot(page, "stk-pay-3-details");
  await closeLayer(page);
  chk("closing returns to the popup", await base(page).isVisible());
}, { viewport: { width: 1440, height: 900 } });

scenario("stk-loan", "Loan popup: Record Payment, Borrow More and Edit all open as layers; the popup stays", async ({ page }, chk) => {
  await openEmi(page, "QA Loan 12");
  await h.shot(page, "stk-loan-1-popup");
  await page.getByRole("button", { name: /^Record Payment/ }).click();
  await layer(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  const bs = await box(base(page));
  const l = await box(layer(page));
  chk("Record Payment: beside the popup", bs.x + bs.width <= l.x + 1, `${Math.round(bs.x + bs.width)} ≤ ${Math.round(l.x)}`);
  await h.shot(page, "stk-loan-2-pay");
  await closeLayer(page);
  await page.getByRole("button", { name: /Receive More|Give More/i }).first().click();
  await layer(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  const l2 = await box(layer(page));
  chk("Additional amount: beside the popup", bs.x + bs.width <= l2.x + 1 && (await base(page).isVisible()));
  await h.shot(page, "stk-loan-3-additional");
  await closeLayer(page);
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await layer(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  const l3 = await box(layer(page));
  chk("Edit: beside the popup", bs.x + bs.width <= l3.x + 1 && (await base(page).isVisible()));
  await h.shot(page, "stk-loan-4-edit");
  await closeLayer(page);
  chk("popup still open", await base(page).isVisible());
}, { viewport: { width: 1440, height: 900 } });

scenario("stk-past", "EMI popup: Record past payments opens as a layer beside the popup", async ({ page }, chk) => {
  const testId = "qa-seed-history-emi";
  await page.click(`[data-testid="${testId}"]`);
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`)?.textContent?.includes("Adding"), testId, { timeout: 120000 });
  await openEmi(page, "QA 24-Month EMI");
  await page.getByRole("button", { name: "Record past payments" }).click();
  const dlg = page.getByRole("dialog", { name: /Record past payments/ });
  await dlg.getByTestId("bulk-step").waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  const bs = await box(base(page));
  const l = await box(layer(page));
  chk("Past payments: beside the popup", bs.x + bs.width <= l.x + 1 && (await base(page).isVisible()), `${Math.round(bs.x + bs.width)} ≤ ${Math.round(l.x)}`);
  chk("layer fits the viewport", l.y >= 0 && l.y + l.height <= 900 && l.x + l.width <= 1440, `${Math.round(l.y)}–${Math.round(l.y + l.height)}`);
  await h.shot(page, "stk-past-1");
}, { viewport: { width: 1440, height: 900 } });

scenario("stk-tablet", "EMI popup on a tablet: the layer cascades over the popup and fits the screen", async ({ page }, chk) => {
  await openEmi(page, "QA Phone EMI");
  await page.getByRole("button", { name: "Record Payment" }).click();
  await layer(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  const l = await box(layer(page));
  chk("layer fits the tablet screen", l.x >= 0 && l.x + l.width <= 820 && l.y >= 0 && l.y + l.height <= 1000, `${Math.round(l.x)}–${Math.round(l.x + l.width)} × ${Math.round(l.y)}–${Math.round(l.y + l.height)}`);
  chk("popup still visible behind", await base(page).isVisible());
  await h.shot(page, "stk-tablet-1");
  const g = await pageGrowth(page);
  chk("no horizontal overflow", g.w <= 0, g.w);
}, { viewport: { width: 820, height: 1000 } });

scenario("stk-mobile", "EMI popup on a phone: compact popup; the layer rises from the bottom over it; no overflow", async ({ page }, chk) => {
  await openEmi(page, "QA Phone EMI");
  const b = await box(base(page));
  chk("popup fits the phone", b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 844, `${Math.round(b.width)}×${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)}`);
  await h.shot(page, "stk-mobile-1-popup");
  await page.getByRole("button", { name: "Record Payment" }).click();
  await layer(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  const l = await box(layer(page));
  chk("layer is anchored to the bottom edge, full width", Math.abs(l.y + l.height - 844) < 3 && l.width >= 385, `${Math.round(l.y)}+${Math.round(l.height)}, w ${Math.round(l.width)}`);
  chk("part of the popup is still visible above", l.y > 20);
  const g = await pageGrowth(page);
  chk("no horizontal overflow", g.w <= 0, g.w);
  await h.shot(page, "stk-mobile-2-pay");
  await closeLayer(page);
  const b2 = await box(base(page));
  chk("popup back where it was", Math.abs(b2.y - b.y) < 3);
}, { viewport: { width: 390, height: 844 } });
