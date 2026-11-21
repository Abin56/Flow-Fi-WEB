/**
 * Savings (savings.mjs) — real-browser checks on synthetic emulator data only (see README).
 * Every claim about money is compared with the persisted documents (accounts, transactions, goal + contributions), read
 * back from the emulator — never with what the screen says alone.
 *
 * The workspace is a compact overview band + a dense goal grid. Everything that needs room opens in ONE right-hand sheet
 * (new goal · goal details with Add / Withdraw / History / Plan & lock / Edit · Allocate), so the cards stay on screen.
 * While the sheet is open the page behind it is modal — the helpers below close it before touching the grid.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const num = (s) => Number(String(s).replace(/[^\d.-]/g, ""));
const close2 = (a, b) => Math.abs(a - b) < 0.005;
const LEDGER = 'section[aria-label="Transactions"]';
const IGNORE = /Select is changing|status of 400/;

async function openSavings(page) {
  await h.go(page, "/savings");
  await page.getByRole("heading", { level: 1, name: "Savings" }).waitFor({ timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 90000 });
  await page.waitForTimeout(900);
}

/** Closes the Savings side sheet (no-op when it is not open) and waits for its slide-out. */
async function closeSheet(page) {
  for (let i = 0; i < 3 && (await page.getByTestId("savings-sheet").count()) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.getByTestId("savings-sheet").waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
  }
  await page.waitForTimeout(200);
}

/** The confirmation dialog (never the side sheet, which is also role=dialog). */
const confirmDialog = (page) => page.locator('[role="dialog"]:not([data-testid="savings-sheet"])');

/** The "How it is worked out" popover on the Safe-to-save card — opened on demand. */
async function openCap(page) {
  if ((await page.getByTestId("cap-breakdown").count()) === 0) {
    await closeSheet(page);
    await page.getByTestId("cap-details").click();
  }
  await page.getByTestId("cap-breakdown").waitFor();
}

async function insightsText(page) {
  const list = page.getByTestId("savings-insights");
  let text = await list.innerText();
  const more = list.getByRole("button", { name: /more insights/ });
  if (await more.count()) {
    await more.click();
    text += " " + (await page.locator('[data-slot="popover-content"]').last().innerText());
    await page.keyboard.press("Escape");
  }
  return text;
}

async function createGoal(page, name, target, extra = {}) {
  await closeSheet(page);
  await page.getByTestId("new-goal").first().click();
  const form = page.getByTestId("savings-goal-form");
  await form.waitFor();
  if (extra.deposit) await form.getByRole("radio", { name: /Deposit-style fund/ }).click();
  await page.getByTestId("goal-name").fill(name);
  if (extra.deposit) await page.getByTestId("goal-monthly").fill(String(extra.monthly));
  else await page.getByTestId("goal-target").fill(String(target));
  if (extra.due) await form.getByPlaceholder("dd/mm/yyyy").first().fill(extra.due);
  if (extra.monthly && !extra.deposit) await page.getByTestId("goal-monthly").fill(String(extra.monthly));
  if (extra.lock != null) {
    if ((await page.getByTestId("goal-lock").count()) === 0) await form.getByTestId("goal-more-plan").getByRole("button").first().click();
    const sw = page.getByTestId("goal-lock");
    if ((await sw.getAttribute("data-state")) !== (extra.lock ? "checked" : "unchecked")) await sw.click();
  }
  await page.getByTestId("goal-submit").click();
  await form.waitFor({ state: "hidden" });
  await page.waitForTimeout(900);
  await closeSheet(page); // creating moves the sheet on to the new goal; the helpers here want the grid reachable again
}

const card = (page, name) => page.locator(`[data-testid="savings-goal-card"][data-goal-name="${name}"]`);
const panel = (page) => page.getByTestId("savings-goal-panel");

/** Opens a goal's details sheet (only when it is not already showing that goal). */
async function openPanel(page, name, tab) {
  const showing = (await panel(page).count()) > 0 && (await panel(page).getAttribute("aria-label")) === `${name} details`;
  if (!showing) {
    await closeSheet(page);
    await card(page, name).click();
  }
  await panel(page).waitFor();
  if (tab) await panel(page).getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(300);
}

async function pickAccount(page, triggerLabel, accountName) {
  await page.getByLabel(triggerLabel).click();
  await page.getByRole("option", { name: new RegExp(accountName) }).first().click();
}

async function addMoney(page, name, { amount, mode, from, into, account }) {
  await closeSheet(page);
  await card(page, name).getByRole("button", { name: /Add money to/ }).click();
  const box = page.getByTestId("savings-money-panel");
  await box.waitFor();
  if (mode === "transfer") {
    await box.getByRole("radio", { name: /Move money/ }).click();
    await pickAccount(page, "Savings account", into);
    await pickAccount(page, "Move from account", from);
  } else if (account) {
    await pickAccount(page, "Account the money is in", account);
  }
  await box.getByTestId("savings-amount").fill(String(amount));
  return box;
}

