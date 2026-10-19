/**
 * Browser QA scenarios (activity-undo.mjs) — Activity & Undo. Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";

const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);

async function openActivity(page) {
  await h.go(page, "/activity");
  await page.getByRole("heading", { name: "Activity & Undo" }).waitFor();
  await page.waitForTimeout(2000);
}
/** Opens the row whose title matches and waits until the panel has decided. */
async function openRow(page, title) {
  await page.getByRole("button", { name: title }).first().click();
  const panel = page.getByRole("dialog").last();
  await panel.waitFor();
  // Decided = the "Checking…" line is gone (it is replaced by the eligible / blocked / reversed explanation).
  await panel.getByText(/Checking whether this can be undone/).waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(600); // let the slide-in finish before anything measures the panel
  return panel;
}

async function payLoanInstallment(page) {
  await h.go(page, "/loans-installments");
  await page.getByText("QA Loan 12").first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByRole("button", { name: /^Pay ₹/ }).last().click();
  await page.waitForTimeout(4500);
  await page.keyboard.press("Escape").catch(() => {});
}

scenario("act-expense-undo", "Activity: undo a simple expense — bank restored once, row shows 'Reversed or replaced'", async ({ page }, chk) => {
  const before = await f.bal("QA Bank");
  await openActivity(page);
  chk("Activity is in the navigation", (await page.getByRole("link", { name: "Activity" }).count()) > 0);
  const panel = await openRow(page, /QA groceries/);
  const details = await f.flat(panel);
  chk("details explain the action can be undone", /This can be undone/.test(details), details.slice(0, 300));
  chk("details offer Open original", (await panel.getByRole("link", { name: /Open original/ }).count()) === 1);
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await panel.getByText("What will change").waitFor();
  const confirm = await f.flat(panel);
  chk("confirmation shows the bank balance change", /QA Bank balance: ₹[\d,]+ → ₹[\d,]+/.test(confirm), confirm.slice(0, 300));
  await h.shot(page, "act-expense-undo-confirm");
  await page.evaluate(() => window.__reset());
  await panel.getByRole("button", { name: "Undo now" }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4000);
  const after = await f.bal("QA Bank");
  chk("bank restored by exactly ₹850 (persisted)", f.close2(after - before, 850), `${before} -> ${after}`);
  chk("double click on 'Undo now' wrote once", (await commits(page)) <= 1, `commits ${await commits(page)}`);
  chk("the groceries transaction is soft-deleted (persisted)", (await f.txns((t) => t.description === "QA groceries")).length === 0);
  await page.waitForTimeout(1500);
  const rowText = await f.flat(page.getByRole("button", { name: /QA groceries/ }).first());
  chk("row now shows 'Reversed or replaced'", /Reversed or replaced/.test(rowText), rowText);
  const again = await openRow(page, /QA groceries/);
  chk("reopened: no Undo button any more", (await again.getByRole("button", { name: "Undo", exact: true }).count()) === 0);
  await h.shot(page, "act-expense-undo-after");
  return await h.timeline(page);
});

