/**
 * Browser QA scenarios (bills-safety.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Bills safety fixes: Skip on a paid cycle (F1), edit-conflict handling + live refresh (F5), time-zone-safe due dates (F4),
 * and the historical-duplicate payment block (F3). Each drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const bill = async () => (await h.list("bills")).find((b) => /QA Electricity/.test(b.name));
const cycles = async (billId) => h.list(`bills/${billId}/occurrences`);
const payments = async (billId) => h.list(`bills/${billId}/payments`);

async function openDetail(page) {
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
}
async function openEdit(page) {
  await openDetail(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: /Edit QA Electricity/ });
  await dlg.waitFor();
  return dlg;
}
async function payFromAccount(page) {
  await page.getByRole("button", { name: "Pay…" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: /Pay from my account now/ }).click();
  await page.waitForTimeout(600);
  const acct = dlg.getByText(/Choose|Select|paying account/i).first();
  if (await acct.count()) { await acct.click().catch(() => {}); await page.getByRole("option", { name: /QA Bank/ }).click().catch(() => {}); }
  await dlg.getByRole("button", { name: /Pay now|Pay ₹/ }).last().click();
  return dlg;
}

/* ───────────────────────────── F1 ───────────────────────────── */

async function restPatch(docPath, fields, mask) {
  const uid = await h.authUid();
  const port = process.env.QA_FIRESTORE_PORT ?? 8380;
  const m = mask.map((f) => `updateMask.fieldPaths=${f}`).join("&");
  return fetch(`http://127.0.0.1:${port}/v1/projects/demo-flowfi-qa/databases/(default)/documents/users/${uid}/${docPath}?${m}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
}

scenario("bills-safety-skip-paid", "F1: a PAID cycle that is still on screen (one-time bill) has Skip DISABLED with an explanation; the payment is untouched", async ({ page }, chk) => {
  const b0 = await bill();
  // A one-time bill keeps its paid cycle as the current one (a recurring bill rolls straight on to next month's unpaid cycle).
  chk("fixture: bill made one-time", (await restPatch(`bills/${b0.id}`, { recurrence: { stringValue: "oneTime" } }, ["recurrence"])).ok);
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  chk("Skip is enabled on the unpaid cycle", await page.getByRole("button", { name: "Skip", exact: true }).isEnabled());
  const before = await bal("QA Bank");
  const dlg = await payFromAccount(page);
  await dlg.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  chk("fixture: paid from QA Bank once", Math.abs(before - (await bal("QA Bank")) - 1500) < 0.01, `${before} -> ${await bal("QA Bank")}`);

  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  chk("Skip is DISABLED on the paid cycle", await skip.isDisabled());
  chk("the disabled Skip explains why (tooltip)", /payment recorded/i.test((await skip.getAttribute("title")) ?? ""), (await skip.getAttribute("title")) ?? "no title");
  await skip.click({ force: true, timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const occ = (await cycles(b0.id))[0];
  chk("persisted cycle is still paid and NOT skipped", Number(occ.amountPaid) === 1500 && occ.isSkipped !== true, `amountPaid ${occ.amountPaid}, skipped ${occ.isSkipped}`);
  chk("one payment record, bank debited once", (await payments(b0.id)).filter((p) => p.deletedAt == null).length === 1);
});

scenario("bills-safety-skip-stale", "F1: Skip pressed on a stale panel (another tab paid meanwhile) is refused with a message and overwrites nothing", async ({ page }, chk) => {
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  chk("Skip is enabled on the (stale) unpaid panel", await skip.isEnabled());
  const b0 = await bill();
  const occ0 = (await cycles(b0.id))[0];
  // The other tab pays: the cycle is fully paid in storage.
  chk("fixture: another tab marked the cycle paid", (await h.patchNumber(`bills/${b0.id}/occurrences/${occ0.id}`, "amountPaid", Number(occ0.amount))).ok);
  await skip.click();
  await page.waitForTimeout(2000);
  await h.shot(page, "bills-safety-skip-stale");
  const body = await page.locator("body").innerText();
  chk("the user is told the cycle already has a payment", /already has a payment recorded/i.test(body), "toast text found: " + /already has a payment recorded/i.test(body));
  const occ = (await cycles(b0.id))[0];
  chk("persisted cycle is unchanged: still paid, NOT skipped", Number(occ.amountPaid) === Number(occ0.amount) && occ.isSkipped !== true, `amountPaid ${occ.amountPaid}, skipped ${occ.isSkipped}`);
});

/* ───────────────────────────── F5 (+ conflict UX) ───────────────────────────── */

scenario("bills-safety-conflict-reload", "F5: edit conflict keeps typed input, shows a banner, 'load the latest' refreshes in place, then the change saves", async ({ page }, chk) => {
  const dlg = await openEdit(page);
  const bill0 = await bill();
  const name = dlg.getByPlaceholder("e.g. Electricity");
  const amount = dlg.locator('input[type="number"]').first();
  await name.fill("QA Electricity (edited)");
  await amount.fill("2000");
  chk("fixture: another tab changed the stored amount to 1800", (await h.patchNumber(`bills/${bill0.id}`, "amount", 1800)).ok);
  await page.waitForTimeout(1500); // let the live bills list deliver it

  await dlg.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(2000);
  await h.shot(page, "bills-safety-conflict-banner");
  chk("error toast is visible", await page.getByText(/Couldn't save changes/).first().isVisible().catch(() => false));
  chk("conflict banner is visible inside the form", await dlg.getByText(/This bill changed in another tab/).isVisible().catch(() => false));
  chk("form is still open with the typed name and amount", (await name.inputValue()) === "QA Electricity (edited)" && (await amount.inputValue()) === "2000");
  chk("nothing was saved", Number((await bill()).amount) === 1800 && (await bill()).name === bill0.name);

  await dlg.getByRole("button", { name: /load the latest/i }).click();
  await page.waitForTimeout(600);
  chk("'load the latest' refreshes the form in place with the CURRENT values (1800, original name)", (await amount.inputValue()) === "1800" && (await name.inputValue()) === bill0.name, `${await name.inputValue()} / ${await amount.inputValue()}`);
  chk("the banner is gone after refreshing", !(await dlg.getByText(/This bill changed in another tab/).isVisible().catch(() => false)));

  await amount.fill("2000");
  await dlg.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(2000);
  chk("re-applying the change from the refreshed form saves it", Number((await bill()).amount) === 2000 && !(await dlg.isVisible().catch(() => false)), String((await bill()).amount));
});

scenario("bills-safety-live-detail", "F5: Edit from a bill panel that was already open shows values another tab saved meanwhile", async ({ page }, chk) => {
  await openDetail(page);
  const bill0 = await bill();
  chk("fixture: another tab changed the stored amount to 1800", (await h.patchNumber(`bills/${bill0.id}`, "amount", 1800)).ok);
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: /Edit QA Electricity/ });
  await dlg.waitFor();
  chk("the form opened from the still-open panel shows 1800 (not the click-time 1500)", (await dlg.locator('input[type="number"]').first().inputValue()) === "1800", await dlg.locator('input[type="number"]').first().inputValue());
});

scenario("bills-safety-merge", "Edit: a DIFFERENT field changed elsewhere → save succeeds and both edits survive; due date untouched", async ({ page }, chk) => {
  const dlg = await openEdit(page);
  const bill0 = await bill();
  await dlg.getByPlaceholder("e.g. Electricity").fill("QA Electricity (renamed)");
  chk("fixture: another tab changed the amount to 1800", (await h.patchNumber(`bills/${bill0.id}`, "amount", 1800)).ok);
  await dlg.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(2500);
  const bill1 = (await h.list("bills")).find((b) => b.id === bill0.id);
  chk("rename saved AND the other tab's amount kept", bill1.name === "QA Electricity (renamed)" && Number(bill1.amount) === 1800, `${bill1.name} / ${bill1.amount}`);
  chk("due date untouched", String(bill1.nextDueDate) === String(bill0.nextDueDate), `${bill0.nextDueDate} -> ${bill1.nextDueDate}`);
});

/* ───────────────────────────── F4 ───────────────────────────── */

scenario("bills-safety-timezones", "F4: the Bills form shows and saves the SAME calendar day in Kolkata, New York and Auckland", async ({ ctx, page }, chk) => {
  const cdp = await ctx.newCDPSession(page);
  // A different day per zone (an unchanged day is correctly NOT rewritten); each saved at LOCAL noon, shown here as a UTC instant.
  const zones = [
    { id: "Asia/Kolkata", offset: -330, day: "18/01/2027", saved: "2027-01-18T06:30:00Z" },
    { id: "America/New_York", offset: 300, day: "19/01/2027", saved: "2027-01-19T17:00:00Z" },
    { id: "Pacific/Auckland", offset: -780, day: "21/01/2027", saved: "2027-01-20T23:00:00Z" },
  ];
  for (const z of zones) {
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: z.id });
    // Reload so every Date the app holds is built under this zone (a zone switched mid-session leaves earlier Date objects with their old local fields — a test artefact, not something a user does).
    await page.reload();
    await page.waitForTimeout(3000);
    const seen = await page.evaluate(() => ({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date("2027-01-19T17:00:00Z").getTimezoneOffset(), day: new Date("2027-01-19T17:00:00Z").getDate() }));
    chk(`${z.id}: the browser really is in that zone`, seen.offset === z.offset, JSON.stringify(seen));
    await h.go(page, "/bills");
    await page.waitForTimeout(3500);
    await page.getByRole("button", { name: /QA Electricity/ }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: /Edit QA Electricity/ });
    await dlg.waitFor();
    const date = dlg.getByPlaceholder("dd/mm/yyyy");
    const stored = await bill();
    const expectedShown = new Date(stored.nextDueDate).toLocaleDateString("en-GB", { timeZone: z.id });
    chk(`${z.id}: the form shows the stored due date as that zone's own calendar day`, (await date.inputValue()) === expectedShown, `shows ${await date.inputValue()}, expected ${expectedShown}`);
    await date.fill(z.day);
    await dlg.getByRole("button", { name: "Save Changes" }).click();
    await page.waitForTimeout(2500);
    const saved = (await bill()).nextDueDate;
    chk(`${z.id}: ${z.day} is saved as local noon of that day (${z.saved})`, new Date(saved).toISOString().replace(".000Z", "Z") === z.saved, String(saved));
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Kolkata" });
});