async function submitMoney(page, box) {
  await box.getByTestId("savings-money-submit").click();
  await box.waitFor({ state: "hidden" });
  await page.waitForTimeout(1300);
}

const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const goalDoc = async (name) => (await h.list("savingsGoals")).find((g) => g.name === name && !g.deletedAt);
const entriesOf = async (goalId) => (await h.list(`savingsGoals/${goalId}/contributions`)).filter((e) => !e.deletedAt);
const savingsTx = async () => (await h.list("transactions")).filter((t) => !t.deletedAt && /^Savings/.test(t.description || ""));
const capLine = async (page, id) => {
  await openCap(page);
  return num((await page.getByTestId(id).innerText()).split("\n").pop());
};
const errsOf = (logs) => logs.filter((l) => !IGNORE.test(l));
const pad = (n) => String(n).padStart(2, "0");
const ddmmyyyy = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

scenario("sav-1-create-and-empty", "Savings: empty state → new-goal side sheet → stored with safe defaults", async ({ page, logs }, chk) => {
  await openSavings(page);
  chk("empty state invites the first goal", (await page.getByTestId("savings-empty").count()) === 1);
  chk("the money picture shows even before any goal", (await page.getByTestId("savings-capacity").count()) === 1);
  await h.shot(page, "sav-1-empty-light");

  await page.getByTestId("new-goal").first().click();
  await page.getByTestId("savings-goal-form").waitFor();
  const sw = (await page.getByTestId("savings-sheet").boundingBox()).width;
  chk("the composer opens as a side sheet, not a full-width inline form", (await page.getByTestId("savings-sheet").count()) === 1 && sw <= 520, String(sw));
  chk("optional settings stay collapsed (lock switch hidden until expanded)", (await page.getByTestId("goal-lock").count()) === 0 && (await page.getByTestId("goal-more-plan").count()) === 1);
  await page.getByTestId("goal-more-plan").getByRole("button").first().click();
  chk("expanding reveals the lock switch", (await page.getByTestId("goal-lock").count()) === 1);
  await page.getByTestId("goal-submit").click();
  chk("an empty form is refused with a clear message", /name/i.test(await page.getByTestId("goal-form-error").innerText()));
  await page.getByTestId("goal-name").fill("Laptop");
  await page.getByTestId("goal-target").fill("0");
  await page.getByTestId("goal-submit").click();
  chk("a zero target is refused", /target/i.test(await page.getByTestId("goal-form-error").innerText()));
  chk("nothing was written for the invalid attempts", (await h.list("savingsGoals")).length === 0);
  await page.getByTestId("goal-target").fill("50000");
  await h.shot(page, "sav-1-composer-light");
  await page.getByTestId("goal-submit").click();
  await page.getByTestId("savings-goal-form").waitFor({ state: "hidden" });
  await page.waitForTimeout(900);

  const g = await goalDoc("Laptop");
  chk("goal stored with target 50,000, opening 0, current 0, open, no plan, unlocked", g && g.targetAmount === 50000 && g.openingAmount === 0 && g.currentAmount === 0 && g.isCompleted === false && g.isArchived === false && g.monthlyTarget == null && g.locked === false && g.kind === "goal", JSON.stringify(g && { t: g.targetAmount, o: g.openingAmount, c: g.currentAmount, m: g.monthlyTarget, l: g.locked, k: g.kind }));
  chk("the goal card appears without a reload and the same sheet moves on to Add money", (await card(page, "Laptop").count()) === 1 && (await page.getByTestId("savings-money-panel").count()) === 1 && (await page.getByTestId("savings-sheet").count()) === 1);
  chk("summary shows ₹0 saved of ₹50,000", /₹0/.test(await page.getByTestId("total-saved").innerText()) && /50,000/.test(await page.getByTestId("savings-summary").innerText()));
  chk("no console errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 3).join(" || "));
  await h.shot(page, "sav-1-created-light");
});

scenario("sav-2-money-flows", "Savings: set-aside moves nothing; a real transfer moves exactly once; withdraw; undo — verified in stored documents", async ({ page, logs }, chk, notes) => {
  await openSavings(page);
  await createGoal(page, "Laptop", 50000);
  const bank0 = await bal("QA Bank");
  const cash0 = await bal("QA Cash");
  const net0 = bank0 + cash0;
  const goalId = (await goalDoc("Laptop")).id;

  // 1. Set aside ₹10,000 from QA Bank — a reservation: no transaction, no balance change.
  let box = await addMoney(page, "Laptop", { amount: 10000, mode: "earmark", account: "QA Bank" });
  chk("preview says no money moves", /No money moves/.test(await page.getByTestId("savings-preview").innerText()));
  await submitMoney(page, box);
  chk("set-aside wrote NO transaction", (await savingsTx()).length === 0);
  chk("balances unchanged (persisted)", close2(await bal("QA Bank"), bank0) && close2(await bal("QA Cash"), cash0), `${await bal("QA Bank")} / ${await bal("QA Cash")}`);
  let entries = await entriesOf(goalId);
  chk("one earmark entry stored: in, 10,000, QA Bank, not emergency", entries.length === 1 && entries[0].mode === "earmark" && entries[0].direction === "in" && entries[0].amount === 10000 && entries[0].transactionIds.length === 0 && entries[0].emergency === false, JSON.stringify(entries.map((e) => [e.mode, e.amount])));
  chk("card now shows ₹10,000", /10,000/.test(await card(page, "Laptop").getByTestId("goal-saved").innerText()));

  // 2. A set-aside cannot exceed the free money left in the account.
  box = await addMoney(page, "Laptop", { amount: bank0, mode: "earmark", account: "QA Bank" });
  const err = await page.getByTestId("savings-error").innerText();
  const freeLeft = (bank0 - 10000).toLocaleString("en-IN");
  chk(`over-reserving is refused and names the free amount (${freeLeft})`, err.includes(freeLeft), err);
  await box.getByRole("button", { name: "Cancel", exact: true }).click();
  await box.waitFor({ state: "hidden" });

  // 3. Real transfer QA Bank → QA Cash ₹5,000.
  box = await addMoney(page, "Laptop", { amount: 5000, mode: "transfer", from: "QA Bank", into: "QA Cash" });
  chk("preview says it's a transfer, not an expense", /transfer/.test(await page.getByTestId("savings-preview").innerText()) && /not an expense/.test(await page.getByTestId("savings-preview").innerText()));
  await submitMoney(page, box);
  await page.waitForTimeout(400);
  chk("QA Bank −5,000 and QA Cash +5,000 (persisted)", close2(await bal("QA Bank"), bank0 - 5000) && close2(await bal("QA Cash"), cash0 + 5000), `${await bal("QA Bank")} / ${await bal("QA Cash")}`);
  chk("net worth unchanged by the transfer", close2((await bal("QA Bank")) + (await bal("QA Cash")), net0));
  const legs = await savingsTx();
  chk("exactly two linked legs (expense + income) share one transferId", legs.length === 2 && legs[0].transferId && legs[0].transferId === legs[1].transferId && new Set(legs.map((t) => t.type)).size === 2, JSON.stringify(legs.map((t) => [t.type, t.amount, !!t.transferId])));
  entries = await entriesOf(goalId);
  chk("entry links both legs", entries.length === 2 && entries.some((e) => e.mode === "transfer" && e.transactionIds.length === 2 && e.accountId && e.counterAccountId));
  chk("card shows ₹15,000", /15,000/.test(await card(page, "Laptop").getByTestId("goal-saved").innerText()));
  chk("goal cache (mobile app) tracks the total", (await goalDoc("Laptop")).currentAmount === 15000);

  // 4. The panel: history + held-in breakdown (after a save it lands on History).
  await openPanel(page, "Laptop", "history");
  const ptext = await panel(page).innerText();
  chk("panel lists both entries and the real transfer", (await page.getByTestId("savings-entry").count()) === 2 && /real transfer/.test(ptext));
  chk("panel shows where the money is held (QA Bank 10,000 · QA Cash 5,000)", /QA Bank/.test(ptext) && /QA Cash/.test(ptext) && /10,000/.test(ptext) && /5,000/.test(ptext));
  await h.shot(page, "sav-2-panel-light");

  // 5. Withdraw ₹2,000 by releasing it from QA Bank — nothing moves.
  await panel(page).getByTestId("tab-withdraw").click();
  box = page.getByTestId("savings-money-panel");
  await box.waitFor();
  await box.getByRole("radio", { name: /QA Bank/ }).click();
  await box.getByTestId("savings-amount").fill("2000");
  await submitMoney(page, box);
  chk("release moved no money (balances as before)", close2(await bal("QA Bank"), bank0 - 5000) && close2(await bal("QA Cash"), cash0 + 5000));
  chk("goal now 13,000", /13,000/.test(await page.getByTestId("panel-saved").innerText()));
  await panel(page).getByTestId("tab-withdraw").click();
  await box.waitFor();
  await box.getByRole("radio", { name: /QA Bank/ }).click();
  await box.getByTestId("savings-amount").fill("9000");
  chk("withdrawing more than held there is refused", /held there|only has/i.test(await page.getByTestId("savings-error").innerText()));
  await box.getByRole("button", { name: "Cancel", exact: true }).click();
  await box.waitFor({ state: "hidden" });

  // 6. Undo the real transfer from Savings: both legs deleted, both balances restored.
  const transferRow = page.getByTestId("savings-entry").filter({ hasText: "real transfer" });
  await transferRow.getByRole("button", { name: "Undo transfer" }).click();
  const confirm = confirmDialog(page);
  await confirm.waitFor();
  chk("undo explains both balances are restored", /restored/.test(await confirm.innerText()));
  await confirm.getByRole("button", { name: "Undo transfer" }).click();
  await page.waitForTimeout(2200);
  chk("legs gone; QA Bank and QA Cash back to the start (persisted)", (await savingsTx()).length === 0 && close2(await bal("QA Bank"), bank0) && close2(await bal("QA Cash"), cash0), `${await bal("QA Bank")} / ${await bal("QA Cash")}`);
  chk("goal now 8,000 (10,000 set aside − 2,000 released)", /8,000/.test(await page.getByTestId("panel-saved").innerText()));
  const g = await goalDoc("Laptop");
  chk("cache matches (8,000)", g.currentAmount === 8000, g.currentAmount);
  notes.push(`entries after: ${JSON.stringify((await entriesOf(goalId)).map((e) => [e.mode, e.direction, e.amount]))}`);
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});

scenario("sav-3-reverse-in-transactions", "Savings: deleting the transfer in Transactions updates Savings live (no reload) and restores balances", async ({ page, logs }, chk) => {
  await openSavings(page);
  await createGoal(page, "Trip", 20000);
  const bank0 = await bal("QA Bank");
  const cash0 = await bal("QA Cash");
  const box = await addMoney(page, "Trip", { amount: 6000, mode: "transfer", from: "QA Bank", into: "QA Cash" });
  await submitMoney(page, box);
  chk("goal shows ₹6,000", /6,000/.test(await card(page, "Trip").getByTestId("goal-saved").innerText()));

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

  await h.go(page, "/savings");
  await page.getByRole("heading", { level: 1, name: "Savings" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1800);
  chk("goal no longer counts the reversed transfer (₹0)", /₹0\b/.test(await card(page, "Trip").getByTestId("goal-saved").innerText()), await card(page, "Trip").getByTestId("goal-saved").innerText());
  await openPanel(page, "Trip", "history");
  const reversed = page.locator('[data-testid="savings-entry"][data-reversed="true"]');
  chk("the entry stays visible, flagged as reversed", (await reversed.count()) === 1 && /deleted in Transactions/.test(await reversed.innerText()));
  chk("the insight explains the reversal", /reversed in Transactions/.test(await insightsText(page)));
  await h.shot(page, "sav-3-reversed-light");
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});

scenario("sav-4-lifecycle", "Savings: reach target → completes; edit; mark completed early; archive; delete — stored states", async ({ page, logs }, chk) => {
  await openSavings(page);
  const bankStart = await bal("QA Bank");
  await createGoal(page, "Phone", 3000);
  const box = await addMoney(page, "Phone", { amount: 3000, mode: "earmark", account: "QA Bank" });
  await submitMoney(page, box);
  let g = await goalDoc("Phone");
  chk("reaching the target completes the goal (stored)", g.isCompleted === true && g.completedAt != null);
  chk("it moved to Completed (Active count drops)", /Completed \(1\)/.test(await page.locator("main").innerText()));
  await closeSheet(page);
  await page.getByRole("radio", { name: /Completed/ }).click();
  await page.waitForTimeout(500);
  chk("completed tab shows the goal with 100%", (await card(page, "Phone").count()) === 1 && /100%/.test(await card(page, "Phone").innerText()));
  await h.shot(page, "sav-4-completed-light");

  // Edit (inline Edit tab): raising the target re-opens it.
  await openPanel(page, "Phone", "edit");
  await page.getByTestId("goal-target").fill("5000");
  chk("the editor warns the goal will reopen", /reopen/i.test(await page.getByTestId("savings-goal-form").innerText()));
  await page.getByTestId("goal-submit").click();
  await page.waitForTimeout(1500);
  g = await goalDoc("Phone");
  chk("raising the target reopened it (stored)", g.targetAmount === 5000 && g.isCompleted === false);

  // Mark completed early.
  await closeSheet(page);
  await page.getByRole("radio", { name: /Active/ }).click();
  await page.waitForTimeout(400);
  await openPanel(page, "Phone", "edit");
  await panel(page).getByRole("button", { name: /Mark completed/ }).click();
  const confirm = confirmDialog(page);
  await confirm.waitFor();
  chk("early close names the amounts", /3,000/.test(await confirm.innerText()) && /5,000/.test(await confirm.innerText()));
  await confirm.getByRole("button", { name: "Mark completed" }).click();
  await page.waitForTimeout(1300);
  g = await goalDoc("Phone");
  chk("closed early is stored", g.isCompleted === true && g.closedEarly === true);

  // Archive then delete.
  await closeSheet(page);
  await page.getByRole("radio", { name: /Completed/ }).click();
  await page.waitForTimeout(400);
  await openPanel(page, "Phone", "edit");
  await panel(page).getByRole("button", { name: /^Archive$/ }).click();
  await page.waitForTimeout(1300);
  g = await goalDoc("Phone");
  chk("archived is stored", g.isArchived === true);
  await closeSheet(page);
  await page.getByRole("radio", { name: /Archived/ }).click();
  await page.waitForTimeout(400);
  await openPanel(page, "Phone", "edit");
  await panel(page).getByRole("button", { name: /Delete goal/ }).click();
  const del = confirmDialog(page);
  await del.waitFor();
  chk("delete explains no account balance changes", /no account balance changes|Trash/i.test(await del.innerText()));
  await del.getByRole("button", { name: "Delete" }).last().click();
  await page.waitForTimeout(1500);
  chk("goal is soft-deleted (stored), accounts untouched", (await h.list("savingsGoals")).find((x) => x.name === "Phone")?.deletedAt != null && close2(await bal("QA Bank"), bankStart));
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});

for (const [scheme, vp] of [["light", { width: 1440, height: 900 }], ["dark", { width: 1440, height: 900 }], ["light", { width: 390, height: 844 }], ["dark", { width: 390, height: 844 }]]) {
  scenario(`sav-5-visual-${scheme}-${vp.width}`, `Savings: layout + theme (${scheme}, ${vp.width}px)`, async ({ page }, chk) => {
    await openSavings(page);
    await createGoal(page, "Emergency fund", 100000, { monthly: 5000, lock: true });
    await createGoal(page, "Bicycle", 20000, { monthly: 2000 });
    await createGoal(page, "Vacation", 40000);
    const box = await addMoney(page, "Emergency fund", { amount: 35000, mode: "earmark", account: "QA Bank" });
    await submitMoney(page, box);
    const box2 = await addMoney(page, "Bicycle", { amount: 800, mode: "earmark", account: "QA Bank" });
    await submitMoney(page, box2);
    await closeSheet(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("no horizontal page scroll", overflow <= 1, overflow);
    const ok = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, c: getComputedStyle(document.querySelector('[data-testid="savings-goal-card"]')).backgroundColor }));
    chk("page and cards render with a theme background", ok.bg !== "rgba(0, 0, 0, 0)" || ok.c !== "rgba(0, 0, 0, 0)", JSON.stringify(ok));
    if (vp.width >= 1024) {
      const hh = (await page.getByTestId("savings-hero").boundingBox()).height;
      chk("overview band is compact (< 260px)", hh < 260, `${Math.round(hh)}px`);
      const cb = await card(page, "Vacation").boundingBox();
      chk("the overview AND the goal cards fit one 1440×900 screen (no scrolling)", cb.y + cb.height <= vp.height, `cards end at ${Math.round(cb.y + cb.height)}px of ${vp.height}`);
      const cardH = (await card(page, "Bicycle").boundingBox()).height;
      chk("goal cards are compact (< 175px tall)", cardH < 175, `${Math.round(cardH)}px`);
    }
    await h.shot(page, `sav-5-page-${scheme}-${vp.width}`);
    await openPanel(page, "Emergency fund", "history");
    await page.waitForTimeout(500);
    await h.shot(page, `sav-5-panel-${scheme}-${vp.width}`);
    if (vp.width >= 1024) {
      const sb = await page.getByTestId("savings-sheet").boundingBox();
      chk("goal details open in a side sheet (<= 560px wide, full height) — not a page-wide panel", sb.width <= 560 && sb.height >= vp.height - 2, `${Math.round(sb.width)}×${Math.round(sb.height)}`);
    }
    await closeSheet(page);
    await page.getByTestId("open-allocate").click();
    await page.getByTestId("allocation-studio").waitFor();
    await page.waitForTimeout(600);
    const ov2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("allocation sheet fits (no horizontal scroll)", ov2 <= 1, ov2);
    await h.shot(page, `sav-5-allocate-${scheme}-${vp.width}`);
    await closeSheet(page);
    await page.getByTestId("new-goal").first().click();
    await page.getByTestId("savings-goal-form").waitFor();
    await page.waitForTimeout(500);
    await h.shot(page, `sav-5-newgoal-${scheme}-${vp.width}`);
  }, { viewport: vp, scheme });
}

