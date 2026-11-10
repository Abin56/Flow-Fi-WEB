/**
 * Bills sweep (testing-phase check): the page renders, no console/page errors, no layout overflow, every button does what its
 * label says, and the forms refuse input the stored data can't represent. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();

async function openBills(page) {
  await h.go(page, "/bills");
  await page.getByRole("heading", { level: 1, name: "Bills" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
}
const bills = async () => (await h.list("bills")).filter((b) => b.deletedAt == null);

scenario("bills-sweep-render", "Bills sweep: page renders, tiles + cards + dues section present, no console errors, no overflow (4 viewports, light + dark)", async ({ page, logs }, chk) => {
  await openBills(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "bills-sweep-desktop-light");
  for (const t of ["Bills Due This Month", "Overdue", "Paid", "Upcoming", "Card, Loan & EMI Dues", "QA Electricity"]) chk(`page shows "${t}"`, main.includes(t), main.slice(0, 200));
  chk("Add Bill button present", (await page.getByRole("button", { name: "Add Bill" }).count()) >= 1);
  chk("no 'NaN' / 'undefined' / 'Infinity' / '[object' text", !/NaN|undefined|Infinity|\[object/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity|\[object).{0,30}/) || [""])[0]);
  chk("no skeleton left after load", (await page.locator('main [class*="animate-pulse"]').count()) === 0);
  chk("header count matches cards", /(\d+) bills/.test(main) && Number(/(\d+) bills/.exec(main)[1]) === (await bills()).length, /(\d+) bills/.exec(main)?.[0]);

  const overflow = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
  for (const [name, vp] of [["desktop", { width: 1920, height: 1080 }], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(vp);
      await page.waitForTimeout(700);
      const o = await overflow();
      chk(`${name} ${vp.width}px ${scheme}: no horizontal overflow`, o.doc <= 1 && o.main <= 1, JSON.stringify(o));
      await h.shot(page, `bills-sweep-${name}-${scheme}`);
    }
  }
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / warnings / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("bills-sweep-add-validation", "Bills sweep: Add Bill refuses a blank name and an incomplete due date instead of storing a nameless / 1900 bill", async ({ page, logs }, chk) => {
  await openBills(page);
  const before = (await bills()).length;
  const open = async () => {
    await page.getByRole("button", { name: "Add Bill" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Add Bill" });
    await dlg.waitFor();
    return dlg;
  };

  // 1) blank name, valid amount
  let dlg = await open();
  await dlg.getByPlaceholder("0.00").fill("500");
  await dlg.getByRole("button", { name: "Save", exact: true }).click().catch(() => {});
  await page.waitForTimeout(1500);
  const afterBlank = await bills();
  chk("blank name: no bill stored", afterBlank.length === before, afterBlank.map((b) => JSON.stringify(b.name)).join(","));
  chk("blank name: dialog stays open so the user can fix it", await dlg.isVisible());
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });
  // clean up anything a defect may have stored, so later checks stay independent
  for (const b of await bills()) if (b.name === "") await h.patchNumber(`bills/${b.id}`, "amount", b.amount);

  // 2) cleared due date
  dlg = await open();
  await dlg.getByPlaceholder("e.g. Electricity").fill("QA Water");
  await dlg.getByPlaceholder("0.00").fill("300");
  await dlg.getByPlaceholder("dd/mm/yyyy").fill("");
  await dlg.getByRole("button", { name: "Save", exact: true }).click().catch(() => {});
  await page.waitForTimeout(1500);
  const water = (await bills()).find((b) => b.name === "QA Water");
  const year = water ? new Date(water.nextDueDate).getFullYear() : null;
  chk("cleared due date: bill NOT stored with a 1900 due date", !water || year > 2000, water ? `stored nextDueDate=${water.nextDueDate}` : "not stored");
  chk("cleared due date: dialog stays open", await dlg.isVisible());
  await page.keyboard.press("Escape");

  // 3) half-typed due date
  await page.waitForTimeout(500);
  if (await page.getByRole("dialog", { name: "Add Bill" }).count()) await page.keyboard.press("Escape");
  dlg = await open();
  await dlg.getByPlaceholder("e.g. Electricity").fill("QA Gas");
  await dlg.getByPlaceholder("0.00").fill("200");
  await dlg.getByPlaceholder("dd/mm/yyyy").fill("1203");
  await dlg.getByRole("button", { name: "Save", exact: true }).click().catch(() => {});
  await page.waitForTimeout(1500);
  const gas = (await bills()).find((b) => b.name === "QA Gas");
  chk("half-typed due date: bill NOT stored with a 1900 due date", !gas || new Date(gas.nextDueDate).getFullYear() > 2000, gas ? `stored nextDueDate=${gas.nextDueDate}` : "not stored");

  // 4) the happy path still works
  if (await page.getByRole("dialog", { name: "Add Bill" }).count()) await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  dlg = await open();
  await dlg.getByPlaceholder("e.g. Electricity").fill("QA Internet");
  await dlg.getByPlaceholder("0.00").fill("999");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await dlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(1500);
  const net = (await bills()).find((b) => b.name === "QA Internet");
  chk("valid bill is stored", !!net && Number(net.amount) === 999, JSON.stringify(net && [net.name, net.amount]));
  chk("valid bill appears as a card", (await page.getByRole("button", { name: /QA Internet/ }).count()) >= 1);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("bills-sweep-pay-date", "Bills sweep: Pay dialog refuses a cleared / incomplete payment date instead of posting a 1900 debit", async ({ page, logs }, chk) => {
  await openBills(page);
  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  await page.getByRole("button", { name: "Pay…" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();

  // Account mode
  const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;
  await dlg.getByRole("button", { name: /Pay from my account now/ }).click();
  await dlg.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByPlaceholder("dd/mm/yyyy").fill("");
  const payBtn = dlg.getByRole("button", { name: /Pay now/ });
  const disabled = await payBtn.isDisabled();
  chk("account mode, cleared date: Pay now is disabled", disabled, `disabled=${disabled}`);
  chk("account mode, cleared date: the dialog says what is wrong", /valid payment date/i.test(flat(await dlg.innerText())));
  if (!disabled) await payBtn.click().catch(() => {});
  await page.waitForTimeout(1500);
  const pays = await h.list(`bills/${(await bills()).find((b) => /QA Electricity/.test(b.name)).id}/payments`);
  chk("no payment dated before year 2000 was stored", pays.every((p) => new Date(p.date).getFullYear() > 2000), pays.map((p) => p.date).join(","));
  chk("account balance unchanged by a refused payment", (await h.accountBalance("QA Bank")).currentBalance === bankBefore, `${bankBefore} → ${(await h.accountBalance("QA Bank")).currentBalance}`);

  // Earlier mode
  if (await dlg.isVisible()) {
    await dlg.getByRole("button", { name: /Already paid earlier/ }).click();
    await dlg.getByPlaceholder("dd/mm/yyyy").fill("");
    const recBtn = dlg.getByRole("button", { name: /Record as paid/ });
    const dis2 = await recBtn.isDisabled();
    chk("earlier mode, cleared date: Record as paid is disabled", dis2, `disabled=${dis2}`);
    if (!dis2) await recBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
    const pays2 = await h.list(`bills/${(await bills()).find((b) => /QA Electricity/.test(b.name)).id}/payments`);
    chk("earlier mode: no payment dated before year 2000 stored", pays2.every((p) => new Date(p.date).getFullYear() > 2000), pays2.map((p) => p.date).join(","));
  }
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});
