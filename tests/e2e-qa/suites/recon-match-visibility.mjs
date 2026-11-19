/**
 * Review & Import match visibility (2026-11-19). Local emulator + synthetic pasted rows only.
 *
 *  - recon-vis: a review opens on the first row FlowFi has a possible match for (not row 1); the "possible matches found"
 *    strip + chips jump between matched rows; a row with no match says so and keeps "Other matches found"; undecided rows
 *    read Possible match / Needs review (never "Undecided"); the selection survives a reload; nothing is written.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { choose, openImportConfirm } from "../lib/recon.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const CARD = /QA Credit Card •••• 4242/;
const comparing = (page) => page.getByTestId("existing-comparing").getAttribute("data-row-id");

async function paste(page, text) {
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(text);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("recon-row").first().waitFor({ timeout: 60000 });
}

async function discard(page) {
  await page.getByTestId("approval-dialog").waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  if (await page.getByRole("button", { name: "Discard this review" }).count()) {
    await page.getByRole("button", { name: "Discard this review" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor();
}

scenario("recon-vis", "A review opens on its first possible match; the found strip jumps between matches; no-match rows keep the others reachable; Needs review / Possible match labels; selection survives reload; zero writes", async ({ page }, chk) => {
  const d = ddmmyyyy(-4);
  // FlowFi already holds one ₹299 on the card (hand-typed through the real approval, like the other recon suites).
  const expense = (await h.list("categories")).find((c) => c.type === "expense" || c.type === "both")?.name;
  await paste(page, `${d}\tJIO PREPAID\t299.00 Dr`);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: CARD }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.evaluate((cat) => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith("flowfi.reconcile.v1."));
    const draft = JSON.parse(sessionStorage.getItem(key));
    const base = { kind: "import_new", linkedRecordId: null, notSameAck: true, rejectedRecordIds: [], category: cat, notes: "", bulkId: null, creditAs: null, notOwnTransferAck: true };
    for (const row of draft.rows) draft.decisions[row.id] = { ...base };
    sessionStorage.setItem(key, JSON.stringify(draft));
  }, expense);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Restored your review").waitFor({ timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending", null, { timeout: 60000 });
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-confirm").click();
  if (await dlg.getByTestId("approval-repeats").count()) await dlg.getByTestId("approval-repeats").getByRole("checkbox").click().catch(() => undefined);
  await dlg.getByTestId("approval-submit").click();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  await dlg.getByRole("button", { name: /Clear this review|Start a new review|Done/ }).first().click().catch(() => page.keyboard.press("Escape"));
  await discard(page);

  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  // Row 1 has nothing similar; row 3 (₹299, same day) is the detected match.
  await paste(page, [`${d}\tOFFICE CANTEEN\t41.00 Dr`, `${d}\tTAXI RIDE\t182.00 Dr`, `${d}\tJIO PREPAID\t299.00 Dr`].join("\n"));
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: CARD }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.getByTestId("existing-row").first().waitFor({ timeout: 30000 });

  const autoNext = page.getByTestId("auto-next");
  if ((await autoNext.getAttribute("aria-pressed")) !== "true") await autoNext.click(); // the default flow under test (the older suites start with it off)
  chk("opens on the matched row (row 3), not row 1", (await comparing(page)) === "r3", String(await comparing(page)));
  chk("row 3 is highlighted on the left", (await page.locator('[data-testid="recon-row"][data-row-id="r3"]').getAttribute("aria-selected")) === "true");
  chk("the FlowFi transaction is already on the right", (await page.locator('[data-testid="existing-row"]').filter({ hasText: /JIO PREPAID/ }).count()) === 1);
  const heads = (await page.getByRole("grid", { name: "Existing FlowFi transactions" }).getByRole("columnheader").allInnerTexts()).map((t) => t.trim());
  chk("right panel is a compact list: Date | Description | Amount | Match", JSON.stringify(heads.map((t) => t.toLowerCase())) === JSON.stringify(["date", "description", "amount", "match"]), JSON.stringify(heads));
  chk("no explanation block (no 'Possible duplicate' / ticks / found-strip)", (await page.getByTestId("existing-evidence").count()) === 0 && (await page.getByTestId("match-found-strip").count()) === 0 && !/Possible duplicate/.test(await page.getByTestId("existing-sheet").innerText()));
  chk("a small 'Possible match' mark beside the FlowFi transaction", /Possible match/.test(await page.locator('[data-testid="existing-row"]').filter({ hasText: /JIO PREPAID/ }).innerText()));
  chk("no bottom action dock", (await page.getByTestId("resolution-dock").count()) === 0);
  const decisionOf = (id) => page.locator(`[data-testid="recon-row"][data-row-id="${id}"] [data-testid="decision-chip"]`).innerText();
  const matchOf = (id) => page.locator(`[data-testid="recon-row"][data-row-id="${id}"] button[aria-label^="Compare row"]`).first().innerText();
  chk("labels: Match = Possible match / No match; Decision = Needs review; no 'Undecided'", (await matchOf("r3")) === "Possible match" && (await matchOf("r1")) === "No match" && (await decisionOf("r3")) === "Needs review" && (await decisionOf("r1")) === "Needs review" && !/Undecided/.test(await page.locator("body").innerText()));
  chk("nothing decided by opening it", (await page.locator('[data-testid="recon-row"]').evaluateAll((els) => els.every((e) => e.getAttribute("data-decision") === ""))));
  await h.shot(page, "vis-opens-on-match");

  // Row 1: no match → compact message, other matches reachable, chip/View match jump back.
  await page.locator('[data-testid="recon-row"][data-row-id="r1"]').click();
  chk("row 1: 'No match for Row 1'", /No match for Row 1/.test(await page.getByTestId("existing-empty").innerText()));
  chk("row 1: 'Other matches found' lists row 3", /Other matches found/i.test(await page.getByTestId("existing-other-rows").innerText()) && (await page.getByTestId("existing-other-row").count()) === 1);
  await h.shot(page, "vis-no-match-other-found");
  await page.getByTestId("existing-other-row").click();
  chk("clicking the other match returns to row 3", (await comparing(page)) === "r3");

  // Decide → feedback → next row waiting; Undo revisits the decided row.
  await choose(page, "keep_existing");
  chk("after Keep existing the review moves to the next row still waiting (wraps to row 1)", (await comparing(page)) === "r1", String(await comparing(page)));
  chk("row 3 now reads as decided (✓ Keep existing)", /Keep existing/.test(await page.locator('[data-testid="recon-row"][data-row-id="r3"] [data-testid="decision-chip"]').innerText()));
  chk("a concise confirmation with Undo appears", (await page.getByText(/Kept existing · Row 3/).count()) > 0);
  await h.shot(page, "vis-after-decision-next-row");
  await page.getByTestId("undo-decision").click();
  chk("Undo brings row 3 back, undecided and selected", (await comparing(page)) === "r3" && (await page.locator('[data-testid="recon-row"][data-row-id="r3"] [data-pending="true"]').count()) === 1);

  // Remove from review: the row leaves the list, counts follow, the next row is selected, nothing in FlowFi changes; Undo restores it.
  const pendingText = () => page.getByTestId("status-pending").innerText();
  const rowsNow = () => page.getByTestId("recon-row").count();
  const pendingBefore = Number((await pendingText()).match(/\d+/)[0]);
  const rowsBefore = await rowsNow();
  await page.locator('[data-testid="recon-row"][data-row-id="r2"]').click();
  await choose(page, "remove", "r2");
  await page.waitForTimeout(250);
  chk("Remove from review: the row leaves the list immediately", (await rowsNow()) === rowsBefore - 1 && (await page.locator('[data-testid="recon-row"][data-row-id="r2"]').count()) === 0);
  chk("…the pending count drops by one", Number((await pendingText()).match(/\d+/)[0]) === pendingBefore - 1, `${pendingBefore} → ${await pendingText()}`);
  chk("…the next row is selected", (await comparing(page)) !== "r2");
  chk("…a confirmation with Undo appears", (await page.getByText(/Removed from review · Row 2/).count()) > 0);
  await h.shot(page, "vis-removed-from-review");
  chk("…nothing in FlowFi changed", (await h.list("transactions")).length === before[0].length);
  await page.getByTestId("undo-decision").click();
  chk("Undo restores the row and selects it", (await rowsNow()) === rowsBefore && (await comparing(page)) === "r2");

  // Import as transaction: the row's editor opens (date, description, amount, category, owner, notes) and records the draft.
  await openImportConfirm(page, "r1");
  chk("Import as transaction opens the editor with the existing fields", (await page.getByRole("textbox", { name: "Description" }).count()) > 0 && (await page.getByLabel("Amount").count()) > 0 && (await page.getByTestId("editor-ownership").count()) === 1);
  await h.shot(page, "vis-import-editor");
  const confirm = page.getByTestId("import-confirm");
  const category = await confirm.getByLabel("Category for import").locator("option").nth(1).getAttribute("value");
  await confirm.getByLabel("Category for import").selectOption(category);
  await page.getByTestId("import-confirm-submit").click();
  await page.waitForTimeout(400);
  chk("…confirming records Import (draft only) and closes the editor", (await page.locator('[data-testid="recon-row"][data-row-id="r1"]').getAttribute("data-decision")) === "import_new" && (await page.getByTestId("row-editor-panel").count()) === 0 || !(await page.getByTestId("row-editor-panel").isVisible()));
  chk("…still nothing written", (await h.list("transactions")).length === before[0].length);

  // The selection survives a reload of the unfinished review.
  await page.locator('[data-testid="recon-row"][data-row-id="r2"]').click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Restored your review").waitFor({ timeout: 120000 });
  await page.getByTestId("existing-comparing").waitFor({ timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  chk("reload keeps the row the user was on (row 2)", (await comparing(page)) === "r2", String(await comparing(page)));

  const after = await Promise.all([h.list("transactions"), h.list("accounts")]);
  chk("nothing written: transactions unchanged", after[0].length === before[0].length, `${before[0].length} → ${after[0].length}`);
  await discard(page);
});