scenario("sav-6-dashboard", "Savings: a goal due soon appears on the Dashboard's Needs-your-attention strip and links to Savings", async ({ page, logs }, chk) => {
  await openSavings(page);
  const due = new Date(Date.now() + 5 * 86400000);
  await createGoal(page, "Passport fee", 9000, { due: ddmmyyyy(due) });
  const g = await goalDoc("Passport fee");
  chk("due date stored as the picked local day", g && g.dueDate && new Date(g.dueDate).getDate() === due.getDate(), g && g.dueDate);
  chk("a monthly amount was suggested from the date and kept (no plan typed)", g && g.monthlyTarget === 9000, g && g.monthlyTarget);
  chk("card says '5 days left'", /5 days left/.test(await card(page, "Passport fee").innerText()), await card(page, "Passport fee").innerText());

  await h.go(page, "/dashboard");
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const strip = page.locator('section[aria-label="Needs your attention"]');
  chk("Dashboard attention strip lists the goal with its remaining amount", (await strip.count()) === 1 && /Passport fee/.test(await strip.innerText()) && /9,000/.test(await strip.innerText()), (await strip.innerText()).replace(/\s+/g, " ").slice(0, 200));
  await h.shot(page, "sav-6-dashboard-light");
  await strip.getByRole("button", { name: "Add money" }).click();
  await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/savings", null, { timeout: 30000 });
  chk("the CTA opens Savings", true);
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});

