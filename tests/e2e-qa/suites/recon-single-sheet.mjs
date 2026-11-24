/**
 * Review & Import — single-sheet workspace (2026-11-24). Local emulator + synthetic pasted rows only.
 *
 *  - rss-layout: ONE table (no Existing FlowFi sheet / divider); the match chip expands an inline review directly under
 *    its row, inside the table's own scroll body (no nested scroller, decision buttons reachable, last row reachable,
 *    scroll position kept on collapse); the summary/filter strip counts are real; nothing is written while reviewing.
 *  - rss-import: ₹299 vs FlowFi ₹300 → Possible match; Keep both needs the acknowledgement; the real final approval
 *    writes only the statement rows (FlowFi's ₹300 untouched); uploading the same statement again never imports twice.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const CARD = /QA Credit Card •••• 4242/;

async function paste(page, text) {
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(text);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("recon-row").first().waitFor({ timeout: 60000 });
}

async function chooseCard(page) {
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: CARD }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
}

async function discard(page) {
  await page.getByTestId("approval-dialog").waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  if (await page.getByRole("button", { name: "Discard this review" }).count()) {
    await page.getByRole("button", { name: "Discard this review" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor();
}

/** Puts one ₹300 "GROCERY PURCHASE" on the QA card through the real final approval (the "already recorded by hand" transaction). */
async function seedGrocery(page, d) {
  const expense = (await h.list("categories")).find((c) => c.type === "expense" || c.type === "both")?.name;
  await paste(page, `${d}\tGROCERY PURCHASE\t300.00 Dr`);
  await page.setViewportSize({ width: 1600, height: 900 });
  await chooseCard(page);
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
  const dlg = await approve(page);
  await closeApproval(page, dlg);
  await discard(page);
  return expense;
}

async function approve(page) {
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-confirm").click();
  if (await dlg.getByTestId("approval-repeats").count()) await dlg.getByTestId("approval-repeats").getByRole("checkbox").click().catch(() => undefined);
  await dlg.getByTestId("approval-submit").click();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  return dlg;
}

async function closeApproval(page, dlg) {
  await dlg.getByRole("button", { name: /Clear this review|Start a new review|Done/ }).first().click().catch(() => page.keyboard.press("Escape"));
}

const rowLoc = (page, id) => page.locator(`[data-testid="recon-row"][data-row-id="${id}"]`);
const chipOf = (page, id) => rowLoc(page, id).getByRole("button", { name: /^Compare row/ });

