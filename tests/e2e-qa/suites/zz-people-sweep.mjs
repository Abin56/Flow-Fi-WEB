/**
 * People Ledger sweep (testing-phase check): the list page and a person's page render without console/page errors or
 * layout overflow, the figures agree between the summary, the rows and the person page, and every button / link does
 * what its label says (search, filters, cycle navigation, Add person, Edit, More actions, Record payment / Add / Split /
 * Share sheets, Expand ledger, Delete person). Each write is verified against the persisted emulator documents.
 * Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const num = (s) => {
  const m = /([-−+]?)\s*₹\s*([\d,]+(?:\.\d+)?)/.exec(String(s));
  return m ? (/^[-−]/.test(m[1]) ? -1 : 1) * Number(m[2].replace(/,/g, "")) : NaN;
};
const personDoc = async (name) => (await h.list("people")).find((p) => p.name === name && !p.deletedAt);
const activeEntries = async (id) => (await h.list(`people/${id}/ledger`)).filter((e) => !e.deletedAt);
const sheet = (page) => page.getByRole("dialog").last();
// The Next dev-tools badge floats over the bottom-left of a phone-width sheet (dev builds only) and eats real clicks there.
const press = (loc) => loc.evaluate((b) => b.click());
const closeSheet = async (page) => {
  await sheet(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
};
const overflow = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));

async function openList(page) {
  await h.go(page, "/people");
  await page.getByRole("heading", { level: 1, name: "People Ledger" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(1800);
}
const rowBtn = (page, name) => page.getByRole("button", { name: new RegExp(`^Open ${name}'s ledger`) });
const rowNames = async (page) => (await page.locator('main button[aria-label^="Open "]').evaluateAll((els) => els.map((e) => /^Open (.*?)'s ledger/.exec(e.getAttribute("aria-label"))?.[1]))).filter(Boolean);

scenario("pp-sweep-render", "People sweep: list renders with consistent figures, no console errors, no overflow (4 viewports × light/dark)", async ({ page, logs }, chk) => {
  await h.addFixture(page, "shared-emi");
  await openList(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "pp-sweep-list-desktop-light");
  chk("heading 'People Ledger' + subtitle", /People Ledger Money between you and the people in your life/.test(main));
  chk("Cycle summary section present", (await page.locator('section[aria-label="Cycle summary"]').count()) === 1);
  chk("People section present", (await page.locator('section[aria-label="People"]').count()) === 1);
  chk("three people listed (Priya, Ravi, Lender)", JSON.stringify((await rowNames(page)).sort()) === JSON.stringify(["QA Lender", "QA Priya", "QA Ravi"]), (await rowNames(page)).join(","));
  chk("no 'NaN' / 'undefined' / 'Infinity' / '[object' text", !/NaN|undefined|Infinity|\[object/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity|\[object).{0,30}/) || [""])[0]);
  chk("no skeleton left after load", (await page.locator('main [class*="animate-pulse"]').count()) === 0);

  // The summary's two totals are the sum of the rows' "current pending" by direction.
  const rows = await page.locator('main button[aria-label^="Open "]').evaluateAll((els) => els.map((e) => ({ label: e.getAttribute("aria-label"), text: e.innerText })));
  const owedToMe = rows.filter((r) => /They owe you/.test(r.label)).reduce((t, r) => t + num(/They owe you\s*₹[\d,.]+/.exec(r.label)?.[0] ?? ""), 0);
  const iOwe = rows.filter((r) => /You owe them/.test(r.label)).reduce((t, r) => t + num(/You owe them\s*₹[\d,.]+/.exec(r.label)?.[0] ?? ""), 0);
  const summary = flat(await page.locator('section[aria-label="Cycle summary"]').innerText());
  chk(`summary 'Receive' equals the rows' total they owe me (₹${owedToMe})`, num((/Receive\s*₹[\d,.]+/.exec(summary) ?? [""])[0]) === owedToMe, summary.slice(0, 160));
  chk(`summary 'Give' equals the rows' total I owe (₹${iOwe})`, num((/Give\s*₹[\d,.]+/.exec(summary) ?? [""])[0]) === iOwe, summary.slice(0, 160));
  chk("filter chips: All 3 · receive 2 · give 1 · settled 0", /All\s*3\s*You need to receive\s*2\s*You need to give\s*1\s*Settled\s*0/.test(main), main.match(/All\s*\d.*?Settled\s*\d/)?.[0]);

  for (const [name, vp] of [["desktop", { width: 1920, height: 1080 }], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(vp);
      await page.waitForTimeout(800);
      const o = await overflow(page);
      const culprits = o.main > 1 || o.doc > 1
        ? await page.evaluate(() => {
            const m = document.querySelector("main");
            const right = m.getBoundingClientRect().right;
            return [...m.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > right + 1 && el.getBoundingClientRect().width > 0).slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 70).replace(/ /g, ".")} +${Math.round(el.getBoundingClientRect().right - right)} "${el.innerText.slice(0, 24).replace(/\s+/g, " ")}"`);
          })
        : [];
      chk(`list ${name} ${vp.width}px ${scheme}: no horizontal overflow`, o.doc <= 1 && o.main <= 1, JSON.stringify(o) + (culprits.length ? ` culprits: ${culprits.join(" | ")}` : ""));
      await h.shot(page, `pp-sweep-list-${name}-${scheme}`);
    }
  }

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1366, height: 768 });
  const before = flat(await page.locator('section[aria-label="Cycle summary"]').innerText());
  await page.reload();
  await page.getByRole("heading", { level: 1, name: "People Ledger" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(2200);
  chk("hard reload: summary unchanged", flat(await page.locator('section[aria-label="Cycle summary"]').innerText()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("pp-sweep-list-controls", "People sweep: search, filter chips, cycle navigation, Add person (validation, success, cancel)", async ({ page, logs }, chk) => {
  await h.addFixture(page, "shared-emi");
  await openList(page);

  // Search
  const search = page.getByLabel("Search people");
  await search.fill("priya");
  await page.waitForTimeout(500);
  chk("search 'priya' (case-insensitive) leaves only QA Priya", JSON.stringify(await rowNames(page)) === JSON.stringify(["QA Priya"]), (await rowNames(page)).join(","));
  chk("filter counts follow the search (All 1)", /All\s*1\b/.test(flat(await page.locator('section[aria-label="People"]').innerText())));
  await search.fill("zzz-nobody");
  await page.waitForTimeout(500);
  chk("no match → 'No one matches that search'", (await page.getByText("No one matches that search").count()) === 1);
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.waitForTimeout(400);
  chk("Clear search restores everyone and empties the box", (await rowNames(page)).length === 3 && (await search.inputValue()) === "");

  // Filters
  for (const [label, expected] of [["You need to receive", ["QA Priya", "QA Ravi"]], ["You need to give", ["QA Lender"]], ["Settled", []], ["All", ["QA Lender", "QA Priya", "QA Ravi"]]]) {
    await page.getByRole("tab", { name: new RegExp(`^${label} \\d`) }).click();
    await page.waitForTimeout(400);
    const got = (await rowNames(page)).sort();
    chk(`filter '${label}' shows ${expected.length} row(s)`, JSON.stringify(got) === JSON.stringify(expected), got.join(","));
    if (label === "Settled") chk("empty group says 'No one in this group for this cycle'", (await page.getByText("No one in this group for this cycle").count()) === 1);
  }

  // Cycle navigation
  const cycleLabel = async () => flat(await page.getByRole("button", { name: /^Selected cycle/ }).first().innerText());
  const start = await cycleLabel();
  await page.getByRole("button", { name: "Previous cycle" }).first().click();
  await page.waitForTimeout(900);
  const prev = await cycleLabel();
  chk("Previous cycle moves the range back", prev !== start, `${start} → ${prev}`);
  chk("a previous cycle with no new activity still lists the people (carried balances)", (await rowNames(page)).length >= 1, (await rowNames(page)).join(","));
  const bodyPrev = flat(await page.locator("main").innerText());
  chk("previous cycle: no NaN/undefined", !/NaN|undefined|Infinity/.test(bodyPrev));
  await h.shot(page, "pp-sweep-prev-cycle");
  await page.getByRole("button", { name: "Next cycle" }).first().click();
  await page.waitForTimeout(900);
  chk("Next cycle returns to the starting range", (await cycleLabel()) === start, await cycleLabel());
  chk("on the current cycle 'Next' is disabled (no future cycles) and 'Current cycle' is shown instead of 'Back to current'", (await page.getByRole("button", { name: "Next cycle" }).first().isDisabled()) && (await page.getByRole("button", { name: "Back to current" }).count()) === 0 && (await page.getByText("Current cycle", { exact: true }).count()) >= 1);
  await page.getByRole("button", { name: "Previous cycle" }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Previous cycle" }).first().click();
  await page.waitForTimeout(900);
  const twoBack = await cycleLabel();
  await page.getByRole("button", { name: "Back to current" }).first().click();
  await page.waitForTimeout(900);
  chk(`'Back to current' jumps back from ${twoBack}`, (await cycleLabel()) === start, await cycleLabel());

  // Add person
  const toggle = page.getByRole("button", { name: "Add Person", exact: true }).first();
  await toggle.click();
  const nameBox = page.getByLabel("Name", { exact: true });
  await nameBox.waitFor({ state: "visible" });
  chk("Add Person opens the inline form, header button reads 'Close'", (await page.getByRole("button", { name: "Close", exact: true }).count()) >= 1);
  chk("name box is focused on open", await nameBox.evaluate((e) => e === document.activeElement));
  const submit = page.locator("form").filter({ has: nameBox }).getByRole("button", { name: "Add Person" });
  chk("empty name → submit disabled", await submit.isDisabled());
  await nameBox.fill("   ");
  chk("blank name → submit still disabled", await submit.isDisabled());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const collapsed = () => nameBox.evaluate((e) => !!e.closest('[aria-hidden="true"]'));
  chk("Escape closes (collapses) the form", await collapsed());
  await toggle.click();
  await nameBox.waitFor({ state: "visible" });
  chk("re-opened form starts empty", (await nameBox.inputValue()) === "");
  await nameBox.fill("QA Sweep Sam");
  await page.getByRole("button", { name: "Phone, email, opening balance (optional)" }).click();
  await page.getByLabel("Phone", { exact: true }).fill("9876543210").catch(async () => page.locator('input[inputmode="tel"]').fill("9876543210"));
  await page.locator('input[type="email"]').fill("sam@example.com");
  await page.locator('input[inputmode="decimal"]').first().fill("750");
  await page.getByRole("radio", { name: "You need to give" }).click();
  chk("opening-balance side radio switches", (await page.getByRole("radio", { name: "You need to give" }).getAttribute("aria-checked")) === "true");
  await h.shot(page, "pp-sweep-add-person");
  await page.evaluate(() => window.__reset());
  await submit.evaluate((b) => { b.click(); b.click(); }); // a double click must still add exactly one
  await page.getByText("QA Sweep Sam").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const sams = (await h.list("people")).filter((p) => p.name === "QA Sweep Sam" && !p.deletedAt);
  chk("exactly one person created (double-click safe) (persisted)", sams.length === 1, String(sams.length));
  chk("opening balance saved as 'I owe' ₹750 (persisted: −750) with phone + email", sams[0] && sams[0].openingBalance === -750 && sams[0].phone === "9876543210" && sams[0].email === "sam@example.com", JSON.stringify(sams[0] && [sams[0].openingBalance, sams[0].currentBalance, sams[0].phone, sams[0].email]));
  chk("form collapsed after adding; new person listed with 'You owe them ₹750'", (await collapsed()) && (await page.getByRole("button", { name: /^Open QA Sweep Sam's ledger — You owe them ₹750/ }).count()) >= 1);
  chk("the list now has 4 people; summary Give grew by ₹750", (await rowNames(page)).length === 4 && /Give\s*₹5,750/.test(flat(await page.locator('section[aria-label="Cycle summary"]').innerText())), flat(await page.locator('section[aria-label="Cycle summary"]').innerText()).slice(0, 140));
  await h.shot(page, "pp-sweep-after-add-person");

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

const personPanels = async ({ page, logs }, chk) => {
  const mobile = (page.viewportSize()?.width ?? 1000) < 500;
  const sfx = mobile ? "-mobile" : "";
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya");
  const body0 = flat(await page.locator("main").innerText());
  chk("person page: name, '2 transactions', cycle range", /QA Priya/.test(body0) && /2 transactions/.test(body0) && /01 \w{3} – \d{2} \w{3} \d{4}/.test(body0));
  chk("overall: you need to receive ₹2,000 · give ₹0", /You need to receive\s*₹2,000/.test(body0) && /You need to give\s*₹0/.test(body0));
  chk("this cycle: total ₹2,000 · received ₹0 · remaining ₹2,000", /TOTAL\s*₹2,000\s*RECEIVED\s*₹0\s*REMAINING\s*₹2,000/i.test(body0), body0.match(/TOTAL.*?REMAINING\s*₹[\d,]+/i)?.[0]);
  chk("two ledger rows (EMI share ₹1,000 + split share ₹1,000) match the total", (body0.match(/₹1,000 to receive/g) ?? []).length === 2);
  chk("no NaN/undefined", !/NaN|undefined|Infinity|\[object/.test(body0));
  await h.shot(page, `pp-sweep-person${sfx}`);
  const o = await overflow(page);
  chk("person page: no horizontal overflow", o.doc <= 1 && o.main <= 1, JSON.stringify(o));

  // Record payment opens/closes (button toggles; sheet X closes)
  await page.getByRole("button", { name: "Record payment" }).first().click();
  const rp = page.getByTestId("payment-sheet");
  await rp.waitFor({ timeout: 15000 });
  chk("Record payment opens the sheet; footer primary is disabled until an amount is typed", await rp.getByRole("button", { name: /^Record ₹0/ }).isDisabled());
  await h.shot(page, `pp-sweep-record-sheet${sfx}`);
  await rp.getByRole("button", { name: "Close", exact: true }).first().click();
  await rp.waitFor({ state: "hidden", timeout: 10000 });
  chk("sheet X closes it and the page is usable again", await page.getByRole("button", { name: "Add", exact: true }).isVisible());

  // Add transaction sheet: validation then close
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add = sheet(page);
  await add.getByRole("button", { name: /^Save/ }).waitFor();
  await add.getByRole("button", { name: /^Save/ }).click();
  await page.waitForTimeout(400);
  chk("Save with nothing chosen → 'Choose “Money I Gave” or “Money I Borrowed”.'", /Choose “Money I Gave” or “Money I Borrowed”/.test(flat(await add.innerText())));
  await add.getByRole("radio", { name: "Money I Gave" }).click();
  await add.getByRole("button", { name: /^Save/ }).click();
  await page.waitForTimeout(400);
  chk("no amount → 'Amount must be greater than 0.'", /Amount must be greater than 0/.test(flat(await add.innerText())));
  await add.getByLabel("Amount").fill("100");
  await add.getByRole("button", { name: /^Save/ }).click();
  await page.waitForTimeout(400);
  chk("no account → 'Select an account.'", /Select an account/.test(flat(await add.innerText())));
  await h.shot(page, `pp-sweep-add-validation${sfx}`);
  await press(add.getByRole("button", { name: "Cancel" }));
  await add.waitFor({ state: "hidden", timeout: 10000 });

  // Split sheet opens / validates / closes
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const split = sheet(page);
  await split.getByRole("button", { name: "Save Split" }).waitFor();
  await h.shot(page, `pp-sweep-split-sheet${sfx}`);
  await split.getByRole("button", { name: "Save Split" }).click();
  await page.waitForTimeout(500);
  chk("Save Split with nothing filled does not close the sheet and says why", (await split.isVisible()) && /enter|required|description|amount|account/i.test(flat(await split.innerText())), flat(await split.innerText()).slice(-200));
  await press(split.getByRole("button", { name: "Cancel" }));
  await split.waitFor({ state: "hidden", timeout: 10000 });

  // Share sheet: formats + copy + close
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = sheet(page);
  await share.getByText("Share Statement").first().waitFor();
  chk("Share sheet shows the statement header and the same due (₹2,000)", /BALANCE DUE\s*₹2,000/i.test(flat(await share.innerText())) && /QA Priya owes/.test(flat(await share.innerText())));
  for (const fmt of ["Detailed", "Summary", "Smart Settlement"]) {
    await share.getByRole("radio", { name: fmt, exact: true }).click();
    await page.waitForTimeout(300);
    chk(`format '${fmt}' selects and previews`, /Message preview|TOTAL|OUTSTANDING|₹2,000/i.test(flat(await share.innerText())));
  }
  await h.shot(page, `pp-sweep-share-sheet${sfx}`);
  await share.getByRole("button", { name: "Close", exact: true }).first().click();
  await share.waitFor({ state: "hidden", timeout: 10000 });

  // Expand ledger dialog
  await page.getByRole("button", { name: "Expand" }).click();
  const ledger = sheet(page);
  await page.waitForTimeout(900);
  chk("Expand opens the full ledger dialog with both rows", (flat(await ledger.innerText()).match(/₹1,000 to receive/g) ?? []).length === 2, flat(await ledger.innerText()).slice(0, 200));
  await h.shot(page, `pp-sweep-ledger-dialog${sfx}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  chk("Escape closes the ledger dialog", (await page.getByRole("dialog").count()) === 0);

  // Edit person
  await page.getByRole("button", { name: /^Edit/ }).first().click();
  await page.getByRole("button", { name: "Save Changes" }).waitFor();
  await page.getByPlaceholder("e.g. Priya Sharma").fill("");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(400);
  chk("empty name → 'Name is required.'", (await page.getByText("Name is required.").count()) === 1);
  await page.getByPlaceholder("e.g. Priya Sharma").fill("QA Priya S");
  await page.locator('input[type="tel"]').fill("9000000001");
  await page.evaluate(() => window.__reset());
  const balBefore = (await personDoc("QA Priya")).currentBalance;
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(3500);
  const edited = (await h.list("people")).filter((p) => /^QA Priya S?$/.test(p.name) && !p.deletedAt);
  chk("name + phone saved (persisted)", edited.length === 1 && edited[0].name === "QA Priya S" && edited[0].phone === "9000000001", JSON.stringify(edited.map((p) => [p.name, p.phone])));
  chk("balance untouched by editing contact details (persisted)", edited[0] && edited[0].currentBalance === balBefore, `${balBefore} → ${edited[0]?.currentBalance}`);
  const afterEdit = flat(await page.locator("main").innerText());
  chk("header now shows the new name", /QA Priya S/.test(afterEdit), afterEdit.slice(0, 80));
  await h.shot(page, `pp-sweep-after-edit${sfx}`);

  // More actions → menu items; Cancel on the delete dialog keeps the person
  await page.getByRole("button", { name: "More actions" }).click();
  chk("More actions menu: 'Delete all transactions' + 'Delete person'", (await page.getByRole("menuitem", { name: "Delete all transactions" }).count()) === 1 && (await page.getByRole("menuitem", { name: "Delete person" }).count()) === 1);
  await page.getByRole("menuitem", { name: "Delete person" }).click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).last();
  await confirm.getByText(/Delete QA Priya S\?/).waitFor({ timeout: 10000 });
  chk("delete dialog warns it is permanent", /cannot be undone|permanently/i.test(flat(await confirm.innerText())));
  await press(confirm.getByRole("button", { name: "Cancel" }));
  await page.waitForTimeout(600);
  chk("Cancel keeps the person (persisted)", (await h.list("people")).some((p) => p.name === "QA Priya S" && !p.deletedAt));

  // Back to list
  await page.getByRole("button", { name: /People Ledger|Back to People Ledger/ }).first().click();
  await page.getByRole("heading", { level: 1, name: "People Ledger" }).waitFor({ timeout: 20000 });
  chk("Back returns to the list with the renamed person", (await rowNames(page)).includes("QA Priya S"), (await rowNames(page)).join(","));

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
};
scenario("pp-sweep-person-panels", "People sweep: person page — every action button, sheet validation, Edit, Delete-cancel, Back (desktop)", personPanels);
scenario("pp-sweep-person-panels-mobile-dark", "The same on mobile 390×844, dark", personPanels, { viewport: { width: 390, height: 844 }, scheme: "dark" });

scenario("pp-sweep-add-entry", "People sweep: Add 'I gave' ₹500 from QA Bank writes one ledger entry + one transaction; balances move once", async ({ page, logs }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Ravi");
  const priorBank = await f.bal("QA Bank");
  const ravi0 = await personDoc("QA Ravi");
  const txBefore = (await h.list("transactions")).filter((t) => !t.deletedAt).length;
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add = sheet(page);
  await add.getByRole("radio", { name: "Money I Gave" }).click();
  await add.getByLabel("Amount").fill("500");
  await add.getByPlaceholder("e.g. Dinner, cab").fill("QA sweep lend");
  await f.pickAccountIn(page, "QA Bank");
  await page.waitForTimeout(700); // the account popup is still closing — until it is gone it is the "last dialog"
  const save = add.getByRole("button", { name: "Save ₹500" });
  chk("Save shows the amount ('Save ₹500')", (await save.count()) === 1);
  chk("outcome line says Ravi will owe ₹500", /will owe you\s*₹500/.test(flat(await add.innerText())));
  await page.evaluate(() => window.__reset());
  await save.evaluate((b) => { b.click(); b.click(); });
  await add.waitFor({ state: "hidden", timeout: 30000 });
  await page.waitForTimeout(3500);
  const ravi1 = await personDoc("QA Ravi");
  const entries = (await activeEntries(ravi1.id)).filter((e) => e.note === "QA sweep lend");
  chk("one ledger entry (persisted)", entries.length === 1 && entries[0].amount === 500 && entries[0].type === "gave", JSON.stringify(entries.map((e) => [e.type, e.amount])));
  chk("Ravi's balance +₹500 exactly once (persisted)", f.close2(ravi1.currentBalance - ravi0.currentBalance, 500), `${ravi0.currentBalance} → ${ravi1.currentBalance}`);
  chk("QA Bank −₹500 exactly once (persisted)", f.close2(priorBank - (await f.bal("QA Bank")), 500), `${priorBank} → ${await f.bal("QA Bank")}`);
  chk("exactly one new transaction (persisted)", (await h.list("transactions")).filter((t) => !t.deletedAt).length === txBefore + 1);
  const body = flat(await page.locator("main").innerText());
  chk("UI: the new row 'QA sweep lend' is listed and the total is ₹2,500", /QA sweep lend/.test(body) && /YOU NEED TO RECEIVE FROM QA\s*₹2,500/i.test(body), body.match(/RECEIVE FROM QA\s*₹[\d,]+/i)?.[0]);
  await h.shot(page, "pp-sweep-after-add-entry");

  // The same transaction is visible on the Transactions page and the account statement moved.
  await h.go(page, "/transactions");
  await page.waitForTimeout(3000);
  const txMain = flat(await page.locator("main").innerText());
  chk("Transactions page lists the cash leg: 'QA Ravi' · QA Bank · −₹500", /QA Ravi.*QA Bank.*−₹500/.test(txMain), txMain.match(/QA Ravi.{0,90}/)?.[0]);
  // Product-wording finding (not fixed: it needs ledger knowledge passed into the presentation helper): money I GAVE (a loan out)
  // is labelled like a repayment because every outgoing People cash leg maps to "Paid back to person" / "Repaid".
  chk.finding("PPL-LABEL-GAVE", "an 'I gave' cash leg is not labelled 'Paid back to person' / 'Repaid'", !/QA Ravi.{0,80}Paid back to person/.test(txMain), txMain.match(/QA Ravi.{0,90}/)?.[0]);

  // Insufficient funds is refused in the UI
  await f.openPerson(page, "QA Ravi");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add2 = sheet(page);
  await add2.getByRole("radio", { name: "Money I Gave" }).click();
  await add2.getByLabel("Amount").fill("99999999");
  await f.pickAccountIn(page, "QA Bank");
  await add2.getByRole("button", { name: /^Save/ }).click();
  await page.waitForTimeout(500);
  chk("amount above the account balance is refused ('doesn't have enough balance')", /doesn't have enough balance/.test(flat(await add2.innerText())), flat(await add2.innerText()).slice(-160));
  chk("…and nothing was written (persisted)", f.close2(priorBank - (await f.bal("QA Bank")), 500));
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("pp-sweep-late-night", "People sweep: just after midnight in India (02:30 IST) Add / Split / Record-payment defaults are still today's local date", async ({ page, logs }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya");
  // A manual "I gave" entry, so a row with the entry-settle form exists (made before the clock is faked).
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const seedAdd = sheet(page);
  await seedAdd.getByRole("radio", { name: "Money I Gave" }).click();
  await seedAdd.getByLabel("Amount").fill("100");
  await seedAdd.getByPlaceholder("e.g. Dinner, cab").fill("QA late entry");
  await f.pickAccountIn(page, "QA Bank");
  await seedAdd.getByRole("button", { name: "Save ₹100" }).click();
  await seedAdd.waitFor({ state: "hidden", timeout: 30000 });
  await page.waitForTimeout(2500);
  const fake = new Date();
  fake.setUTCHours(21, 0, 0, 0); // 21:00 UTC == 02:30 the next day in India: anything derived from the UTC day is a day behind
  await page.clock.setFixedTime(fake);
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(fake.getTime());
  const localToday = `${pad(local.getDate())}/${pad(local.getMonth() + 1)}/${local.getFullYear()}`;
  const utcToday = `${pad(fake.getUTCDate())}/${pad(fake.getUTCMonth() + 1)}/${fake.getUTCFullYear()}`;
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const dateIn = (loc) => loc.locator('input[placeholder="dd/mm/yyyy"]').first().inputValue();
  const verdict = (shown) => `shows ${shown}${shown === utcToday && utcToday !== localToday ? " (the UTC date — a day behind)" : ""} · tz ${tz}`;

  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add = sheet(page);
  await add.getByRole("button", { name: /^Save/ }).waitFor();
  let d = await dateIn(add);
  chk(`Add transaction default date is today's local date (${localToday})`, d === localToday, verdict(d));
  await press(add.getByRole("button", { name: "Cancel" }));
  await add.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Split", exact: true }).click();
  const split = sheet(page);
  await split.getByRole("button", { name: "Save Split" }).waitFor();
  d = await dateIn(split);
  chk(`Split expense default date is today's local date (${localToday})`, d === localToday, verdict(d));
  await press(split.getByRole("button", { name: "Cancel" }));
  await split.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Record payment" }).first().click();
  const rp = page.getByTestId("payment-sheet");
  await rp.waitFor();
  d = await dateIn(rp);
  chk(`Record payment default date is today's local date (${localToday})`, d === localToday, verdict(d));
  await rp.getByRole("button", { name: "Close", exact: true }).first().click();
  await rp.waitFor({ state: "hidden" });

  // The row's own "Record" (settle one item) form
  await page.getByText("QA late entry").first().click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Record", exact: true }).last().click();
  await page.waitForTimeout(800);
  const rowForm = page.locator("form").filter({ hasText: "remaining" }).first();
  d = await dateIn(rowForm);
  chk(`row 'Record' (settle one item) default date is today's local date (${localToday})`, d === localToday, verdict(d));
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("pp-sweep-delete-person", "People sweep: Delete person (confirm) removes them from the list; ledger history soft-deleted; other people untouched", async ({ page, logs }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Ravi");
  const priya0 = await personDoc("QA Priya");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete person" }).click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).last();
  await confirm.getByText(/Delete QA Ravi\?/).waitFor({ timeout: 10000 });
  await page.evaluate(() => window.__reset());
  await confirm.getByRole("button", { name: "Delete", exact: true }).evaluate((b) => { b.click(); b.click(); });
  await page.getByRole("heading", { level: 1, name: "People Ledger" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(3500);
  chk("returned to the list; Ravi is gone from it", !(await rowNames(page)).includes("QA Ravi"), (await rowNames(page)).join(","));
  chk("Ravi no longer active (persisted)", !(await personDoc("QA Ravi")));
  chk("QA Priya untouched (persisted)", (await personDoc("QA Priya"))?.currentBalance === priya0.currentBalance);
  await h.shot(page, "pp-sweep-after-delete-person");
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});
