/**
 * Savings goals (savings.mjs) — real-browser checks on synthetic emulator data only (see README).
 * Every claim about money is compared with the persisted documents (accounts, transactions, goal + contributions), read
 * back from the emulator — never with what the screen says alone.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const num = (s) => Number(String(s).replace(/[^\d.-]/g, ""));
const close2 = (a, b) => Math.abs(a - b) < 0.005;
const LEDGER = 'section[aria-label="Transactions"]';

async function openSavings(page) {
  await h.go(page, "/savings");
  await page.getByRole("heading", { level: 1, name: "Savings" }).waitFor({ timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(900);
}

async function createGoal(page, name, target) {
  await page.getByTestId("new-goal").first().click();
  const form = page.getByTestId("savings-goal-form");
  await form.waitFor();
  await page.getByTestId("goal-name").fill(name);
  await page.getByTestId("goal-target").fill(String(target));
  await page.getByRole("button", { name: "Create goal" }).click();
  await form.waitFor({ state: "hidden" });
  await page.waitForTimeout(800);
}

const card = (page, name) => page.locator(`[data-testid="savings-goal-card"][data-goal-name="${name}"]`);

async function pickAccount(page, triggerLabel, accountName) {
  await page.getByLabel(triggerLabel).click();
  await page.getByRole("option", { name: new RegExp(accountName) }).first().click();
}

async function addMoney(page, name, { amount, mode, from, into, account }) {
  await card(page, name).getByRole("button", { name: /Add money to/ }).click();
  const dlg = page.getByTestId("savings-money-dialog");
  await dlg.waitFor();
  if (mode === "transfer") {
    await dlg.getByRole("radio", { name: /Move money/ }).click();
    await pickAccount(page, "Savings account", into);
    await pickAccount(page, "Move from account", from);
  } else if (account) {
    await pickAccount(page, "Account the money is in", account);
  }
  await dlg.getByTestId("savings-amount").fill(String(amount));
  return dlg;
}

const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const goalDoc = async (name) => (await h.list("savingsGoals")).find((g) => g.name === name && !g.deletedAt);
const entriesOf = async (goalId) => (await h.list(`savingsGoals/${goalId}/contributions`)).filter((e) => !e.deletedAt);
const savingsTx = async () => (await h.list("transactions")).filter((t) => !t.deletedAt && /^Savings/.test(t.description || ""));

scenario("sav-1-create-and-empty", "Savings: empty state → create a goal → stored with safe defaults", async ({ page, logs }, chk) => {
  await openSavings(page);
  chk("empty state invites the first goal", (await page.getByTestId("savings-empty").count()) === 1);
  await h.shot(page, "sav-1-empty-light");

  // Validation first: nothing is written for an invalid form.
  await page.getByTestId("new-goal").first().click();
  await page.getByTestId("savings-goal-form").waitFor();
  await page.getByRole("button", { name: "Create goal" }).click();
  chk("an empty form is refused with a clear message", /name/i.test(await page.getByTestId("goal-form-error").innerText()));
  await page.getByTestId("goal-name").fill("Laptop");
  await page.getByTestId("goal-target").fill("0");
  await page.getByRole("button", { name: "Create goal" }).click();
  chk("a zero target is refused", /target/i.test(await page.getByTestId("goal-form-error").innerText()));
  chk("nothing was written for the invalid attempts", (await h.list("savingsGoals")).length === 0);
  await page.getByTestId("goal-target").fill("50000");
  await page.getByRole("button", { name: "Create goal" }).click();
  await page.getByTestId("savings-goal-form").waitFor({ state: "hidden" });
  await page.waitForTimeout(800);

  const g = await goalDoc("Laptop");
  chk("goal stored with target 50,000, opening 0, current 0, open", g && g.targetAmount === 50000 && g.openingAmount === 0 && g.currentAmount === 0 && g.isCompleted === false && g.isArchived === false, JSON.stringify(g && { t: g.targetAmount, o: g.openingAmount, c: g.currentAmount }));
  chk("the goal card appears without a reload", (await card(page, "Laptop").count()) === 1);
  chk("summary shows ₹0 saved of ₹50,000", /₹0/.test(await page.getByTestId("total-saved").innerText()) && /50,000/.test(await page.getByTestId("savings-summary").innerText()));
  await h.shot(page, "sav-1-created-light");
});

scenario("sav-2-money-flows", "Savings: set-aside moves nothing; a real transfer moves exactly once; withdraw; undo — all verified in stored documents", async ({ page, logs }, chk, notes) => {
  await openSavings(page);
  await createGoal(page, "Laptop", 50000);
  const bank0 = await bal("QA Bank");
  const cash0 = await bal("QA Cash");
  const net0 = bank0 + cash0;
  const goalId = (await goalDoc("Laptop")).id;

  // 1. Set aside ₹10,000 from QA Bank — a reservation: no transaction, no balance change.
  let dlg = await addMoney(page, "Laptop", { amount: 10000, mode: "earmark", account: "QA Bank" });
  chk("preview says no money moves", /No money moves/.test(await page.getByTestId("savings-preview").innerText()));
  await page.getByRole("button", { name: "Add money", exact: true }).last().click();
  await dlg.waitFor({ state: "hidden" });
  await page.waitForTimeout(1200);
  chk("set-aside wrote NO transaction", (await savingsTx()).length === 0 && (await h.list("transactions")).filter((t) => !t.deletedAt && t.createdAt && /Savings/.test(t.description || "")).length === 0);
  chk("balances unchanged (persisted)", close2(await bal("QA Bank"), bank0) && close2(await bal("QA Cash"), cash0), `${await bal("QA Bank")} / ${await bal("QA Cash")}`);
  let entries = await entriesOf(goalId);
  chk("one earmark entry stored: in, 10,000, QA Bank", entries.length === 1 && entries[0].mode === "earmark" && entries[0].direction === "in" && entries[0].amount === 10000 && entries[0].transactionIds.length === 0, JSON.stringify(entries.map((e) => [e.mode, e.amount])));
  chk("card now shows ₹10,000", /10,000/.test(await card(page, "Laptop").getByTestId("goal-saved").innerText()));

  // 2. A set-aside cannot exceed the free money left in the account.
  dlg = await addMoney(page, "Laptop", { amount: bank0, mode: "earmark", account: "QA Bank" });
  const err = await page.getByTestId("savings-error").innerText();
  const freeLeft = (bank0 - 10000).toLocaleString("en-IN");
  chk(`over-reserving is refused and names the free amount (${freeLeft})`, err.includes(freeLeft), err);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await dlg.waitFor({ state: "hidden" });

  // 3. Real transfer QA Bank → QA Cash ₹5,000.
  dlg = await addMoney(page, "Laptop", { amount: 5000, mode: "transfer", from: "QA Bank", into: "QA Cash" });
  chk("preview says it's a transfer, not an expense", /transfer/.test(await page.getByTestId("savings-preview").innerText()) && /not an expense/.test(await page.getByTestId("savings-preview").innerText()));
  await page.getByRole("button", { name: "Add money", exact: true }).last().click();
  await dlg.waitFor({ state: "hidden" });
  await page.waitForTimeout(1500);
  chk("QA Bank −5,000 and QA Cash +5,000 (persisted)", close2(await bal("QA Bank"), bank0 - 5000) && close2(await bal("QA Cash"), cash0 + 5000), `${await bal("QA Bank")} / ${await bal("QA Cash")}`);
  chk("net worth unchanged by the transfer", close2((await bal("QA Bank")) + (await bal("QA Cash")), net0));
  const legs = await savingsTx();
  chk("exactly two linked legs (expense + income) share one transferId", legs.length === 2 && legs[0].transferId && legs[0].transferId === legs[1].transferId && new Set(legs.map((t) => t.type)).size === 2, JSON.stringify(legs.map((t) => [t.type, t.amount, !!t.transferId])));
  entries = await entriesOf(goalId);
  chk("entry links both legs", entries.length === 2 && entries.some((e) => e.mode === "transfer" && e.transactionIds.length === 2 && e.accountId && e.counterAccountId));
  chk("card shows ₹15,000", /15,000/.test(await card(page, "Laptop").getByTestId("goal-saved").innerText()));
  chk("goal cache (mobile app) tracks the total", (await goalDoc("Laptop")).currentAmount === 15000);
  await h.shot(page, "sav-2-after-transfer-light");

  // 4. Open the drawer: history, held-in breakdown.
  await card(page, "Laptop").click();
  const drawer = page.getByTestId("savings-goal-drawer");
  await drawer.waitFor();
  const dtext = await drawer.innerText();
  chk("drawer lists both entries and the real transfer", (await page.getByTestId("savings-entry").count()) === 2 && /real transfer/.test(dtext));
  chk("drawer shows where the money is held (QA Bank 10,000 · QA Cash 5,000)", /QA Bank/.test(dtext) && /QA Cash/.test(dtext) && /10,000/.test(dtext) && /5,000/.test(dtext));
  await h.shot(page, "sav-2-drawer-light");

  // 5. Withdraw ₹2,000 by releasing it from QA Bank — nothing moves.
  await page.getByTestId("drawer-withdraw").click();
  dlg = page.getByTestId("savings-money-dialog");
  await dlg.waitFor();
  await dlg.getByRole("radio", { name: /QA Bank/ }).click();
  await dlg.getByTestId("savings-amount").fill("2000");
  await page.getByRole("button", { name: "Withdraw", exact: true }).last().click();
  await dlg.waitFor({ state: "hidden" });
  await page.waitForTimeout(1200);
  chk("release moved no money (balances as before)", close2(await bal("QA Bank"), bank0 - 5000) && close2(await bal("QA Cash"), cash0 + 5000));
  chk("goal now 13,000", /13,000/.test(await page.getByTestId("drawer-saved").innerText()));
  // Over-withdrawing is refused.
  await page.getByTestId("drawer-withdraw").click();
  await dlg.waitFor();
  await dlg.getByRole("radio", { name: /QA Bank/ }).click();
  await dlg.getByTestId("savings-amount").fill("9000");
  chk("withdrawing more than held there is refused", /held there|only has/i.test(await page.getByTestId("savings-error").innerText()));
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await dlg.waitFor({ state: "hidden" });

  // 6. Undo the real transfer from Savings: both legs deleted, both balances restored.
  const transferRow = page.getByTestId("savings-entry").filter({ hasText: "real transfer" });
  await transferRow.getByRole("button", { name: "Entry actions" }).click();
  await page.getByRole("menuitem", { name: /Undo transfer/ }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  chk("undo explains both balances are restored", /restored/.test(await confirm.innerText()));
  await confirm.getByRole("button", { name: "Undo transfer" }).click();
  await page.waitForTimeout(2000);
  chk("legs gone; QA Bank and QA Cash back to the start (persisted)", (await savingsTx()).length === 0 && close2(await bal("QA Bank"), bank0) && close2(await bal("QA Cash"), cash0), `${await bal("QA Bank")} / ${await bal("QA Cash")}`);
  chk("goal now 8,000 (10,000 set aside − 2,000 released)", /8,000/.test(await page.getByTestId("drawer-saved").innerText()));
  const g = await goalDoc("Laptop");
  chk("cache matches (8,000)", g.currentAmount === 8000, g.currentAmount);
  notes.push(`entries after: ${JSON.stringify((await entriesOf(goalId)).map((e) => [e.mode, e.direction, e.amount]))}`);
  const errs = logs.filter((l) => !/Select is changing|status of 400/.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("sav-3-reverse-in-transactions", "Savings: deleting the transfer in Transactions updates Savings live (no reload) and restores balances", async ({ page, logs }, chk) => {
  await openSavings(page);
  await createGoal(page, "Trip", 20000);
  const bank0 = await bal("QA Bank");
  const cash0 = await bal("QA Cash");
  const dlg = await addMoney(page, "Trip", { amount: 6000, mode: "transfer", from: "QA Bank", into: "QA Cash" });
  await page.getByRole("button", { name: "Add money", exact: true }).last().click();
  await dlg.waitFor({ state: "hidden" });
  await page.waitForTimeout(1500);
  chk("goal shows ₹6,000", /6,000/.test(await card(page, "Trip").getByTestId("goal-saved").innerText()));

  // Go to Transactions (client-side) and delete the transfer there.
  await h.go(page, "/transactions");
  await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.getByLabel("Search transactions").fill("Savings · Trip");
  await page.waitForTimeout(800);
  const row = page.locator(`${LEDGER} tbody tr[aria-expanded]`).first();
  await row.getByRole("button", { name: "Delete transaction" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "Delete" }).last().click();
  await page.waitForTimeout(3000);
  chk("balances restored by the transfer delete", close2(await bal("QA Bank"), bank0) && close2(await bal("QA Cash"), cash0));

  // Back to Savings via client-side navigation — the listener state must show the reversal without a reload.
  await h.go(page, "/savings");
  await page.getByRole("heading", { level: 1, name: "Savings" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  chk("goal no longer counts the reversed transfer (₹0)", /₹0\b/.test(await card(page, "Trip").getByTestId("goal-saved").innerText()), await card(page, "Trip").getByTestId("goal-saved").innerText());
  await card(page, "Trip").click();
  await page.getByTestId("savings-goal-drawer").waitFor();
  const reversed = page.locator('[data-testid="savings-entry"][data-reversed="true"]');
  chk("the entry stays visible, flagged as reversed", (await reversed.count()) === 1 && /deleted in Transactions/.test(await reversed.innerText()));
  chk("the summary insight explains the reversal", /reversed in Transactions/.test(await page.getByTestId("savings-insights").innerText()));
  await h.shot(page, "sav-3-reversed-light");
  const errs = logs.filter((l) => !/Select is changing|status of 400/.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("sav-4-lifecycle", "Savings: reach target → completes; edit; mark completed early; archive; delete — stored states", async ({ page, logs }, chk) => {
  await openSavings(page);
  const bankStart = await bal("QA Bank");
  await createGoal(page, "Phone", 3000);
  const dlg = await addMoney(page, "Phone", { amount: 3000, mode: "earmark", account: "QA Bank" });
  await page.getByRole("button", { name: "Add money", exact: true }).last().click();
  await dlg.waitFor({ state: "hidden" });
  await page.waitForTimeout(1500);
  let g = await goalDoc("Phone");
  chk("reaching the target completes the goal (stored)", g.isCompleted === true && g.completedAt != null);
  chk("it moved to Completed (Active count drops)", /Completed \(1\)/.test(await page.locator("main").innerText()));
  await page.getByRole("radio", { name: /Completed/ }).click();
  await page.waitForTimeout(500);
  chk("completed tab shows the goal with 100%", (await card(page, "Phone").count()) === 1 && /100%/.test(await card(page, "Phone").innerText()));
  await h.shot(page, "sav-4-completed-light");

  // Edit: raising the target re-opens it.
  await card(page, "Phone").getByRole("button", { name: /Actions for Phone/ }).click();
  await page.getByRole("menuitem", { name: /Edit goal/ }).click();
  await page.getByTestId("savings-goal-form").waitFor();
  await page.getByTestId("goal-target").fill("5000");
  chk("the form warns the goal will reopen", /reopen/i.test(await page.getByTestId("savings-goal-form").innerText()));
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByTestId("savings-goal-form").waitFor({ state: "hidden" });
  await page.waitForTimeout(1200);
  g = await goalDoc("Phone");
  chk("raising the target reopened it (stored)", g.targetAmount === 5000 && g.isCompleted === false);

  // Mark completed early.
  await page.getByRole("radio", { name: /Active/ }).click();
  await page.waitForTimeout(400);
  await card(page, "Phone").getByRole("button", { name: /Actions for Phone/ }).click();
  await page.getByRole("menuitem", { name: /Mark completed/ }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  chk("early close names the amounts", /3,000/.test(await confirm.innerText()) && /5,000/.test(await confirm.innerText()));
  await confirm.getByRole("button", { name: "Mark completed" }).click();
  await page.waitForTimeout(1200);
  g = await goalDoc("Phone");
  chk("closed early is stored", g.isCompleted === true && g.closedEarly === true);

  // Archive then delete.
  await page.getByRole("radio", { name: /Completed/ }).click();
  await page.waitForTimeout(400);
  await card(page, "Phone").getByRole("button", { name: /Actions for Phone/ }).click();
  await page.getByRole("menuitem", { name: /Archive/ }).click();
  await page.waitForTimeout(1200);
  g = await goalDoc("Phone");
  chk("archived is stored", g.isArchived === true);
  await page.getByRole("radio", { name: /Archived/ }).click();
  await page.waitForTimeout(400);
  await card(page, "Phone").getByRole("button", { name: /Actions for Phone/ }).click();
  await page.getByRole("menuitem", { name: /Delete goal/ }).click();
  const del = page.getByRole("dialog");
  await del.waitFor();
  chk("delete explains no account balance changes", /no account balance changes|Trash/i.test(await del.innerText()));
  await del.getByRole("button", { name: "Delete" }).last().click();
  await page.waitForTimeout(1500);
  chk("goal is soft-deleted (stored), accounts untouched", (await h.list("savingsGoals")).find((x) => x.name === "Phone")?.deletedAt != null && close2(await bal("QA Bank"), bankStart));
  const errs = logs.filter((l) => !/Select is changing|status of 400/.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

for (const [scheme, vp] of [["light", { width: 1440, height: 900 }], ["dark", { width: 1440, height: 900 }], ["light", { width: 390, height: 844 }], ["dark", { width: 390, height: 844 }]]) {
  scenario(`sav-5-visual-${scheme}-${vp.width}`, `Savings: layout + theme (${scheme}, ${vp.width}px)`, async ({ page }, chk) => {
    await openSavings(page);
    await createGoal(page, "Emergency fund", 100000);
    await createGoal(page, "Vacation", 40000);
    const dlg = await addMoney(page, "Emergency fund", { amount: 35000, mode: "earmark", account: "QA Bank" });
    await page.getByRole("button", { name: "Add money", exact: true }).last().click();
    await dlg.waitFor({ state: "hidden" });
    await page.waitForTimeout(1200);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("no horizontal page scroll", overflow <= 1, overflow);
    const ok = await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const c = getComputedStyle(document.querySelector('[data-testid="savings-goal-card"]')).backgroundColor;
      return { bg, c };
    });
    chk("page and cards render with a theme background", ok.bg !== "rgba(0, 0, 0, 0)" || ok.c !== "rgba(0, 0, 0, 0)", JSON.stringify(ok));
    const sh = (await page.getByTestId("savings-summary").boundingBox()).height;
    chk("summary stays compact", sh < (vp.width < 640 ? 330 : 240), `${Math.round(sh)}px`);
    await h.shot(page, `sav-5-page-${scheme}-${vp.width}`);
    await card(page, "Emergency fund").click();
    await page.getByTestId("savings-goal-drawer").waitFor();
    await page.waitForTimeout(500);
    await h.shot(page, `sav-5-drawer-${scheme}-${vp.width}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await card(page, "Vacation").getByRole("button", { name: /Add money to/ }).click();
    await page.getByTestId("savings-money-dialog").waitFor();
    await page.waitForTimeout(500);
    await h.shot(page, `sav-5-dialog-${scheme}-${vp.width}`);
  }, { viewport: vp, scheme });
}