/* ───────────────────────────── Unskip ───────────────────────────── */

scenario("bills-safety-unskip", "Unskip: a skipped unpaid cycle can be un-skipped, with a loading state, and counts again in totals", async ({ page }, chk) => {
  const b0 = await bill();
  // A recurring bill's skipped cycle is "settled" and rolls forward to a fresh one the next time the Bills page is
  // opened — correct, pre-existing behaviour — so a one-time bill (same as bills-safety-skip-paid) keeps its skipped
  // cycle as "current" here, which is what this scenario needs to see Un-skip replace Skip in place.
  chk("fixture: bill made one-time", (await restPatch(`bills/${b0.id}`, { recurrence: { stringValue: "oneTime" } }, ["recurrence"])).ok);
  await openDetail(page);
  // Skip does not close the still-open detail drawer, so the panel in front of us already reflects the skip.
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.waitForTimeout(2000);
  let b = await bill();
  let occ = (await cycles(b.id))[0];
  chk("fixture: the current cycle is now skipped", occ.isSkipped === true);

  const unskip = page.getByRole("button", { name: "Un-skip", exact: true });
  chk("Un-skip is shown (not Skip) on a skipped cycle", await unskip.isVisible());
  chk("Skip is not shown while skipped", !(await page.getByRole("button", { name: "Skip", exact: true }).isVisible().catch(() => false)));

  await unskip.click();
  await page.waitForTimeout(400);
  const loading = page.getByRole("button", { name: "Un-skipping…" });
  chk.finding("ux-unskip-loading-flash", "a loading label is visible while Un-skip is in flight", await loading.isVisible().catch(() => false), "loading state may resolve faster than this check can observe against the emulator");

  await page.waitForTimeout(1500);
  b = await bill();
  occ = (await cycles(b.id))[0];
  chk("persisted cycle is no longer skipped", occ.isSkipped === false, `isSkipped=${occ.isSkipped}`);
  chk("Skip is shown again (not Un-skip) after un-skipping", await page.getByRole("button", { name: "Skip", exact: true }).isVisible());
});

