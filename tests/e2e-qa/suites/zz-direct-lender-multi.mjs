/**
 * "A person paid the lender" with TWO sharers, on a shared card EMI: Pay now and Pay several, a part payment, a reload,
 * and Mark-as-unpaid wording. Every figure is read back from the emulator after a full page reload. Synthetic data only.
 */
import { scenario } from "../lib/core.mjs";
import { FIRESTORE_DOCS } from "../lib/env.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const EMI = "QA Card EMI";
const CARD = "QA EMI Card";

/** Makes the fixture card EMI shared in thirds (me / Priya / Ravi ⇒ ₹1,000 each per ₹3,000 EMI) with two EMIs due. */
async function sharedCardEmi(page) {
  await h.addFixture(page, "card-emi");
  const uid = await h.authUid();
  const patch = async (path, fields) => {
    const url = new URL(`${FIRESTORE_DOCS}/users/${uid}/${path}`);
    for (const name of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", name);
    const r = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
    if (!r.ok) throw new Error(`setup failed ${r.status}`);
  };
  const emi = (await h.list("emis")).find((e) => e.name === EMI);
  const people = await h.list("people");
  const priya = people.find((p) => p.name === "QA Priya");
  const ravi = people.find((p) => p.name === "QA Ravi");
  const share = (personId) => ({ mapValue: { fields: { personId: personId ? { stringValue: personId } : { nullValue: null }, amount: { doubleValue: 4000 } } } });
  await patch(`emis/${emi.id}`, { ownershipShares: { arrayValue: { values: [share(null), share(priya.id), share(ravi.id)] } } });
  const schedule = `paymentSchedules/${emi.scheduleId}/installments`;
  const rows = (await h.list(schedule)).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  await Promise.all(rows.slice(0, 2).map((i, k) => patch(`${schedule}/${i.id}`, { dueDate: { timestampValue: new Date(Date.now() - (3 - k) * 86400000).toISOString() } })));
  return { emi, priya, ravi, schedule, rows };
}

async function snapshot(w) {
  const accounts = Object.fromEntries((await h.list("accounts")).map((a) => [a.name, a.currentBalance]));
  const transactions = await h.list("transactions");
  const paid = (await h.list(w.schedule)).sort((a, b) => a.sequenceNumber - b.sequenceNumber).map((i) => i.amountPaid ?? 0);
  const entries = async (p) => (await h.list(`people/${p.id}/ledger`)).filter((e) => !e.deletedAt);
  return { accounts, transactions, paid, priya: await entries(w.priya), ravi: await entries(w.ravi) };
}
const sameBalances = (a, b) => Object.keys(a.accounts).every((n) => f.close2(a.accounts[n], b.accounts[n]));
const json = (v) => JSON.stringify(v);
/** Only the ledger entries this run added (the seed already gives both people some), as [amount, installment]. */
const added = (before, after, who, w) =>
  after[who].filter((e) => !before[who].some((b) => b.id === e.id)).map((e) => [e.amount, w.rows.findIndex((i) => `emi-inst:${i.id}` === e.obligationRef) + 1]);

async function openEmi(page) {
  await h.go(page, "/loans-installments");
  await page.getByText(EMI).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.locator("[data-stack-layer]");
  await dlg.getByRole("radio", { name: "Pay several" }).waitFor();
  return dlg;
}

async function pickRecordAccount(page, dlg) {
  await dlg.getByRole("combobox", { name: "Account for the People record" }).click();
  await page.getByRole("option", { name: /QA Bank/ }).first().click();
}

scenario("dlm-card-pay-now", "Shared card EMI, Pay now → paid directly: nothing preselected, part payment capped, only the payer settled, no account moves, survives reload", async ({ page }, chk) => {
  const w = await sharedCardEmi(page);
  const before = await snapshot(w);
  const dlg = await openEmi(page);
  await dlg.getByRole("radio", { name: /paid directly$/ }).click();
  await h.pickPaidDate(page, dlg);
  const shares = dlg.getByRole("region", { name: "People sharing it" });
  await shares.waitFor();
  const save = dlg.getByRole("button", { name: /^(Save payment made by|Record direct payment|Save past payment)/ });
  const pressed = async (name) => (await shares.getByRole("radiogroup", { name, exact: true }).locator('[aria-checked="true"]').allInnerTexts()).join("");
  chk("nobody is preselected", /Leave pending/.test(await pressed("QA Priya")) && /Leave pending/.test(await pressed("QA Ravi")), `${await pressed("QA Priya")} / ${await pressed("QA Ravi")}`);
  chk("save is off until a payer is chosen", await save.isDisabled());

  // A ₹1,500 lender payment can't carry ₹2,000 of People credit.
  await dlg.getByTestId("other-ways-toggle").click();
  await dlg.getByRole("radio", { name: /A different amount/ }).click();
  await dlg.getByTestId("amount-card").getByRole("spinbutton").fill("1500");
  for (const name of ["QA Priya", "QA Ravi"]) await shares.getByRole("radiogroup", { name, exact: true }).getByRole("radio", { name: "Cover full share" }).click();
  const blocker = await dlg.getByTestId("direct-settlement-blocker").innerText().catch(() => "");
  chk("over-covering the part payment is refused before saving", /cover more than/.test(blocker) && (await save.isDisabled()), blocker);
  await shares.getByRole("radiogroup", { name: "QA Ravi", exact: true }).getByRole("radio", { name: "Leave pending" }).click();
  await shares.getByRole("radiogroup", { name: "QA Priya", exact: true }).getByRole("radio", { name: "Cover part" }).click();
  await shares.getByLabel("Amount covered for QA Priya").fill("600");
  chk("save still waits for the People record account", await save.isDisabled());
  await pickRecordAccount(page, dlg);
  chk("no 'add to my account' choice exists", (await dlg.getByRole("radio", { name: /Add to my account/ }).count()) === 0);
  await h.shot(page, "dlm-pay-now-ready");
  await save.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(7000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const after = await snapshot(w);
  const txs = after.transactions.filter((t) => !before.transactions.some((b) => b.id === t.id));
  const [priya, ravi] = [added(before, after, "priya", w), added(before, after, "ravi", w)];
  chk("EMI #1 has ₹1,500 paid, nothing else", json(after.paid) === json([1500, 0, 0, 0]), json(after.paid));
  chk("only Priya is credited, exactly ₹600 on EMI #1", json(priya) === json([[600, 1]]) && ravi.length === 0, `priya ${json(priya)} ravi ${json(ravi)}`);
  chk("no bank or card balance moved", sameBalances(before, after), json(after.accounts));
  chk("the only new transaction is the excluded People record", txs.length === 1 && txs[0].excludeFromCalculations === true && txs[0].isPersonLedgerMovement === true, json(txs.map((t) => [t.amount, t.excludeFromCalculations, t.isPersonLedgerMovement])));
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("dlm-card-pay-several", "Shared card EMI, Pay several → each EMI paid by a different person", async ({ page }, chk) => {
  const w = await sharedCardEmi(page);
  const before = await snapshot(w);
  const dlg = await openEmi(page);
  await dlg.getByRole("radio", { name: "Pay several" }).click();
  for (const i of w.rows.slice(0, 2)) {
    const box = dlg.getByRole("checkbox", { name: `#${i.sequenceNumber}`, exact: true });
    if (!(await box.isChecked())) await box.check();
  }
  await dlg.getByRole("button", { name: /^Review 2 EMIs/ }).click();
  for (const n of [1, 2]) await dlg.getByRole("radiogroup", { name: `Who paid #${n}`, exact: true }).getByRole("radio", { name: "Person paid lender" }).click();
  const confirm = dlg.getByRole("button", { name: /^Record 2 EMIs/ });
  await dlg.getByTestId("bulk-direct-blocker").waitFor();
  chk("confirm is off until payers are named", await confirm.isDisabled());
  await dlg.getByRole("radiogroup", { name: "QA Priya #1", exact: true }).getByRole("radio", { name: "Cover full share" }).click();
  await dlg.getByRole("radiogroup", { name: "QA Ravi #2", exact: true }).getByRole("radio", { name: "Cover full share" }).click();
  chk("confirm still waits for the People record account", await confirm.isDisabled(), await dlg.getByTestId("bulk-direct-blocker").innerText().catch(() => ""));
  await pickRecordAccount(page, dlg);
  await h.shot(page, "dlm-several-ready");
  await confirm.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(9000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const after = await snapshot(w);
  const txs = after.transactions.filter((t) => !before.transactions.some((b) => b.id === t.id));
  const [priya, ravi] = [added(before, after, "priya", w), added(before, after, "ravi", w)];
  chk("EMIs #1 and #2 are paid", json(after.paid) === json([3000, 3000, 0, 0]), json(after.paid));
  chk("Priya is credited ₹1,000 on #1 only and Ravi ₹1,000 on #2 only", json(priya) === json([[1000, 1]]) && json(ravi) === json([[1000, 2]]), `priya ${json(priya)} ravi ${json(ravi)}`);
  chk("no bank or card balance moved", sameBalances(before, after), json(after.accounts));
  chk("only the two excluded People records were added", txs.length === 2 && txs.every((t) => t.excludeFromCalculations === true && t.isPersonLedgerMovement === true), json(txs.map((t) => [t.amount, t.excludeFromCalculations])));
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("dlm-recover-after-reopen", "Lender saved, the People commit fails on the network → reload → the schedule says so → finishing it writes People only, once", async ({ page }, chk) => {
  const w = await sharedCardEmi(page);
  const before = await snapshot(w);
  // Fault: the lender commit goes through; every commit that touches a person's ledger is dropped.
  const dropPeople = (route) => (/\/ledger\//.test(route.request().postData() ?? "") ? route.abort("failed") : route.fallback());
  await page.route(/:commit/, dropPeople);
  const dlg = await openEmi(page);
  await dlg.getByRole("radio", { name: /paid directly$/ }).click();
  await h.pickPaidDate(page, dlg);
  await dlg.getByRole("region", { name: "People sharing it" }).getByRole("radiogroup", { name: "QA Priya", exact: true }).getByRole("radio", { name: "Cover full share" }).click();
  await pickRecordAccount(page, dlg);
  await dlg.getByRole("button", { name: /^(Save payment made by|Record direct payment|Save past payment)/ }).click();
  await dlg.getByTestId("people-partly-saved").waitFor({ timeout: 90000 });
  await h.shot(page, "dlm-recover-1-partly");
  const failed = await snapshot(w);
  chk("lender side saved, nothing in People (persisted)", json(failed.paid) === json([3000, 0, 0, 0]) && added(before, failed, "priya", w).length === 0, `${json(failed.paid)} priya ${json(added(before, failed, "priya", w))}`);

  // Close by reloading the whole app: the dialog's Retry is gone.
  await page.unroute(/:commit/, dropPeople);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await h.go(page, "/loans-installments");
  await page.getByText(EMI).first().click();
  await h.showSchedule(page);
  await page.locator('[data-testid="installment-row-1"]').click();
  const notice = page.getByTestId("direct-recovery");
  await notice.waitFor({ timeout: 30000 });
  await h.shot(page, "dlm-recover-2-notice");
  chk("after reopening, the installment says the lender is paid and People isn't updated", (await notice.getAttribute("data-state")) === "notCredited", await notice.innerText());

  await notice.getByRole("button", { name: "Finish People record" }).click();
  await notice.getByRole("radiogroup", { name: "QA Priya", exact: true }).getByRole("radio", { name: "Cover full share" }).click();
  await pickRecordAccount(page, notice);
  await notice.getByRole("button", { name: "Save People record" }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(7000);
  await h.shot(page, "dlm-recover-3-done");
  const done = await snapshot(w);
  const txs = done.transactions.filter((t) => !before.transactions.some((b) => b.id === t.id));
  chk("Priya credited ₹1,000 on #1 exactly once; Ravi untouched", json(added(before, done, "priya", w)) === json([[1000, 1]]) && added(before, done, "ravi", w).length === 0, json(added(before, done, "priya", w)));
  chk("no second lender payment", json(done.paid) === json([3000, 0, 0, 0]), json(done.paid));
  chk("one excluded People transaction; no bank or card balance moved", txs.length === 1 && txs[0].excludeFromCalculations === true && sameBalances(before, done), json(txs.map((t) => [t.amount, t.excludeFromCalculations])));
  const remaining = await page.getByTestId("direct-recovery").getAttribute("data-state").catch(() => "none");
  chk("the notice now reports a part credit (the rest was nobody's), not a missing record", remaining === "partlyCredited", remaining);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