scenario("sav-7-money-picture", "Savings: Safe to save = free money − still due (no spending forecast), reconciled with stored balances; a set-aside lowers it exactly and moves nothing", async ({ page, logs }, chk, notes) => {
  await openSavings(page);
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="safe-to-save"]')?.textContent || ""), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await openCap(page);
  const accounts = (await h.list("accounts")).filter((a) => !a.deletedAt && a.type !== "card");
  const stored = accounts.reduce((s, a) => s + a.currentBalance, 0);
  const inAcc = await capLine(page, "cap-in-accounts");
  chk("'In your accounts' equals the stored non-card balances", close2(inAcc, stored), `${inAcc} vs ${stored}`);
  const reserved0 = await capLine(page, "cap-reserved");
  const due0 = await capLine(page, "cap-due");
  const safe0 = num(await page.getByTestId("safe-to-save").innerText());
  chk("nothing reserved yet", reserved0 === 0, reserved0);
  chk("safe to save = in accounts − reserved − due (no shortfall, no spending estimate)", close2(safe0, Math.max(0, inAcc - reserved0 - due0)), `${safe0} = ${inAcc} − ${reserved0} − ${due0}`);
  chk("no everyday-spending estimate line or editor exists", (await page.getByTestId("cap-buffer").count()) === 0 && (await page.getByRole("button", { name: "Edit spending buffer" }).count()) === 0);
  chk("there are commitments still due this cycle (seeded loans / EMI / bill)", due0 > 0, due0);
  const dueList = await page.getByTestId("cap-due-list").innerText();
  chk("the due list names the seeded commitments", /QA Electricity|QA Loan|QA Phone EMI|QA Personal Loan/.test(dueList), dueList.replace(/\s+/g, " ").slice(0, 200));
  chk("income received this cycle is shown (seeded salary ₹40,000)", /40,000/.test(await page.getByTestId("cap-this-cycle").innerText()), await page.getByTestId("cap-this-cycle").innerText());
  await h.shot(page, "sav-7-picture-light");
  chk("the working-out lives in a popover — the hero itself stays compact", (await page.getByTestId("savings-hero").boundingBox()).height < 260);
  notes.push(`in=${inAcc} reserved=${reserved0} due=${due0} safe=${safe0}`);

  // A set-aside: reserved +12,000, safe −12,000, balances unchanged.
  await page.keyboard.press("Escape");
  const bank0 = await bal("QA Bank");
  await createGoal(page, "Vehicle", 300000, { monthly: 5000 });
  const box = await addMoney(page, "Vehicle", { amount: 12000, mode: "earmark", account: "QA Bank" });
  await submitMoney(page, box);
  await page.waitForTimeout(800);
  await openCap(page);
  const reserved1 = await capLine(page, "cap-reserved");
  const safe1 = num(await page.getByTestId("safe-to-save").innerText());
  chk("reserved rises by 12,000", close2(reserved1, reserved0 + 12000), reserved1);
  chk("safe to save falls by 12,000", close2(safe1, safe0 - 12000), `${safe1} vs ${safe0 - 12000}`);
  chk("in your accounts unchanged (nothing moved)", close2(await capLine(page, "cap-in-accounts"), inAcc) && close2(await bal("QA Bank"), bank0));
  chk("plan card: ₹5,000 of ₹5,000 planned is not claimed — only ₹5,000 of the 12,000 counts toward the plan", /5,000/.test(await page.getByTestId("plan-on-track").innerText()), await page.getByTestId("plan-on-track").innerText());
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});