scenario("bills-safety-unskip-stale", "Unskip pressed on a stale panel (cycle no longer skipped) is a safe no-op, not an error", async ({ page }, chk) => {
  const b0 = await bill();
  chk("fixture: bill made one-time", (await restPatch(`bills/${b0.id}`, { recurrence: { stringValue: "oneTime" } }, ["recurrence"])).ok);
  await openDetail(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.waitForTimeout(2000);
  const b = await bill();
  const occ0 = (await cycles(b.id))[0];
  // Another tab already un-skipped it.
  chk("fixture: another tab un-skipped the cycle", (await h.patchNumber(`bills/${b.id}/occurrences/${occ0.id}`, "isSkipped", 0)).ok);

  await page.getByRole("button", { name: "Un-skip", exact: true }).click();
  await page.waitForTimeout(1500);
  await h.shot(page, "bills-safety-unskip-stale");
  const occ = (await cycles(b.id))[0];
  chk("no error, cycle is (still) not skipped", occ.isSkipped === false, `isSkipped=${occ.isSkipped}`);
});

/* ───────────────────────────── Duplicate review panel ───────────────────────────── */

scenario("bills-safety-duplicate-review", "Duplicate Review panel: shows both occurrences, payments, totals effect and a recommendation — read-only, no write button", async ({ page }, chk) => {
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  let b = await bill();
  for (let i = 0; i < 5 && !b; i++) {
    await page.waitForTimeout(1000);
    b = await bill();
  }
  chk("fixture: QA Electricity bill is seeded", !!b);
  const original = (await cycles(b.id))[0];
  const uid = await h.authUid();
  const port = process.env.QA_FIRESTORE_PORT ?? 8380;
  const url = `http://127.0.0.1:${port}/v1/projects/demo-flowfi-qa/databases/(default)/documents/users/${uid}/bills/${b.id}/occurrences/zz-review-twin`;
  const ts = (d) => ({ timestampValue: new Date(d).toISOString() });
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { billId: { stringValue: b.id }, dueDate: ts(original.dueDate), amount: { doubleValue: Number(original.amount) }, amountPaid: { doubleValue: 0 }, isSkipped: { booleanValue: false }, createdAt: ts("2026-01-01"), deletedAt: { nullValue: null }, lastEditedAt: { nullValue: null }, editHistory: { arrayValue: {} } } }),
  });
  chk("fixture: a duplicate twin exists", res.ok);

  await page.reload();
  await page.waitForTimeout(3000);
  const trigger = page.getByRole("button", { name: /duplicate cycle/i });
  chk("a duplicate-cycle button is shown on the Bills toolbar", await trigger.isVisible());
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /duplicate bill cycles/i });
  await dialog.waitFor();
  await h.shot(page, "bills-safety-duplicate-review");
  const txt = await dialog.innerText();
  chk("both occurrence ids are shown", txt.includes(original.id) && txt.includes("zz-review-twin"));
  chk("one is labelled as shown on the Bills page", /Shown on Bills page/.test(txt));
  chk("a totals effect (overstated / counted) is shown", /counted|overstated/i.test(txt));
  chk("a recommendation is shown, phrased as a suggestion (not applied)", /keep one|manual review|separate/i.test(txt));
  chk("read-only: no merge/delete/resolve button exists in the panel", (await dialog.getByRole("button", { name: /merge|delete|resolve|apply|fix/i }).count()) === 0);

  await dialog.getByRole("button", { name: "Copy details" }).first().click();
  await page.waitForTimeout(500);
  chk("copying details confirms nothing was changed", /nothing.*changed|copied/i.test(await page.locator("body").innerText()));

  const after = await cycles(b.id);
  chk("neither occurrence record was altered by viewing/copying", after.length === 2 && after.every((o) => o.amountPaid === 0 || o.amountPaid === Number(original.amountPaid)));
});

