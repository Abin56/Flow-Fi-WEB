/**
 * Dual-sheet merge studio — final acceptance. Local emulator + synthetic rows only.
 *
 * Each scenario first creates a few "existing" card transactions through the real Phase 4 approval (the only write
 * path), then pastes a LARGE second statement (60 rows, long narrations) whose rows are exact duplicates, a same-day
 * repeat, near amounts, two near candidates for one row, and a date offset with a different spelling. The review phase
 * must write nothing.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
/** Keeps every row inside the card's OPEN bill even in the first days of a statement cycle. */
const safeOffset = (n) => (new Date().getDate() <= 4 ? 0 : n);
const D2 = safeOffset(-2);
const D3 = safeOffset(-3);

const BASE = [
  `${ddmmyyyy(D2)}\tZZ BLUE TOKAI COFFEE\t350.00 Dr`,
  `${ddmmyyyy(D2)}\tZZ FRESH MART GROCERIES\t1,240.00 Dr`,
  `${ddmmyyyy(D3)}\tZZ URBAN CLAP SERVICES\t899.00 Dr`,
  `${ddmmyyyy(D2)}\tZZ METRO FUEL STATION\t2,000.00 Dr`,
  `${ddmmyyyy(D2)}\tZZ METRO FUEL STATION\t2,000.40 Dr`,
].join("\n");

const LONG = "VERY LONG STATEMENT NARRATION UPI REF 4455667788 BENGALURU KARNATAKA ONLINE CARD PAYMENT";
/** The statement under review: r1/r2 exact + repeat, r3 near, r4 two near candidates, r5 date offset + spelling, then fillers. */
const bigStatement = () =>
  [
    `${ddmmyyyy(D2)}\tZZ BLUE TOKAI COFFEE\t350.00 Dr`,
    `${ddmmyyyy(D2)}\tZZ BLUE TOKAI COFFEE\t350.00 Dr`,
    `${ddmmyyyy(D2)}\tZZ FRESH MART\t1,240.50 Dr`,
    `${ddmmyyyy(D2)}\tZZ METRO FUEL\t2,000.20 Dr`,
    `${ddmmyyyy(D2)}\tURBANCLAP SVCS INDIA PVT LTD ${LONG}\t899.00 Dr`,
    ...Array.from({ length: 55 }, (_, i) => `${ddmmyyyy(D3 - (i % 3))}\tZZ FILLER ${String(i + 1).padStart(2, "0")} ${LONG}\t${(3000 + i * 41.5).toFixed(2)} Dr`),
  ].join("\n");

const rowLoc = (page, id) => page.locator(`[data-testid="recon-row"][data-row-id="${id}"]`);
const overflow = (page) =>
  page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth,
    inner: ["statement-sheet", "existing-sheet", "resolution-dock", "recon-grid-body", "existing-grid-body"].map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? el.scrollWidth - el.clientWidth : 0;
    }),
  }));

async function openStudio(page) {
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
}

async function pasteAndChoose(page, text) {
  await page.getByRole("textbox", { name: "Statement rows" }).fill(text);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"],[data-testid="recon-card"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
}