scenario("act-loan-latest-only", "Activity: only the latest loan payment can be undone; undoing it restores bank + installment", async ({ page }, chk) => {
  // The seed may already hold a (historical) payment on this loan — everything below is relative to it.
  const paidBefore = (await f.scheduleState("loan", "QA Loan 12")).filter((i) => i.amountPaid > 0).length;
  await openActivity(page);
  const rowsBefore = await page.getByRole("button", { name: /Loan payment · QA Loan 12/ }).count();
  const before = await f.bal("QA Bank");
  await payLoanInstallment(page);
  await payLoanInstallment(page);
  const paid = await f.bal("QA Bank");
  const paidSeqs = (await f.scheduleState("loan", "QA Loan 12")).filter((i) => i.amountPaid > 0).map((i) => i.seq);
  chk("precondition: two more installments paid", paidSeqs.length === paidBefore + 2, `${paidBefore} -> ${paidSeqs.length}; bank ${before} -> ${paid}`);
  const latestSeq = Math.max(...paidSeqs);

  await openActivity(page);
  await page.getByRole("tab", { name: "Loan/EMI" }).click();
  await page.waitForTimeout(800);
  const rows = page.getByRole("button", { name: /Loan payment · QA Loan 12/ });
  chk("Loan/EMI filter lists both new payments", (await rows.count()) === rowsBefore + 2, `${rowsBefore} -> ${await rows.count()}`);

  // Newest is first: the older one (second row) is view-only with the reason.
  await rows.nth(1).click();
  let panel = page.getByRole("dialog").last();
  await panel.getByText(/later payment was recorded/).waitFor({ timeout: 20000 });
  chk("older payment: no Undo, explains why", (await panel.getByRole("button", { name: "Undo", exact: true }).count()) === 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  await rows.nth(0).click();
  panel = page.getByRole("dialog").last();
  await panel.getByText(/This can be undone/).waitFor({ timeout: 20000 });
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  const confirm = await f.flat(panel);
  chk("confirmation says the latest installment is due again", new RegExp(`Installment #${latestSeq} is due again`).test(confirm), confirm.slice(0, 300));
  await panel.getByRole("button", { name: "Undo now" }).click();
  await page.waitForTimeout(4500);
  const state = await f.scheduleState("loan", "QA Loan 12");
  const bySeq = new Map(state.map((i) => [i.seq, i.amountPaid]));
  chk(`installment #${latestSeq} unpaid again, #${latestSeq - 1} still paid (persisted)`, bySeq.get(latestSeq) === 0 && bySeq.get(latestSeq - 1) > 0, JSON.stringify(state.slice(0, latestSeq)));
  const back = (await f.bal("QA Bank")) - paid;
  const perInstallment = (before - paid) / 2;
  chk("bank got exactly one installment back (persisted)", Math.abs(back - perInstallment) < 0.01, `${paid} -> +${back} (one installment = ${perInstallment})`);
  return await h.timeline(page);
});

scenario("act-two-tabs", "Activity: stale second tab — undo in tab A, then tab B's Undo reports 'already undone' and moves nothing", async ({ page, ctx }, chk) => {
  const before = await f.bal("QA Bank");
  await openActivity(page);
  const tabB = await f.secondTab(ctx, "/activity");
  await tabB.getByRole("heading", { name: "Activity & Undo" }).waitFor();
  await tabB.waitForTimeout(2000);
  const panelB = await openRow(tabB, /QA groceries/);
  await panelB.getByRole("button", { name: "Undo", exact: true }).click();
  await panelB.getByText("What will change").waitFor();

  const panelA = await openRow(page, /QA groceries/);
  await panelA.getByRole("button", { name: "Undo", exact: true }).click();
  await panelA.getByRole("button", { name: "Undo now" }).click();
  await page.waitForTimeout(3500);
  const afterA = await f.bal("QA Bank");
  chk("tab A restored ₹850", f.close2(afterA - before, 850), `${before} -> ${afterA}`);

  await panelB.getByRole("button", { name: "Undo now" }).click();
  await tabB.getByText(/Already undone/).first().waitFor({ timeout: 15000 }).catch(() => {});
  await tabB.waitForTimeout(2500);
  const afterB = await f.bal("QA Bank");
  chk("tab B's stale undo moved no money", f.close2(afterB, afterA), `${afterA} -> ${afterB}`);
  chk("tab B was told it was already undone", (await tabB.getByText(/Already undone/).count()) > 0);
  await tabB.close();
  return await h.timeline(page);
});

for (const scheme of ["light", "dark"]) {
  const vp = { width: 390, height: 844 };
  scenario(`act-mobile-${scheme}`, `Activity: mobile 390x844 ${scheme} — list and panel fit, actions reachable`, async ({ page }, chk) => {
    await openActivity(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
    await h.shot(page, `act-mobile-${scheme}-list`);
    const panel = await openRow(page, /QA groceries/);
    const box = await panel.boundingBox();
    chk("panel fits the viewport width", box && box.x >= -1 && box.x + box.width <= vp.width + 1, JSON.stringify(box && { x: Math.round(box.x), w: Math.round(box.width) }));
    const undo = panel.getByRole("button", { name: "Undo", exact: true });
    await undo.scrollIntoViewIfNeeded();
    const ub = await undo.boundingBox();
    chk("Undo button visible in the viewport", ub && ub.y >= 0 && ub.y + ub.height <= vp.height + 1 && ub.x >= 0 && ub.x + ub.width <= vp.width + 1, JSON.stringify(ub && { x: Math.round(ub.x), y: Math.round(ub.y), h: Math.round(ub.height) }));
    await undo.click();
    await panel.getByText("What will change").waitFor();
    const now = panel.getByRole("button", { name: "Undo now" });
    const nb = await now.boundingBox();
    chk("'Undo now' reachable in the viewport", nb && nb.y >= 0 && nb.y + nb.height <= vp.height + 1, JSON.stringify(nb && { y: Math.round(nb.y), h: Math.round(nb.height) }));
    await h.shot(page, `act-mobile-${scheme}-confirm`);
    return await h.timeline(page);
  }, { viewport: vp, scheme });
}

scenario("act-history-preserved", "Activity: the old /history page still renders (D1)", async ({ page }, chk) => {
  await h.go(page, "/history");
  await page.waitForTimeout(2500);
  chk("History heading present", (await page.getByRole("heading", { name: "History" }).count()) > 0);
  return await h.timeline(page);
});