/* ───────────────────────────── F3 ───────────────────────────── */

scenario("bills-safety-duplicate-blocked", "F3: a historical duplicate cycle blocks the bank debit with a manual-review message; nothing is written or rewritten", async ({ page }, chk) => {
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  const b = await bill();
  const original = (await cycles(b.id))[0];
  // An older version of the app left a twin: same bill, same due day, different random id (emulator-only write).
  const uid = await h.authUid();
  const port = process.env.QA_FIRESTORE_PORT ?? 8380;
  const url = `http://127.0.0.1:${port}/v1/projects/demo-flowfi-qa/databases/(default)/documents/users/${uid}/bills/${b.id}/occurrences/zz-twin-occurrence`;
  const ts = (iso) => ({ timestampValue: new Date(iso).toISOString() });
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { billId: { stringValue: b.id }, dueDate: ts(original.dueDate), amount: { doubleValue: Number(original.amount) }, amountPaid: { doubleValue: 0 }, isSkipped: { booleanValue: false }, createdAt: ts(original.createdAt), deletedAt: { nullValue: null }, lastEditedAt: { nullValue: null }, editHistory: { arrayValue: {} } } }),
  });
  chk("fixture: a duplicate twin of the current cycle exists", res.ok && (await cycles(b.id)).length === 2, `status ${res.status}`);
  const before = await bal("QA Bank");
  const cyclesBefore = JSON.stringify(await cycles(b.id));

  await page.reload();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  await payFromAccount(page);
  await page.waitForTimeout(2500);
  await h.shot(page, "bills-safety-duplicate-blocked");
  const body = await page.locator("body").innerText();
  chk("the user is told about the duplicate records and that payment is blocked", /duplicate records/i.test(body), (body.match(/[^\n]*duplicate records[^\n]*/i) ?? ["no message"])[0].slice(0, 220));
  chk("QA Bank not debited", (await bal("QA Bank")) === before, `${before} -> ${await bal("QA Bank")}`);
  chk("no payment record was created", (await payments(b.id)).length === 0);
  chk("the duplicate cycle records are exactly as they were (not merged, deleted or rewritten)", JSON.stringify(await cycles(b.id)) === cyclesBefore);
});