scenario("sav-8-allocate", "Savings: Allocate splits money across goals (suggested from plans), set-aside writes N entries with one allocationId, no transactions; transfer mode moves exactly", async ({ page, logs }, chk) => {
  await openSavings(page);
  await createGoal(page, "Bicycle", 20000, { monthly: 2000 });
  await createGoal(page, "Vehicle", 300000, { monthly: 5000 });
  await createGoal(page, "Emergency", 100000);
  const bank0 = await bal("QA Bank");
  const cash0 = await bal("QA Cash");
  const tx0 = (await h.list("transactions")).filter((t) => !t.deletedAt).length;

  await page.getByTestId("open-allocate").click();
  const studio = page.getByTestId("allocation-studio");
  await studio.waitFor();
  const line = (n) => studio.locator(`[data-testid="allocation-line"][data-goal-name="${n}"]`);
  chk("suggested amounts come from the monthly plans (2,000 / 5,000), none for the goal without a plan", (await line("Bicycle").getByTestId("allocation-amount").inputValue()) === "2000" && (await line("Vehicle").getByTestId("allocation-amount").inputValue()) === "5000" && (await line("Emergency").getByTestId("allocation-amount").inputValue()) === "");
  chk("the studio says nothing is saved until applied", /nothing is saved until you apply/i.test(await studio.innerText()));
  await line("Emergency").getByTestId("allocation-amount").fill("3000");
  chk("total shows ₹10,000", /10,000/.test(await page.getByTestId("allocation-total").innerText()), await page.getByTestId("allocation-total").innerText());
  await pickAccount(page, "Allocate from account", "QA Bank");
  chk("preview: no money moves", /No money moves/.test(await page.getByTestId("allocation-preview").innerText()));
  await h.shot(page, "sav-8-studio-light");
  await page.getByTestId("allocation-apply").click();
  await page.getByTestId("allocation-summary").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  chk("summary: ₹10,000 across 3 goals", /10,000/.test(await page.getByTestId("allocation-summary").innerText()) && /3 goals/.test(await page.getByTestId("allocation-summary").innerText()), await page.getByTestId("allocation-summary").innerText());
  const all = [];
  for (const n of ["Bicycle", "Vehicle", "Emergency"]) all.push(...(await entriesOf((await goalDoc(n)).id)));
  chk("three earmark entries, one shared allocationId, amounts 2,000/5,000/3,000", all.length === 3 && new Set(all.map((e) => e.allocationId)).size === 1 && all[0].allocationId && all.every((e) => e.mode === "earmark") && all.map((e) => e.amount).sort((a, b) => a - b).join() === "2000,3000,5000", JSON.stringify(all.map((e) => [e.amount, e.allocationId])));
  chk("no transactions written, balances unchanged", (await h.list("transactions")).filter((t) => !t.deletedAt).length === tx0 && close2(await bal("QA Bank"), bank0));
  chk("plan card: ₹7,000 of ₹7,000 planned, tiles show Done", /7,000/.test(await page.getByTestId("plan-on-track").innerText()) && (await card(page, "Bicycle").locator('[data-plan-status="done"]').count()) === 1);
  await studio.getByRole("button", { name: "Done" }).click();
  await studio.waitFor({ state: "hidden" });
  await closeSheet(page);

  // Transfer mode: QA Bank → QA Cash for one goal; exact move, net worth unchanged.
  await page.getByTestId("open-allocate").click();
  await studio.waitFor();
  await studio.getByRole("radio", { name: /Move money/ }).click();
  for (const n of ["Bicycle", "Vehicle", "Emergency"]) await line(n).getByTestId("allocation-amount").fill("");
  await line("Emergency").getByTestId("allocation-amount").fill("1500");
  await pickAccount(page, "Allocate move from account", "QA Bank");
  await pickAccount(page, "Allocate into account", "QA Cash");
  chk("preview: one transfer, not an expense", /1 transfer/.test(await page.getByTestId("allocation-preview").innerText()));
  await page.getByTestId("allocation-apply").click();
  await page.getByTestId("allocation-summary").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  chk("QA Bank −1,500 / QA Cash +1,500 (persisted), net worth unchanged", close2(await bal("QA Bank"), bank0 - 1500) && close2(await bal("QA Cash"), cash0 + 1500), `${await bal("QA Bank")} / ${await bal("QA Cash")}`);
  const legs = await savingsTx();
  chk("exactly one transfer pair", legs.length === 2 && legs[0].transferId === legs[1].transferId, legs.length);

  // Over the account's free money is refused.
  await studio.getByRole("button", { name: "Done" }).click();
  await studio.waitFor({ state: "hidden" });
  await closeSheet(page);
  await page.getByTestId("open-allocate").click();
  await studio.waitFor();
  await line("Emergency").getByTestId("allocation-amount").fill("90000");
  await pickAccount(page, "Allocate from account", "QA Cash");
  chk("more than the account's free money is refused", /free/i.test(await page.getByTestId("allocation-error").innerText()) && (await page.getByTestId("allocation-apply").isDisabled()));
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});