scenario("rss-layout", "Single sheet: one table, inline review under the row inside the table's own scroll body, decision buttons + last row reachable, scroll kept, real filter counts, zero writes", async ({ page }, chk) => {
  const d = ddmmyyyy(-4);
  await seedGrocery(page, d);
  const before = await h.list("transactions");

  // A 30-row statement so the table has to scroll: row 3 is the ₹299 "UPI GROCERY STORE" (possible match for FlowFi's ₹300).
  const lines = [];
  for (let n = 1; n <= 30; n++) lines.push(n === 3 ? `${d}\tUPI GROCERY STORE\t299.00 Dr` : `${d}\tSHOP NUMBER ${n}\t${(1000 + n * 7).toFixed(2)} Dr`);
  await paste(page, lines.join("\n"));
  await page.setViewportSize({ width: 1440, height: 800 });
  await chooseCard(page);

  chk("no second Existing FlowFi sheet, no divider", (await page.getByTestId("existing-sheet").count()) === 0 && (await page.getByRole("separator", { name: "Resize the sheets" }).count()) === 0);
  chk("exactly one transaction grid", (await page.getByRole("grid").count()) === 1);
  const heads = (await page.getByRole("grid", { name: "Statement rows" }).getByRole("columnheader").allInnerTexts()).map((t) => t.trim().toLowerCase()).filter((t) => t && t !== "details");
  chk("columns: # · Date · Description · Amount · Type · Match · Decision", JSON.stringify(heads) === JSON.stringify(["#", "date", "description", "amount", "type", "match", "decision"]), JSON.stringify(heads));

  const strip = page.getByTestId("review-filter-strip");
  const count = async (id) => Number((await strip.getByTestId(`${id}-count`).innerText()).trim());
  chk("summary strip: Captured 30, Possible ≥ 1, Needs review = rows still undecided", Number(await strip.getByTestId("rf-captured").innerText()) === 30 && (await count("rf-possible")) >= 1 && (await count("rf-open")) === 30, `${await count("rf-possible")} possible / ${await count("rf-open")} open`);
  await h.shot(page, "rss-layout-collapsed");

  // Open the inline review for the ₹299 row.
  const body = page.getByTestId("recon-grid-body");
  await chipOf(page, "r3").click();
  const panel = page.getByTestId("inline-review");
  await panel.waitFor();
  await page.waitForTimeout(250);
  chk("the review opens directly under its row, in the same scroll body", await page.evaluate(() => {
    const row = document.querySelector('[data-row-id="r3"]');
    const p = document.querySelector('[data-testid="inline-review"]');
    return row?.nextElementSibling === p && document.querySelector('[data-testid="recon-grid-body"]')?.contains(p);
  }));
  chk("the comparison shows Existing FlowFi vs Imported statement with the ₹1 difference highlighted", await page.evaluate(() => {
    const a = document.querySelector('[data-testid="inline-compare"] [data-field="amount"]');
    return a?.getAttribute("data-verdict") === "diff" && /300\.00/.test(a.textContent) && /299\.00/.test(a.textContent);
  }));
  const inside = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="recon-grid-body"]').getBoundingClientRect();
    const btns = document.querySelector('[data-testid="inline-decisions"]').getBoundingClientRect();
    return { top: btns.top >= b.top - 1, bottom: btns.bottom <= Math.min(b.bottom, window.innerHeight) + 1, vh: window.innerHeight };
  });
  chk("the decision buttons are fully visible inside the table and the viewport (not clipped, not below the fold)", inside.top && inside.bottom, JSON.stringify(inside));
  chk("no nested scrolling: the panel adds no scroller of its own", await page.evaluate(() => {
    const p = document.querySelector('[data-testid="inline-review"]');
    return [p, ...p.querySelectorAll("*")].every((el) => {
      const o = getComputedStyle(el).overflowY;
      return !(o === "auto" || o === "scroll") || el.scrollHeight <= el.clientHeight + 1;
    });
  }));
  chk("the sticky column header does not overlap the panel", await page.evaluate(() => {
    const head = document.querySelector('[role="columnheader"]').getBoundingClientRect();
    const p = document.querySelector('[data-testid="inline-review"]').getBoundingClientRect();
    return head.bottom <= p.top + 1;
  }));
  await h.shot(page, "rss-layout-expanded");

  // Scroll to the very end with the panel open: the last row must be reachable and the panel stays attached to row 3.
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
  chk("the final statement row is reachable with a review open", await page.evaluate(() => {
    const last = document.querySelector('[data-row-id="r30"]').getBoundingClientRect();
    const b = document.querySelector('[data-testid="recon-grid-body"]').getBoundingClientRect();
    return last.bottom <= b.bottom + 1 && last.top >= b.top - 1;
  }));
  await body.evaluate((el) => { el.scrollTop = 300; });
  const yOf = () => page.evaluate(() => document.querySelector('[data-row-id="r12"]').getBoundingClientRect().top);
  const yBefore = await yOf();
  // Click through the DOM: Playwright would first scroll the (off-screen) close button into view and move the table itself.
  await page.evaluate(() => document.querySelector('[data-testid="inline-review-close"]').click());
  await page.waitForTimeout(250);
  const yAfter = await yOf();
  chk("collapsing a review above the viewport does not make the visible rows jump (±2px)", Math.abs(yAfter - yBefore) <= 2, `row 12 at ${yBefore} → ${yAfter}`);

  // A review near the bottom: still reachable.
  await rowLoc(page, "r29").scrollIntoViewIfNeeded();
  await chipOf(page, "r29").click().catch(() => undefined); // r29 has no possible match; its chip says "No match" and opens the no-candidate panel
  await page.getByTestId("inline-review").waitFor();
  await page.waitForTimeout(250);
  chk("a review opened on a row near the bottom keeps its decision buttons on screen", await page.evaluate(() => {
    const b = document.querySelector('[data-testid="recon-grid-body"]').getBoundingClientRect();
    const btns = document.querySelector('[data-testid="inline-decisions"]').getBoundingClientRect();
    return btns.bottom <= Math.min(b.bottom, window.innerHeight) + 1 && btns.top >= b.top - 1;
  }));
  await page.getByTestId("inline-review-close").click();

  // Filters focus the unresolved rows.
  await strip.getByTestId("rf-possible").click();
  const shown = await page.getByTestId("recon-row").count();
  chk("Possible matches filter shows exactly the counted rows", shown === (await count("rf-possible")) && shown >= 1, String(shown));
  await strip.getByTestId("rf-all").click();
  chk("All restores every row", (await page.getByTestId("recon-row").count()) === 30);

  // A decision moves the counts; Keep existing never edits FlowFi.
  await chipOf(page, "r3").click();
  await page.getByTestId("inline-keep-existing").click();
  await page.waitForTimeout(250);
  chk("Keep existing: row reads Keep existing, Needs review drops by one, Ready rises by one", /Keep existing/.test(await rowLoc(page, "r3").getByTestId("decision-chip").innerText()) && (await count("rf-open")) === 29 && (await count("rf-ready")) === 1);
  chk("the panel collapsed after deciding", (await page.getByTestId("inline-review").count()) === 0);

  const after = await h.list("transactions");
  chk("nothing written while reviewing and deciding", after.length === before.length, `${before.length} → ${after.length}`);
  await h.shot(page, "rss-layout-decided");
  await discard(page);
});

