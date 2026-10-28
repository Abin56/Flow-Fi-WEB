/**
 * Pre-release safety scenarios for Smart Capture → Reconciliation → final approval. Local emulators + synthetic rows only.
 *
 *  - relsafe-source-replace: replacing the source asks first; "Keep my review" changes nothing; confirming starts clean.
 *  - relsafe-touch: phone toolbar controls are ≥ 44×44 with a visible label; desktop stays compact.
 *  - relsafe-approve: category + notes editing, a near-amount match, repeated genuine purchases, a row excluded in Smart
 *    Capture, an offline failure, then a double-clicked retry — and the exact documents/money that land. A second tab
 *    comparing the same rows afterwards sees them as already recorded, never as new.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
/** Keeps rows inside the card's OPEN bill even in the first days of a statement cycle. */
const safeOffset = (n) => (new Date().getDate() <= 3 ? 0 : n);

async function openCapture(page) {
  await page.evaluate(() => window.next.router.push("/smart-capture"));
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
}

async function extract(page, text) {
  await page.getByLabel("Pasted statement text").fill(text);
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByTestId("progress-ready").waitFor({ timeout: 60000 });
}

const reviewDescs = (page) => page.getByTestId("review-row").evaluateAll((lis) => lis.map((li) => `${li.dataset.description}:${li.dataset.status}`));

async function snapshotWrites() {
  const [txns, accounts, imports] = await Promise.all([h.list("transactions"), h.list("accounts"), h.list("documentImports")]);
  return JSON.stringify({ txns: txns.length, balances: accounts.map((a) => `${a.name}:${a.currentBalance}`).sort(), imports: imports.length });
}

scenario("relsafe-source-replace", "Smart Capture: Paste new statement asks first; Keep my review changes nothing; confirming replaces the rows cleanly; zero writes", async ({ page }, chk) => {
  const before = await snapshotWrites();
  await openCapture(page);
  await extract(page, [`${ddmmyyyy(-2)}\tZZ FIRST ONE\t100.00 Dr`, `${ddmmyyyy(-2)}\tZZ FIRST TWO\t200.00 Dr`, `${ddmmyyyy(-1)}\tZZ FIRST THREE\t300.00 Dr`].join("\n"));
  await page.getByTestId("review-row").nth(1).getByRole("checkbox").first().click();
  const reviewed = await reviewDescs(page);

  await page.getByTestId("paste-new").click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).first();
  await dialog.waitFor();
  chk("replacing asks first and says what is lost", /Paste a new statement\?/.test(await dialog.innerText()) && /rows/i.test(await dialog.innerText()));
  await dialog.getByRole("button", { name: "Keep my review" }).click();
  chk("Keep my review leaves rows and the exclusion untouched", JSON.stringify(await reviewDescs(page)) === JSON.stringify(reviewed), (await reviewDescs(page)).join(","));

  await page.getByTestId("paste-new").click();
  await dialog.getByRole("button", { name: "Start new paste" }).click();
  await page.getByLabel("Pasted statement text").waitFor();
  chk("confirming opens an empty paste box", (await page.getByLabel("Pasted statement text").inputValue()) === "");
  await extract(page, [`${ddmmyyyy(-1)}\tZZ SECOND A\t40.00 Dr`, `${ddmmyyyy(-1)}\tZZ SECOND B\t50.00 Dr`].join("\n"));
  const after = await reviewDescs(page);
  chk("only the new rows remain — no stale rows or exclusions", after.length === 2 && after.every((r) => /ZZ SECOND/.test(r) && !/excluded/.test(r)), after.join(","));
  chk("nothing written", (await snapshotWrites()) === before);
  await h.shot(page, "relsafe-source-replace");
}, { viewport: { width: 1366, height: 768 } });