scenario("sav-9-lock-emergency", "Savings: a locked deposit-style fund blocks a plain withdrawal; an emergency release is recorded, flagged and moves no money", async ({ page, logs }, chk) => {
  await openSavings(page);
  const maturity = new Date();
  maturity.setFullYear(maturity.getFullYear() + 1);
  await createGoal(page, "Car fund", 0, { deposit: true, monthly: 5000, due: ddmmyyyy(maturity) });
  const g = await goalDoc("Car fund");
  chk("deposit fund stored: kind deposit, 5,000/mo, target 60,000, locked until maturity", g && g.kind === "deposit" && g.monthlyTarget === 5000 && g.targetAmount === 60000 && g.locked === true && g.lockedUntil != null, JSON.stringify(g && { k: g.kind, m: g.monthlyTarget, t: g.targetAmount, l: g.locked }));
  chk("card shows the lock badge", (await card(page, "Car fund").getByTestId("goal-locked").count()) === 1);
  const box = await addMoney(page, "Car fund", { amount: 5000, mode: "earmark", account: "QA Bank" });
  await submitMoney(page, box);
  const bank0 = await bal("QA Bank");

  await openPanel(page, "Car fund", "withdraw");
  const gate = page.getByTestId("savings-lock-gate");
  chk("withdraw shows the lock gate and says it's not a bank freeze", (await gate.count()) === 1 && /not frozen/i.test(await gate.innerText()));
  const wbox = page.getByTestId("savings-money-panel");
  chk("inputs are disabled until Emergency release is on", await wbox.getByTestId("savings-amount").isDisabled());
  await h.shot(page, "sav-9-locked-light");
  await page.getByTestId("savings-emergency").click();
  await wbox.getByRole("radio", { name: /QA Bank/ }).click();
  await wbox.getByTestId("savings-amount").fill("1200");
  await wbox.getByLabel("Note (optional)").fill("Hospital bill").catch(() => {});
  chk("the button says it's an emergency withdrawal", /emergency/i.test(await wbox.getByTestId("savings-money-submit").innerText()));
  await submitMoney(page, wbox);
  const entries = await entriesOf(g.id);
  const out = entries.find((e) => e.direction === "out");
  chk("withdrawal stored with emergency=true, release (no transaction)", out && out.emergency === true && out.mode === "earmark" && out.amount === 1200 && out.transactionIds.length === 0, JSON.stringify(out));
  chk("QA Bank balance unchanged by the release", close2(await bal("QA Bank"), bank0));
  chk("goal now 3,800 and still locked", /3,800/.test(await page.getByTestId("panel-saved").innerText()) && (await goalDoc("Car fund")).locked === true);
  await openPanel(page, "Car fund", "history");
  chk("history marks the emergency release", (await page.locator('[data-testid="savings-entry"][data-emergency="true"]').count()) === 1 && /Emergency release/.test(await panel(page).innerText()));
  await h.shot(page, "sav-9-history-light");

  // Unlock from Plan & lock, then a plain release works without the gate.
  await panel(page).getByTestId("tab-plan").click();
  await page.getByTestId("plan-lock").click();
  await page.getByTestId("lock-save").click();
  await page.waitForTimeout(1300);
  chk("unlock stored", (await goalDoc("Car fund")).locked === false);
  await panel(page).getByTestId("tab-withdraw").click();
  chk("no lock gate after unlocking", (await page.getByTestId("savings-lock-gate").count()) === 0);
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});

