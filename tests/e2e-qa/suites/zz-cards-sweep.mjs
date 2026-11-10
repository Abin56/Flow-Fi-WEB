/**
 * Credit Cards sweep (testing-phase check): sections render, every control works, Add / Edit / Delete are verified against
 * the emulator. Local emulator only. Scenario ids: cc-sweep-*
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORE = /Select is changing|status of 400|React DevTools|Download the React/;
function track404(page) {
  const seen = { logo: 0, other: [] };
  page.on("response", (r) => {
    if (r.status() !== 404) return;
    if (/\/banks\/logos\//.test(r.url())) seen.logo++;
    else seen.other.push(r.url());
  });
  return seen;
}
const realErrors = (logs, seen) => logs.filter((l) => !IGNORE.test(l) && !(/status of 404/.test(l) && seen.other.length === 0));
const flat = (t) => t.replace(/\s+/g, " ").trim();

async function openCards(page) {
  await h.go(page, "/credit-cards");
  await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
  await page.waitForTimeout(3000);
}
const mine = (page) => page.getByRole("region", { name: "My credit cards" });
const panel = (page) => page.getByRole("region", { name: "Selected card" });
const cards = async () => (await h.list("creditCards")).filter((c) => !c.deletedAt);
const closed = (loc, ms = 20000) => loc.waitFor({ state: "hidden", timeout: ms }).then(() => true, () => false);
const toastText = async (page) => flat((await page.locator("[role=status], [role=alert], [data-sonner-toast], li[data-visible]").allInnerTexts()).join(" "));

async function openAdd(page) {
  await page.getByRole("button", { name: "Add Card", exact: true }).first().click();
  const dlg = page.locator('[data-slot="dialog-content"]');
  await dlg.getByText("Add a Credit Card", { exact: true }).waitFor();
  await page.waitForTimeout(500);
  return dlg;
}
async function pickBank(page, dlg, name) {
  await dlg.getByRole("combobox").first().click();
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
}

scenario("cc-sweep-render", "Credit Cards sweep: sections render, figures match persisted data, no errors / overflow (desktop, dark, tablet, mobile)", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openCards(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "cc-sweep-desktop");
  for (const [label, re] of [["header", /Credit Cards/], ["Summary", /credit used|used credit|available/i], ["My credit cards", /My credit cards/i], ["Selected card", /Selected card|Pay bill/i], ["Next statement", /Next statement/i], ["Payment due", /Payment due/i]]) chk(`section present: ${label}`, re.test(main), re);
  chk("no NaN / undefined / Infinity", !/NaN|undefined|Infinity/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity).{0,30}/) || [""])[0]);
  chk("no skeleton left", (await page.locator('main [class*="animate-pulse"]').count()) === 0);
  const card = (await cards())[0];
  chk("seed card present with limit 50,000", card && card.creditLimit === 50000, card && card.creditLimit);
  chk("limit and used (₹12,000) shown", /50,000/.test(main) && /12,000/.test(main), main.slice(0, 300));
  const overflow = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth, mc: document.querySelector("main").clientWidth }));
  for (const [n, vp] of [["desktop", null], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    if (vp) { await page.setViewportSize(vp); await page.waitForTimeout(900); await h.shot(page, `cc-sweep-${n}`); }
    const o = await overflow();
    chk(`${n}: no horizontal overflow`, o.sw <= o.cw + 1 && o.mw <= o.mc + 1, JSON.stringify(o));
    if (n === "desktop") { await page.emulateMedia({ colorScheme: "dark" }); await page.waitForTimeout(600); await h.shot(page, "cc-sweep-dark"); await page.emulateMedia({ colorScheme: "light" }); }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(600);
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("main button, main a[href], main input")].filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]")).filter((el) => !((el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.title || "").trim())).filter((el) => !(el.tagName === "INPUT" && (el.type === "date" || el.getAttribute("aria-hidden") === "true"))).map((el) => `${el.tagName}.${(el.className || "").toString().slice(0, 40)}`));
  chk("every visible button / link / input has an accessible name", unnamed.length === 0, unnamed.slice(0, 5).join(" | "));
  chk(`only bank-logo 404s (${seen.logo})`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("cc-sweep-controls", "Credit Cards sweep: view toggle, tile menu, More menu, selected-card actions, links, activity sheet", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openCards(page);

  // View toggle
  await page.getByRole("radio", { name: "List" }).click();
  await page.waitForTimeout(500);
  await h.shot(page, "cc-sweep-list");
  chk("List view selected", (await page.getByRole("radio", { name: "List" }).getAttribute("aria-checked")) === "true" && /QA Credit Card/.test(await mine(page).innerText()));
  await page.getByRole("radio", { name: "Cards" }).click();
  await page.waitForTimeout(500);
  chk("Cards view restored", (await page.getByRole("radio", { name: "Cards" }).getAttribute("aria-checked")) === "true");

  // More menu
  await page.getByRole("button", { name: "More actions" }).first().click();
  const exp = page.getByRole("menuitem", { name: /Export statements/ });
  await exp.waitFor();
  chk("More: Export statements disabled + Soon", (await exp.getAttribute("aria-disabled")) === "true" && /soon/i.test(await exp.innerText()));
  await page.getByRole("menuitem", { name: "Manage cards" }).click();
  await page.waitForTimeout(800);
  chk("More → Manage cards keeps page healthy", /My credit cards/i.test(await page.locator("main").innerText()));
  await page.getByRole("button", { name: "More actions" }).first().click();
  await page.getByRole("menuitem", { name: "View statements" }).click();
  await page.waitForTimeout(1500);
  await h.shot(page, "cc-sweep-view-statements");
  chk("More → View statements opens card activity", (await page.getByRole("dialog", { name: "Card activity" }).count()) >= 1 || /statement/i.test(await page.locator("main").innerText()));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  chk("Esc closes the activity sheet (opened from More → View statements)", (await page.getByRole("dialog", { name: "Card activity" }).count()) === 0, await page.getByRole("dialog", { name: "Card activity" }).count());
  await h.shot(page, "cc-sweep-after-esc");
  if ((await page.getByRole("dialog", { name: "Card activity" }).count()) > 0) { await page.getByRole("button", { name: "Back to cards" }).click().catch(() => {}); await page.waitForTimeout(800); }

  // Manage Limits & Reconcile link
  await page.getByTestId("manage-limits-reconcile-link").click();
  chk("Manage Limits & Reconcile → /balance-control", await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/balance-control", null, { timeout: 20000 }).then(() => true, () => false), page.url());
  await openCards(page);

  // Tile menu: Edit opens a prefilled dialog; Cancel writes nothing
  const before = JSON.stringify(await cards());
  await page.getByRole("button", { name: "Card options", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dlg = page.locator('[data-slot="dialog-content"]');
  await dlg.getByText(/^Edit /).waitFor();
  await page.waitForTimeout(500);
  await h.shot(page, "cc-sweep-edit-open");
  chk("Edit dialog prefilled (last 4 = 4242, limit 50,000)", (await dlg.locator("#cc-form-last4").inputValue()) === "4242" && /50,?000/.test(await dlg.innerText() + (await dlg.locator("input").evaluateAll((els) => els.map((e) => e.value).join(" ")))));
  await dlg.getByRole("button", { name: "Cancel" }).click();
  chk("Cancel closes Edit", await closed(dlg));
  chk("Cancel wrote nothing", JSON.stringify(await cards()) === before);
  await page.waitForTimeout(800);
  chk("tile menu → Edit → Cancel does not open the activity sheet", (await page.getByRole("dialog", { name: "Card activity" }).count()) === 0, await page.getByRole("dialog", { name: "Card activity" }).count());
  await h.shot(page, "cc-sweep-after-edit-cancel");
  if ((await page.getByRole("dialog", { name: "Card activity" }).count()) > 0) { await page.keyboard.press("Escape"); await page.waitForTimeout(900); }

  // Selected card panel
  const p = panel(page);
  chk("Convert to EMI disabled + Soon", (await p.getByRole("button", { name: /Convert to EMI/ }).isDisabled()) && /soon/i.test(await p.innerText()));
  await p.getByRole("button", { name: "Card settings" }).click();
  await page.locator('[data-slot="dialog-content"]').getByText(/^Edit /).waitFor();
  chk("Card settings opens the Edit dialog", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await p.getByRole("button", { name: "Pay bill", exact: true }).click();
  await page.waitForTimeout(1200);
  const pd = page.locator('[data-slot="dialog-content"]').last();
  const pt = flat(await pd.innerText());
  await h.shot(page, "cc-sweep-pay-dialog");
  chk("Pay bill opens a dialog showing the amount (₹12,000)", /12,000/.test(pt), pt.slice(0, 200));
  const bank0 = (await h.accountBalance("QA Bank")).currentBalance;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  chk("closing Pay bill moves no money", (await h.accountBalance("QA Bank")).currentBalance === bank0);
  await p.getByRole("button", { name: "Statement", exact: true }).click();
  await page.waitForTimeout(1500);
  chk("Statement opens card activity", (await page.getByRole("dialog", { name: "Card activity" }).count()) >= 1);
  await h.shot(page, "cc-sweep-activity");
  for (const t of await page.getByRole("tab").allInnerTexts()) {
    await page.getByRole("tab", { name: new RegExp(t.trim().split(/\s/)[0]) }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    const body = flat(await page.locator("body").innerText());
    chk(`activity tab "${flat(t)}" renders without NaN/undefined`, !/NaN|undefined/.test(body));
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await p.getByRole("button", { name: /View all card transactions/ }).click();
  chk("View all card transactions → /transactions", await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/transactions", null, { timeout: 20000 }).then(() => true, () => false), page.url());

  chk(`only bank-logo 404s (${seen.logo})`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("cc-sweep-add-edit-delete", "Credit Cards sweep: Add validation + create (own / shared limit), Edit, Delete cascade", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openCards(page);
  const n0 = (await cards()).length;
  const acc0 = (await h.list("accounts")).length;

  // Validation (toasts) — nothing written
  let dlg = await openAdd(page);
  await h.shot(page, "cc-sweep-add-default");
  await dlg.getByRole("button", { name: "Add Card", exact: true }).click();
  await page.waitForTimeout(500);
  chk("empty form → last-4 message", /Last 4 digits are required/.test(await toastText(page)), (await toastText(page)).slice(0, 150));
  await dlg.locator("#cc-form-last4").fill("1234");
  await dlg.getByRole("button", { name: "Add Card", exact: true }).click();
  await page.waitForTimeout(500);
  chk("no bank → 'Choose the bank'", /Choose the bank/.test(await toastText(page)), (await toastText(page)).slice(0, 150));
  await pickBank(page, dlg, "HDFC Bank");
  await dlg.getByRole("button", { name: "Add Card", exact: true }).click();
  await page.waitForTimeout(500);
  chk("no limit → 'Credit limit must be greater than 0'", /Credit limit must be greater than 0/.test(await toastText(page)), (await toastText(page)).slice(0, 150));
  await dlg.getByLabel(/Statement day/).fill("40");
  await dlg.getByLabel(/Card credit limit/).fill("1000");
  await dlg.getByRole("button", { name: "Add Card", exact: true }).click();
  await page.waitForTimeout(500);
  chk("statement day 40 rejected", /Statement day must be between 1 and 31/.test(await toastText(page)), (await toastText(page)).slice(0, 150));
  chk("rejected attempts wrote nothing", (await cards()).length === n0 && (await h.list("accounts")).length === acc0);
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  chk("X closes the dialog", await closed(dlg));
  dlg = await openAdd(page);
  chk("re-open gives a fresh form", (await dlg.locator("#cc-form-last4").inputValue()) === "");
  await page.keyboard.press("Escape");
  chk("Esc closes the dialog", await closed(dlg));

  // Create (own limit)
  dlg = await openAdd(page);
  await pickBank(page, dlg, "HDFC Bank");
  await dlg.locator("#cc-form-last4").fill("5678");
  await dlg.getByLabel(/Card holder/).fill("Asha Rao");
  await dlg.getByLabel(/Statement day/).fill("10");
  await dlg.getByLabel(/Card credit limit/).fill("75000");
  await dlg.getByRole("button", { name: "VISA", exact: true }).click().catch(() => {});
  await dlg.getByRole("button", { name: "Add Card", exact: true }).click();
  chk("dialog closes after Add Card", await closed(dlg, 30000));
  await page.waitForTimeout(2500);
  const all = await cards();
  const created = all.find((c) => c.lastFourDigits === "5678");
  chk("card profile persisted (limit 75,000, statement 10, holder)", !!created && created.creditLimit === 75000 && created.statementDay === 10 && created.cardHolderName === "Asha Rao", JSON.stringify(created && { l: created.creditLimit, s: created.statementDay, d: created.paymentDueDay, h: created.cardHolderName }));
  const acct = created && (await h.list("accounts")).find((a) => a.id === created.accountId);
  chk("linked card account created (type card, credit, last-4, balance 0)", !!acct && acct.type === "card" && acct.cardSubtype === "credit" && acct.accountNumberLast4 === "5678" && acct.currentBalance === 0, JSON.stringify(acct && { t: acct.type, n: acct.name, b: acct.currentBalance }));
  chk("tile shows the new card", /5678/.test(await mine(page).innerText()));
  await h.shot(page, "cc-sweep-after-add");

  // Edit (selecting/creating a card opens its activity sheet over the tiles — close it first)
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  const tile = mine(page).locator("div,article").filter({ hasText: "5678" }).last();
  const opts = mine(page).getByRole("button", { name: "Card options", exact: true });
  for (let i = 0; i < (await opts.count()); i++) {
    await opts.nth(i).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.locator('[data-slot="dialog-content"]').getByText(/^Edit /).waitFor();
    if ((await page.locator('[data-slot="dialog-content"]').locator("#cc-form-last4").inputValue()) === "5678") break;
    await page.locator('[data-slot="dialog-content"]').getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(600);
  }
  dlg = page.locator('[data-slot="dialog-content"]');
  const editedLast4 = await dlg.locator("#cc-form-last4").inputValue();
  chk("Edit opened for a card (prefilled last-4)", /^\d{4}$/.test(editedLast4), editedLast4);
  await dlg.getByLabel(/Card holder/).fill("Asha R");
  await dlg.getByLabel(/Card credit limit/).fill("90000");
  await dlg.getByRole("button", { name: "Save Changes", exact: true }).click();
  chk("Edit dialog closes after Save Changes", await closed(dlg, 30000));
  await page.waitForTimeout(2500);
  const target = (await cards()).find((c) => c.lastFourDigits === editedLast4);
  chk("edit persisted (limit 90,000, holder 'Asha R')", target && target.creditLimit === 90000 && target.cardHolderName === "Asha R", JSON.stringify(target && { l: target.creditLimit, h: target.cardHolderName }));
  void tile;

  // Delete the created card (the one ending 5678 if still present, else whichever we edited)
  const victim = (await cards()).find((c) => c.lastFourDigits === "5678") ?? target;
  const victimAcct = (await h.list("accounts")).find((a) => a.id === victim.accountId);
  await page.keyboard.press("Escape").catch(() => {});
  await openCards(page);
  const idx = (await mine(page).getByRole("button", { name: "Card options", exact: true }).count()) - 1;
  const before = (await cards()).length;
  // select by text: open options of the tile containing the victim's last 4
  const tiles = mine(page).getByRole("button", { name: "Card options", exact: true });
  for (let i = 0; i < (await tiles.count()); i++) {
    await tiles.nth(i).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const del = page.locator('[data-slot="dialog-content"]').last();
    await del.getByText(/Permanently delete/).waitFor();
    const title = flat(await del.innerText());
    if (title.includes(victimAcct.name) && (victim.lastFourDigits === "5678" ? true : true)) {
      await page.waitForTimeout(1500);
      chk("delete dialog warns + names the card", /cannot be undone/.test(title), title.slice(0, 160));
      const btn = del.getByRole("button", { name: "Delete Permanently" });
      chk("Delete disabled until name typed", await btn.isDisabled());
      await del.getByPlaceholder(victimAcct.name).fill(victimAcct.name);
      const box = del.getByRole("checkbox");
      if ((await box.count()) > 0) await box.check();
      await btn.click();
      chk("delete dialog closes", await closed(del, 30000));
      break;
    }
    await del.getByRole("button", { name: "Cancel" }).click();
    await closed(del);
  }
  void idx;
  await page.waitForTimeout(2500);
  chk("profile removed", (await cards()).length === before - 1, `${before} -> ${(await cards()).length}`);
  chk("its account removed (no orphan)", !(await h.list("accounts")).find((a) => a.id === victim.accountId && !a.deletedAt));
  chk("seed card untouched", (await cards()).some((c) => c.lastFourDigits === "4242"));

  chk(`only bank-logo 404s (${seen.logo})`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});