scenario("relsafe-touch", "Smart Capture toolbar: ≥ 44×44 touch targets with visible labels on phones; compact 28px on desktop", async ({ page }, chk) => {
  await openCapture(page);
  await extract(page, Array.from({ length: 6 }, (_, i) => `${ddmmyyyy(-1)}\tZZ TOUCH ${i + 1}\t${100 + i}.00 Dr`).join("\n"));
  const measure = () =>
    page.locator('[data-testid="review-toolbar-actions"] button, [aria-pressed]').evaluateAll((els) =>
      els.filter((e) => e.offsetParent !== null).map((e) => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), text: e.innerText.trim(), label: e.getAttribute("aria-label") ?? "" };
      }),
    );
  const phone = await measure();
  chk("390: every toolbar control is at least 44×44", phone.length >= 5 && phone.every((b) => b.w >= 44 && b.h >= 44), JSON.stringify(phone));
  chk("390: icon controls show a visible text label (no tooltip needed)", phone.every((b) => b.text.length > 0), JSON.stringify(phone.map((b) => b.text)));
  chk("390: icon controls keep an accessible name", phone.filter((b) => b.label).length >= 3);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("390: no horizontal overflow", ov <= 1, ov);
  await h.shot(page, "relsafe-touch-390");

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(400);
  const desk = await measure();
  chk("1366: toolbar stays compact (28px tall)", desk.every((b) => b.h <= 30), JSON.stringify(desk.map((b) => b.h)));
  await page.locator('[data-testid="review-toolbar-actions"] button').first().focus();
  await page.keyboard.press("Tab");
  chk("1366: toolbar reachable by keyboard", await page.evaluate(() => !!document.activeElement?.closest('[data-testid="review-toolbar-actions"]')));
}, { viewport: { width: 390, height: 844 } });