scenario("sav-10-plan-skip", "Savings: set a monthly plan in Plan & lock, skip this month (stored cycle key), undo skip", async ({ page, logs }, chk) => {
  await openSavings(page);
  await createGoal(page, "Bicycle", 20000);
  await openPanel(page, "Bicycle", "plan");
  await page.getByTestId("plan-monthly").fill("2000");
  await page.getByTestId("plan-save").click();
  await page.waitForTimeout(1300);
  let g = await goalDoc("Bicycle");
  chk("plan stored: 2,000/month with a start date", g.monthlyTarget === 2000 && g.planSince != null, JSON.stringify({ m: g.monthlyTarget, s: g.planSince }));
  chk("tile shows 'To save' for this month", (await card(page, "Bicycle").locator('[data-plan-status="due"]').count()) === 1);
  await page.getByTestId("plan-skip").click();
  await page.waitForTimeout(1300);
  g = await goalDoc("Bicycle");
  chk("skip stored as this cycle's start key", Array.isArray(g.skippedCycles) && g.skippedCycles.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(g.skippedCycles[0]), JSON.stringify(g.skippedCycles));
  chk("tile shows Skipped", (await card(page, "Bicycle").locator('[data-plan-status="skipped"]').count()) === 1);
  await h.shot(page, "sav-10-skipped-light");
  await page.getByTestId("plan-skip").click();
  await page.waitForTimeout(1300);
  chk("undo skip clears it", (await goalDoc("Bicycle")).skippedCycles.length === 0);
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});