/** Creates the "existing" card transactions through the real approval, then clears the review. */
async function seedExisting(page) {
  const expense = (await h.list("categories")).find((c) => c.type === "expense" || c.type === "both")?.name;
  await openStudio(page);
  await pasteAndChoose(page, BASE);
  await page.evaluate((cat) => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith("flowfi.reconcile.v1."));
    const draft = JSON.parse(sessionStorage.getItem(key));
    const base = { kind: "import_new", linkedRecordId: null, notSameAck: true, rejectedRecordIds: [], category: cat, notes: "", bulkId: null, creditAs: null };
    for (const row of draft.rows) draft.decisions[row.id] = base;
    sessionStorage.setItem(key, JSON.stringify(draft));
  }, expense);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Restored your review").waitFor({ timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending", null, { timeout: 60000 });
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-confirm").click();
  const repeats = dlg.getByTestId("approval-repeats");
  if (await repeats.count()) await repeats.getByRole("checkbox").check();
  await dlg.getByTestId("approval-submit").click();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  const written = (await h.list("transactions")).filter((t) => /^ZZ (BLUE|FRESH|URBAN|METRO)/.test(t.description ?? ""));
  await dlg.getByRole("button", { name: /Clear this review|Start a new review|Done/ }).first().click().catch(() => page.keyboard.press("Escape"));
  if (await page.getByRole("button", { name: "Discard this review" }).count()) {
    await page.getByRole("button", { name: "Discard this review" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor();
  return written.length;
}

scenario(
  "recon-accept-viewports",
  "Dual-sheet acceptance: large statement, long narrations, duplicates / repeats / near matches at 1920, 1366, tablet and phone — no overflow, independent scrolling, divider, zero writes",
  async ({ page }, chk) => {
    chk("seeded 5 existing card transactions through the real approval", (await seedExisting(page)) === 5);
    const txnsBefore = (await h.list("transactions")).length;
    await page.setViewportSize({ width: 1920, height: 1080 });
    await pasteAndChoose(page, bigStatement());

    // ---- evidence on the sheets ----
    const states = {};
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) states[id] = await rowLoc(page, id).getAttribute("data-state");
    chk("exact duplicate + same-day repeat: both rows 'multiple' — never auto-decided", states.r1 === "multiple" && states.r2 === "multiple", JSON.stringify(states));
    chk("near amount is a suggestion (near), not a duplicate", states.r3 === "near_amount" || states.r3 === "same_merchant_date", states.r3);
    await rowLoc(page, "r1").click();
    const r1Existing = await page.getByTestId("existing-row").count();
    chk("r1's FlowFi sheet shows the one Blue Tokai transaction", r1Existing === 1, r1Existing);
    chk("selecting it highlights the repeat row r2 as a possible match too", (await rowLoc(page, "r2").getAttribute("data-related")) === "true");
    await rowLoc(page, "r4").click();
    chk("one row with two near candidates lists both", (await page.getByTestId("existing-row").count()) === 2);
    await rowLoc(page, "r3").click();
    chk("near amount shows the ₹0.50 difference", /₹0\.50/.test(await page.getByTestId("existing-sheet").innerText()));
    await rowLoc(page, "r5").click();
    const r5 = await page.getByTestId("existing-sheet").innerText();
    chk("date offset + different spelling: found, with the day difference", /URBAN CLAP/i.test(r5) && /1 day earlier/.test(r5), r5.slice(0, 200));

    // ---- each desktop viewport ----
    for (const vp of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
      const tag = `${vp.width}×${vp.height}`;
      await page.setViewportSize(vp);
      await page.waitForTimeout(500);
      await page.locator("main").evaluate((m) => m.scrollTo(0, 0));
      const body = await page.getByTestId("recon-grid-body").boundingBox();
      const row = await page.getByTestId("recon-row").first().boundingBox();
      const visible = Math.floor(body.height / row.height);
      chk(`${tag}: rows visible per sheet (${visible} × ${Math.round(row.height)}px)`, visible >= (vp.height <= 800 ? 5 : 10), JSON.stringify({ body: Math.round(body.height), row: row.height }));
      const ov = await overflow(page);
      chk(`${tag}: no horizontal overflow (page, sheets, dock)`, ov.doc <= 1 && ov.main <= 1 && ov.inner.every((o) => o <= 1), JSON.stringify(ov));
      const pageScroll = await page.locator("main").evaluate((m) => m.scrollHeight - m.clientHeight);
      chk(`${tag}: the page itself doesn't scroll — only the sheets do`, pageScroll <= 1, pageScroll);
      const truncated = await rowLoc(page, "r6").locator("[title]").first().evaluate((el) => el.scrollWidth > el.clientWidth);
      chk(`${tag}: long narration truncates in its cell (full text on hover)`, truncated);

      // Independent scroll + sticky header.
      const headerBefore = await page.locator('[data-testid="recon-grid"] > [role="row"]').first().boundingBox();
      await page.getByTestId("existing-mode-ledger").click();
      const existingTop = await page.getByTestId("existing-grid-body").evaluate((el) => el.scrollTop);
      await page.getByTestId("recon-grid-body").evaluate((el) => el.scrollBy(0, 600));
      await page.waitForTimeout(200);
      const scrolled = await page.getByTestId("recon-grid-body").evaluate((el) => el.scrollTop);
      const headerAfter = await page.locator('[data-testid="recon-grid"] > [role="row"]').first().boundingBox();
      chk(`${tag}: statement body scrolls; its column header stays put`, scrolled > 0 && Math.abs(headerAfter.y - headerBefore.y) < 1, JSON.stringify({ scrolled, before: headerBefore.y, after: headerAfter.y }));
      chk(`${tag}: the FlowFi sheet did not scroll with it`, (await page.getByTestId("existing-grid-body").evaluate((el) => el.scrollTop)) === existingTop);
      await page.getByTestId("existing-mode-matches").click();
      await page.getByTestId("recon-grid-body").evaluate((el) => el.scrollTo(0, 0));

      // Divider drag.
      const d = await page.getByTestId("sheet-divider").boundingBox();
      const leftBefore = (await page.getByTestId("statement-sheet").boundingBox()).width;
      await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
      await page.mouse.down();
      await page.mouse.move(d.x + d.width / 2 - 160, d.y + d.height / 2, { steps: 8 });
      await page.mouse.up();
      const leftAfter = (await page.getByTestId("statement-sheet").boundingBox()).width;
      chk(`${tag}: dragging the divider resizes the sheets (down to its readable minimum)`, leftAfter < leftBefore - 40 && leftAfter >= 470, JSON.stringify({ leftBefore, leftAfter }));
      const ov2 = await overflow(page);
      chk(`${tag}: still no sideways scroll at the narrower split`, ov2.inner.every((o) => o <= 1), JSON.stringify(ov2));
      await page.getByTestId("sheet-divider").focus();
      await page.keyboard.press("Home"); // the narrowest the statement sheet can get
      const descWidth = await rowLoc(page, "r6").locator("[title]").first().evaluate((c) => c.getBoundingClientRect().width);
      chk(`${tag}: at the narrowest split the description stays readable (≥ 100px)`, descWidth >= 100, Math.round(descWidth));
      await rowLoc(page, "r1").click();
      await h.shot(page, `accept-${vp.width}-narrow-split`);
      await page.getByTestId("sheet-divider").focus();
      await page.keyboard.press("End");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await rowLoc(page, "r3").click();
      await h.shot(page, `accept-${vp.width}`);
    }

    // ---- tablet + phone: tabs, no grids ----
    for (const vp of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
      const tag = `${vp.width}`;
      await page.setViewportSize(vp);
      await page.waitForTimeout(600);
      chk(`${tag}: no desktop grids — the sheets are tabs`, (await page.getByRole("grid").count()) === 0 && (await page.getByTestId("mobile-sheet-switch").count()) === 1);
      const ov = await overflow(page);
      chk(`${tag}: no horizontal overflow`, ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
      const header = await page.getByTestId("workspace-header").evaluate((el) => {
        const btns = [...el.querySelectorAll("a,button")].map((b) => b.getBoundingClientRect());
        return btns.some((a, i) => btns.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
      });
      chk(`${tag}: header actions don't overlap`, !header);
      await h.shot(page, `accept-${tag}-statement`);
      await page.getByTestId("mobile-tab-existing").click();
      chk(`${tag}: FlowFi tab keeps the selected row pinned`, /Row 3/.test(await page.getByTestId("mobile-context").innerText()));
      chk(`${tag}: FlowFi tab no overflow`, (await overflow(page)).doc <= 1);
      await h.shot(page, `accept-${tag}-flowfi`);
      await page.getByTestId("mobile-tab-statement").click();
    }

    chk("the whole review wrote NOTHING", (await h.list("transactions")).length === txnsBefore);
  },
  { viewport: { width: 1600, height: 1000 } },
);

scenario(
  "recon-accept-keyboard-a11y",
  "Dual-sheet acceptance (1366×768): keyboard across both sheets, Undo, focus inside popover / preview / approval dialogs, accessible names — zero writes",
  async ({ page }, chk) => {
    await seedExisting(page);
    const txnsBefore = (await h.list("transactions")).length;
    await page.setViewportSize({ width: 1366, height: 768 });
    await pasteAndChoose(page, bigStatement());

    // Keyboard across the sheets.
    await rowLoc(page, "r1").click();
    const grid = page.getByRole("grid", { name: "Statement rows" });
    await grid.focus();
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    chk("J moves the statement selection (r4)", (await rowLoc(page, "r4").getAttribute("aria-selected")) === "true");
    await page.keyboard.press("ArrowRight");
    chk("→ focuses the Existing FlowFi sheet", await page.getByRole("grid", { name: "Existing FlowFi transactions" }).evaluate((g) => g === document.activeElement));
    await page.keyboard.press("j");
    const picked = await page.locator('[data-testid="existing-row"][aria-selected="true"]').getAttribute("data-record-id");
    await page.keyboard.press("Enter");
    chk("Enter keeps the picked FlowFi transaction", /Keep existing/.test(await rowLoc(page, "r4").innerText()), picked);
    await page.keyboard.press("z");
    chk("Z undoes it", /Undecided/.test(await rowLoc(page, "r4").innerText()));
    await page.keyboard.press("ArrowLeft");
    chk("← returns to the statement sheet", await grid.evaluate((g) => g === document.activeElement));

    // Keep both confirmation: focus moves in, Escape closes, focus isn't dropped to <body>.
    await page.keyboard.press("b");
    const pop = page.getByTestId("import-confirm");
    await pop.waitFor();
    chk("B opens Keep both's confirmation with focus inside it", await pop.evaluate((el) => el.contains(document.activeElement)));
    chk("…its submit is disabled until the acknowledgement + category", await pop.getByTestId("import-confirm-submit").isDisabled());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    chk("Escape closes it", (await pop.count()) === 0);
    const focusAfter = await page.evaluate(() => document.activeElement?.tagName);
    chk("focus is not lost to <body> after closing", focusAfter !== "BODY", focusAfter);
    await h.shot(page, "accept-keyboard");

    // Preview dialog focus.
    await page.getByTestId("resolve-merge_details").click();
    const preview = page.getByTestId("resolution-preview");
    await preview.waitFor();
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    chk("Tab stays inside the preview dialog (focus trap)", await preview.evaluate((el) => el.contains(document.activeElement)));
    chk("preview dialog is named", (await page.getByRole("dialog", { name: /Merge details — preview only/ }).count()) === 1);
    chk("commit is disabled", await preview.getByTestId("preview-commit").isDisabled());
    await h.shot(page, "accept-merge-preview");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    chk("Escape closes the preview; focus returns to its button", await page.getByTestId("resolve-merge_details").evaluate((b) => b === document.activeElement));

    // Accessible names on every dock control and both grids.
    const unnamed = await page.getByTestId("resolution-dock").evaluate((dock) => [...dock.querySelectorAll("button")].filter((b) => !(b.getAttribute("aria-label") || b.textContent || "").trim()).length);
    chk("every dock button has an accessible name", unnamed === 0, unnamed);
    chk("the divider is an accessible separator with a value", (await page.getByRole("separator", { name: "Resize the sheets" }).getAttribute("aria-valuenow")) !== null);

    // Approval dialog focus (decide everything quickly: skip all via the bulk-free path — I on each row).
    await rowLoc(page, "r1").click();
    await grid.focus();
    for (let i = 0; i < 60; i++) await page.keyboard.press("i").then(() => page.keyboard.press("j"));
    await page.getByTestId("open-approval").click();
    const dlg = page.getByTestId("approval-dialog");
    await dlg.getByTestId("approval-nothing").or(dlg.getByTestId("approval-counts")).first().waitFor();
    chk("approval dialog takes focus", await dlg.evaluate((el) => el.contains(document.activeElement)));
    chk("approval dialog uses the new wording (Skipped / Kept existing)", /Skipped/.test(await dlg.innerText()) && /Kept existing/.test(await dlg.innerText()));
    await h.shot(page, "accept-approval-dialog");
    await page.keyboard.press("Escape");
    chk("the review wrote NOTHING", (await h.list("transactions")).length === txnsBefore);
  },
  { viewport: { width: 1366, height: 768 } },
);