scenario(
  "relsafe-approve",
  "Approval end to end (1600): category + notes, near-amount match, repeated genuine rows, excluded row, offline failure, double-clicked retry, exact money, second tab sees them recorded",
  async ({ page, ctx }, chk) => {
    const cats = await h.list("categories");
    const expense = cats.find((c) => c.type === "expense" || c.type === "both");
    const txnsBefore = (await h.list("transactions")).length;
    const cardBefore = (await h.accountBalance("QA Credit Card")).currentBalance;
    const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;

    // 1 near-amount (₹0.60 over the seeded ₹12,000 purchase, a day later) · 2–3 genuine repeats · 4 excluded · 5 category + notes.
    const rows = [
      `${ddmmyyyy(-11)}\tQA CARD PURCHASE BLR\t12,000.60 Dr`,
      `${ddmmyyyy(safeOffset(-1))}\tZZ REPEAT COFFEE\t180.00 Dr`,
      `${ddmmyyyy(safeOffset(-1))}\tZZ REPEAT COFFEE\t180.00 Dr`,
      `${ddmmyyyy(safeOffset(-2))}\tZZ EXCLUDED THING\t999.00 Dr`,
      `${ddmmyyyy(safeOffset(-2))}\tZZ NOTED SHOP\t250.00 Dr`,
    ];
    await openCapture(page);
    await extract(page, rows.join("\n"));
    await page.getByTestId("review-row").nth(3).getByRole("checkbox").first().click();
    await page.getByRole("button", { name: /Next: Check duplicates/ }).click();
    await page.getByTestId("handoff-notice").waitFor({ timeout: 240000 });
    chk("no account is chosen for the user", (await page.getByRole("button", { name: /Choose statement account/ }).count()) === 1);
    await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
    await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
    await page.waitForTimeout(800);

    const row = (n) => page.locator('[data-testid="recon-row"]').nth(n - 1);
    chk("near-amount row is a suggestion, not auto-decided", (await row(1).getAttribute("data-state")) === "near_amount", await row(1).getAttribute("data-state"));
    chk("excluded row stays excluded", (await row(4).getAttribute("data-state")) === "excluded");

    const importVia = async (n, ack) => {
      await row(n).click();
      await page.getByTestId(ack ? "resolve-keep_both" : "resolve-import_new").click();
      const pop = page.getByTestId("import-confirm");
      await pop.getByLabel("Category for import").selectOption({ label: expense.name });
      if (ack) {
        chk("near-amount Keep both can't be recorded until the user confirms they're separate", await pop.getByTestId("import-confirm-submit").isDisabled());
        await pop.getByRole("checkbox", { name: "These are separate transactions" }).check();
      }
      await pop.getByTestId("import-confirm-submit").click();
    };
    for (const n of [2, 3, 5]) await importVia(n, false);
    await page.getByRole("button", { name: /Expand row 5$/ }).click();
    await page.getByLabel("Notes").fill("QA note — keep the receipt");
    await page.getByRole("button", { name: "Done" }).click(); // the row sheet closes; the note is already in the draft
    chk("near-amount row: Import new is not offered while a match exists", await (async () => { await row(1).click(); return page.getByTestId("resolve-import_new").isDisabled(); })());
    chk("Review & approve waits for the near-amount row", await page.getByTestId("open-approval").isDisabled());
    await importVia(1, true);
    chk("…and allowed once confirmed", await page.getByTestId("open-approval").isEnabled());
    chk("deciding wrote nothing", (await h.list("transactions")).length === txnsBefore);

    await page.getByTestId("open-approval").click();
    const dlg = page.getByTestId("approval-dialog");
    await dlg.getByTestId("approval-counts").waitFor();
    chk("summary: 5 captured, 4 new, 1 excluded", /^5/.test(await dlg.getByTestId("count-captured").innerText()) && /^4/.test(await dlg.getByTestId("count-new").innerText()));
    await dlg.getByTestId("approval-confirm").click();

    // Genuine repeats need an explicit acknowledgement before they can import.
    const repeats = dlg.getByTestId("approval-repeats");
    chk("repeated identical rows are flagged, not silently imported", (await repeats.count()) === 1 && /2 rows/.test(await repeats.innerText()));
    chk("approve stays disabled until the repeats are acknowledged", await dlg.getByTestId("approval-submit").isDisabled());
    await repeats.getByRole("checkbox").check();

    // Offline: the server re-read fails → nothing written, Try again offered.
    await page.context().setOffline(true);
    await dlg.getByTestId("approval-submit").click();
    await dlg.getByTestId("approval-unavailable").waitFor({ timeout: 90000 });
    await page.context().setOffline(false);
    chk("offline approval writes nothing", (await h.list("transactions")).length === txnsBefore);
    await h.shot(page, "relsafe-approve-offline");
    await dlg.getByRole("button", { name: "Try again" }).dblclick(); // retry, double-clicked
    const submit = dlg.getByTestId("approval-submit");
    await submit.or(dlg.getByTestId("approval-result")).first().waitFor({ timeout: 90000 });
    if ((await dlg.getByTestId("approval-result").count()) === 0) {
      // Try again returned to the review: confirmations must be given again (never carried over silently).
      if (!(await dlg.getByTestId("approval-confirm").isChecked())) await dlg.getByTestId("approval-confirm").click();
      if ((await repeats.count()) && !(await repeats.getByRole("checkbox").isChecked())) await repeats.getByRole("checkbox").check();
      await submit.dblclick();
    }
    await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
    chk("complete", (await dlg.getByTestId("approval-result").getAttribute("data-status")) === "complete");
    await h.shot(page, "relsafe-approve-result");

    const all = await h.list("transactions");
    const fresh = all.filter((t) => t.id.startsWith("txn_imp_"));
    chk("exactly 4 written (retry + double click wrote once)", all.length === txnsBefore + 4 && fresh.length === 4, `${all.length - txnsBefore} / ${fresh.length}`);
    chk("the excluded row was never written", !all.some((t) => /EXCLUDED THING/i.test(t.description ?? "")));
    chk("both genuine repeats were written", fresh.filter((t) => /REPEAT COFFEE/i.test(t.description ?? "")).length === 2);
    const noted = fresh.find((t) => /NOTED SHOP/i.test(t.description ?? ""));
    chk("chosen category saved", !!noted && noted.categoryId === expense.id, noted?.categoryId);
    chk("user note saved with provenance", !!noted && /QA note — keep the receipt/.test(noted.notes) && /Imported via Reconciliation/.test(noted.notes), noted?.notes);
    chk("near-amount row written at the statement amount", fresh.some((t) => Math.abs(t.amount - 12000.6) < 0.001));
    chk("seeded ₹12,000 purchase untouched", all.filter((t) => t.description === "QA card purchase").length === 1);
    const expected = cardBefore - (12000.6 + 180 + 180 + 250);
    const cardAfter = (await h.accountBalance("QA Credit Card")).currentBalance;
    chk("card balance moved by exactly the 4 charges", Math.abs(cardAfter - expected) < 0.01, `${cardBefore} → ${cardAfter} (expected ${expected})`);
    chk("QA Bank untouched", (await h.accountBalance("QA Bank")).currentBalance === bankBefore);

    // A second tab comparing the same rows must see them as recorded, never as new.
    const tab = await ctx.newPage();
    await tab.goto(new URL("/reconciliation", page.url()).href, { waitUntil: "domcontentloaded", timeout: 240000 });
    await tab.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
    await tab.getByRole("textbox", { name: "Statement rows" }).fill([rows[1], rows[2], rows[4]].join("\n"));
    await tab.getByRole("button", { name: "Compare rows" }).click();
    await tab.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
    await tab.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
    await tab.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
    await tab.waitForTimeout(800);
    const states = await tab.locator('[data-testid="recon-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
    chk("second tab: every row shows a recorded match, none 'no match'", states.length === 3 && states.every((s) => s !== "no_match"), states.join(","));
    chk("second tab wrote nothing", (await h.list("transactions")).length === txnsBefore + 4);
    await h.shot(tab, "relsafe-second-tab");
    await tab.close();
  },
  { viewport: { width: 1600, height: 1000 } },
);