scenario("rss-import", "₹299 vs ₹300: Possible match → Keep both (acknowledged) → real approval imports only the statement rows; FlowFi's ₹300 untouched; the same statement uploaded again never imports twice", async ({ page }, chk) => {
  const d = ddmmyyyy(-4);
  const category = await seedGrocery(page, d);
  const grocery = (await h.list("transactions")).find((t) => /GROCERY PURCHASE/i.test(t.description ?? ""));
  chk("setup: FlowFi holds the hand-recorded ₹300 grocery", !!grocery && Number(grocery.amount) === 300, JSON.stringify(grocery?.amount));
  const before = await h.list("transactions");

  const statement = [`${d}\tUPI GROCERY STORE\t299.00 Dr`, `${d}\tOFFICE CANTEEN\t41.00 Dr`].join("\n");
  await paste(page, statement);
  await page.setViewportSize({ width: 1600, height: 900 });
  await chooseCard(page);

  await chipOf(page, "r1").click();
  await page.getByTestId("inline-review").waitFor();
  await page.getByTestId("inline-import").click();
  const form = page.getByTestId("inline-import-form");
  await form.getByLabel("Category for import").selectOption(category);
  chk("Keep both cannot be confirmed without the explicit acknowledgement", await form.getByTestId("import-confirm-submit").isDisabled());
  await form.getByRole("checkbox", { name: "These are separate transactions" }).click();
  await form.getByTestId("import-confirm-submit").click();
  chk("row 1 reads Keep both", /Keep both/.test(await rowLoc(page, "r1").getByTestId("decision-chip").innerText()));

  // Row 2 has no match: import it with just a category.
  await chipOf(page, "r2").click();
  await page.getByTestId("inline-import").click();
  await page.getByTestId("inline-import-form").getByLabel("Category for import").selectOption(category);
  await page.getByTestId("inline-import-form").getByTestId("import-confirm-submit").click();
  chk("row 2 reads Import new", /Import new/.test(await rowLoc(page, "r2").getByTestId("decision-chip").innerText()));
  chk("nothing written before final approval", (await h.list("transactions")).length === before.length);

  const dlg = await approve(page);
  const outcomes = await dlg.getByTestId("approval-outcome").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-row-id")}:${e.getAttribute("data-outcome")}`));
  chk("both rows imported", outcomes.includes("r1:imported") && outcomes.includes("r2:imported"), outcomes.join(", "));
  const mid = await h.list("transactions");
  chk("exactly two new transactions", mid.length === before.length + 2, `${before.length} → ${mid.length}`);
  const groceryAfter = mid.find((t) => t.id === grocery.id);
  chk("FlowFi's hand-recorded ₹300 is untouched (amount, description, date)", groceryAfter && Number(groceryAfter.amount) === 300 && groceryAfter.description === grocery.description && JSON.stringify(groceryAfter.dateTime) === JSON.stringify(grocery.dateTime));
  await h.shot(page, "rss-import-approved");
  await closeApproval(page, dlg);
  await discard(page);

  // The same statement again: both rows are recognised as already imported and nothing more can be written.
  await paste(page, statement);
  await chooseCard(page);
  const states = await page.getByTestId("recon-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  chk("re-uploading the same statement marks every row Imported", states.length === 2 && states.every((s) => s === "already_imported"), states.join(","));
  chk("…and the Import action is not offered for them", (await page.getByTestId("inline-import").count()) === 0);
  const final = await h.list("transactions");
  chk("no duplicate financial movement after the second upload", final.length === mid.length, `${mid.length} → ${final.length}`);
  await discard(page);
});
