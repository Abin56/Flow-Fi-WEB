/**
 * Reconciliation premium UI V2 — Focus Mode, browser fullscreen, collapsible comparison dock, compact bars and the
 * restyled sheets, at 1920×1080, 1366×768, 820 tablet and 390 phone. Local emulator + synthetic pasted rows only.
 * Every scenario ends by proving the review wrote nothing.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const rowsText = (n) => Array.from({ length: n }, (_, i) => `${ddmmyyyy(-3 - (i % 5))}\tPREMIUM STORE ${String(i + 1).padStart(2, "0")} UPI REF 99${i}\t${(1000 + i * 37.25).toFixed(2)} Dr`).join("\n");

const box = async (page, testId) => page.getByTestId(testId).first().boundingBox();
const overflow = (page) =>
  page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth,
    inner: ["statement-sheet", "existing-sheet", "resolution-dock", "recon-grid-body", "existing-grid-body", "account-bar", "recon-toolbar", "status-bar"].map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? el.scrollWidth - el.clientWidth : 0;
    }),
  }));
const chrome = (page) =>
  page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector('[data-testid="app-sidebar-slot"]')).display,
    topbar: getComputedStyle(document.querySelector('[data-testid="app-topbar-slot"]')).display,
    main: (({ left, top }) => ({ left: Math.round(left), top: Math.round(top) }))(document.querySelector("main").getBoundingClientRect()),
  }));
const focusOn = async (page) => (await page.getByTestId("recon-workspace").getAttribute("data-focus")) === "true";

async function openWith(page, text) {
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(text);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"],[data-testid="recon-card"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
}

/** The FIRST rows of rowsText(n) — written through the real Phase 4 approval so the review has exact matches to compare. */
async function seedExisting(page) {
  const expense = (await h.list("categories")).find((c) => c.type === "expense" || c.type === "both")?.name;
  await openWith(page, rowsText(3));
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
  await dlg.getByTestId("approval-submit").click();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  await dlg.getByRole("button", { name: /Clear this review|Start a new review|Done/ }).first().click().catch(() => page.keyboard.press("Escape"));
  if (await page.getByRole("button", { name: "Discard this review" }).count()) {
    await page.getByRole("button", { name: "Discard this review" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor();
}

async function nothingWritten(chk, before) {
  const after = await Promise.all([h.list("transactions"), h.list("accounts")]);
  chk("nothing written: transactions unchanged", after[0].length === before[0].length, `${before[0].length} → ${after[0].length}`);
  chk("nothing written: balances unchanged", JSON.stringify(after[1].map((a) => a.currentBalance).sort()) === JSON.stringify(before[1].map((a) => a.currentBalance).sort()));
}

scenario("recon-v2-desktop", "V2 desktop (1920, 1366): compact bars, dock collapse/expand, Focus Mode, Escape + focus return, fullscreen, divider, keyboard — zero writes", async ({ page }, chk) => {
  await seedExisting(page);
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  await openWith(page, rowsText(30));

  for (const vp of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    const tag = `${vp.width}×${vp.height}`;
    await page.setViewportSize(vp);
    await page.waitForTimeout(500);
    await page.getByTestId("recon-row").first().click(); // r1: an exact match for a seeded transaction

    // ---- normal mode, dock expanded ----
    const acct = await box(page, "account-bar");
    chk(`${tag}: account bar is one line (≤ 44px)`, acct.height <= 44, acct.height);
    const toolbar = await box(page, "recon-toolbar");
    chk(`${tag}: toolbar is one line (≤ 36px)`, toolbar.height <= 36, toolbar.height);
    const bar = await box(page, "status-bar");
    chk(`${tag}: approval bar is one line (≤ 48px)`, bar.height <= 48, bar.height);
    chk(`${tag}: approval bar on screen`, bar.y + bar.height <= vp.height + 1, JSON.stringify(bar));
    let ov = await overflow(page);
    chk(`${tag}: no horizontal overflow (page, sheets, dock, bars)`, ov.doc <= 1 && ov.main <= 1 && ov.inner.every((o) => o <= 1), JSON.stringify(ov));
    const dockExpanded = await box(page, "resolution-dock");
    const bodyExpanded = await box(page, "recon-grid-body");
    chk(`${tag}: dock shows the field diff when expanded`, (await page.getByTestId("field-diff").count()) === 1);
    await h.shot(page, `v2-${vp.width}-normal-dock-expanded`);

    // ---- dock collapsed: sheets get the room, actions stay ----
    await page.getByTestId("dock-toggle").click();
    await page.waitForTimeout(250);
    const dockCollapsed = await box(page, "resolution-dock");
    const bodyCollapsed = await box(page, "recon-grid-body");
    chk(`${tag}: collapsed dock is much shorter`, dockCollapsed.height < dockExpanded.height - 40, JSON.stringify({ expanded: dockExpanded.height, collapsed: dockCollapsed.height }));
    chk(`${tag}: the sheets grow into the freed space`, bodyCollapsed.height > bodyExpanded.height + 40, JSON.stringify({ before: bodyExpanded.height, after: bodyCollapsed.height }));
    for (const id of ["resolve-keep_existing", "resolve-keep_both", "resolve-import_new", "resolve-review_later", "resolve-skip", "undo-decision", "financial-effect"]) {
      chk(`${tag}: collapsed dock keeps ${id}`, (await page.getByTestId(id).count()) === 1 && (await page.getByTestId(id).isVisible()));
    }
    ov = await overflow(page);
    chk(`${tag}: collapsed: no horizontal overflow`, ov.inner.every((o) => o <= 1), JSON.stringify(ov));
    await h.shot(page, `v2-${vp.width}-normal-dock-collapsed`);
    // A decision from the collapsed dock, then Undo — draft only.
    await page.getByTestId("resolve-review_later").click();
    chk(`${tag}: collapsed dock decides (Review later)`, /Review later/.test(await page.locator('[data-testid="recon-row"][aria-selected="true"]').innerText()));
    await page.getByTestId("undo-decision").click();
    chk(`${tag}: Undo from the collapsed dock`, /Undecided/.test(await page.locator('[data-testid="recon-row"][aria-selected="true"]').innerText()));
    await page.getByRole("grid", { name: "Statement rows" }).focus();
    await page.keyboard.press("d");
    await page.waitForTimeout(200);
    chk(`${tag}: D expands the dock again`, (await page.getByTestId("resolution-dock").getAttribute("data-collapsed")) === "false");

    // ---- Focus Mode ----
    const sheetsBefore = await box(page, "dual-sheet");
    await page.getByTestId("focus-mode-toggle").click();
    await page.waitForTimeout(400);
    const c = await chrome(page);
    chk(`${tag}: Focus Mode hides sidebar + topbar`, c.sidebar === "none" && c.topbar === "none", JSON.stringify(c));
    chk(`${tag}: Focus Mode workspace starts at the viewport edge`, c.main.left === 0 && c.main.top === 0, JSON.stringify(c.main));
    const sheetsFocus = await box(page, "dual-sheet");
    chk(`${tag}: sheets get wider and taller in Focus Mode`, sheetsFocus.width > sheetsBefore.width + 100 && sheetsFocus.height > sheetsBefore.height + 40, JSON.stringify({ sheetsBefore, sheetsFocus }));
    chk(`${tag}: Exit Focus Mode is visible`, await page.getByRole("button", { name: "Exit Focus Mode" }).isVisible());
    const barFocus = await box(page, "status-bar");
    chk(`${tag}: Focus Mode keeps approval on screen`, barFocus.y + barFocus.height <= vp.height + 1 && (await page.getByTestId("open-approval").isVisible()), JSON.stringify(barFocus));
    ov = await overflow(page);
    chk(`${tag}: Focus Mode: no horizontal overflow`, ov.doc <= 1 && ov.main <= 1 && ov.inner.every((o) => o <= 1), JSON.stringify(ov));
    await h.shot(page, `v2-${vp.width}-focus-dock-expanded`);
    await page.getByTestId("dock-toggle").click();
    await page.waitForTimeout(200);
    await h.shot(page, `v2-${vp.width}-focus-dock-collapsed`);
    await page.getByTestId("dock-toggle").click();

    // Keyboard still works in Focus Mode; Escape inside a sheet does NOT leave it.
    await page.getByRole("grid", { name: "Statement rows" }).focus();
    for (let i = 0; i < 18; i++) await page.keyboard.press("j");
    await page.waitForTimeout(250);
    const selFar = await page.locator('[data-testid="recon-row"][aria-selected="true"]').boundingBox();
    const bodyFar = await box(page, "recon-grid-body");
    chk(`${tag}: Focus Mode: keyboard selection stays in view`, selFar.y >= bodyFar.y - 1 && selFar.y + selFar.height <= bodyFar.y + bodyFar.height + 1, JSON.stringify({ selFar, bodyFar }));
    for (let i = 0; i < 18; i++) await page.keyboard.press("k"); // back to r1, which has a FlowFi match to preview
    await page.keyboard.press("Escape");
    chk(`${tag}: Escape inside a sheet keeps Focus Mode`, await focusOn(page));
    // Escape with a dialog open closes the dialog only.
    await page.getByTestId("resolve-merge_details").click();
    await page.getByTestId("resolution-preview").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    chk(`${tag}: Escape closes the preview dialog, Focus Mode stays`, (await page.getByTestId("resolution-preview").count()) === 0 && (await focusOn(page)));
    // Divider drag in Focus Mode.
    const d = await box(page, "sheet-divider");
    const leftBefore = (await box(page, "statement-sheet")).width;
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.x + d.width / 2 + 120, d.y + d.height / 2, { steps: 8 });
    await page.mouse.up();
    const leftAfter = (await box(page, "statement-sheet")).width;
    chk(`${tag}: Focus Mode: divider drag resizes`, leftAfter > leftBefore + 40, JSON.stringify({ leftBefore, leftAfter }));
    ov = await overflow(page);
    chk(`${tag}: after drag: no sideways scroll`, ov.inner.every((o) => o <= 1), JSON.stringify(ov));
    // Escape outside the sheets leaves Focus Mode and returns focus to its toggle.
    await page.getByTestId("account-bar").click({ position: { x: 4, y: 4 } });
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    chk(`${tag}: Escape (outside the sheets) leaves Focus Mode`, !(await focusOn(page)));
    chk(`${tag}: focus returns to the Focus Mode toggle`, await page.getByTestId("focus-mode-toggle").evaluate((b) => b === document.activeElement));
    const c2 = await chrome(page);
    chk(`${tag}: sidebar + topbar back`, c2.sidebar !== "none" && c2.topbar !== "none", JSON.stringify(c2));

    // ---- browser fullscreen ----
    if ((await page.getByTestId("fullscreen-toggle").count()) === 0) {
      chk.finding("V2-FS", `${tag}: Fullscreen API available in this browser`, false, "button hidden (fullscreenEnabled false)");
    } else {
      await page.getByTestId("fullscreen-toggle").click();
      await page.waitForTimeout(600);
      const fs = await page.evaluate(() => document.fullscreenElement === document.documentElement);
      const notice = await page.getByTestId("fullscreen-notice").count();
      if (fs) {
        chk(`${tag}: fullscreen entered on click, with Focus Mode`, await focusOn(page));
        await h.shot(page, `v2-${vp.width}-fullscreen`);
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForTimeout(600);
        chk(`${tag}: leaving fullscreen leaves the Focus Mode it started`, !(await page.evaluate(() => !!document.fullscreenElement)) && !(await focusOn(page)));
      } else {
        chk(`${tag}: fullscreen refused → Focus Mode + notice (graceful)`, notice === 1 && (await focusOn(page)));
        await page.getByTestId("focus-mode-toggle").click();
      }
    }
    await page.getByTestId("recon-grid-body").evaluate((el) => el.scrollTo(0, 0));
  }
  await nothingWritten(chk, before);
});

scenario("recon-v2-small", "V2 tablet (820) + phone (390): Focus Mode with the two-tab model, no overflow — zero writes", async ({ page }, chk) => {
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  await openWith(page, rowsText(12));
  for (const vp of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    const tag = `${vp.width}`;
    await page.setViewportSize(vp);
    await page.waitForTimeout(600);
    chk(`${tag}: two-tab model`, (await page.getByTestId("mobile-sheet-switch").count()) === 1 && (await page.getByRole("grid").count()) === 0);
    await h.shot(page, `v2-${tag}-normal`);
    await page.getByTestId("focus-mode-toggle").click();
    await page.waitForTimeout(400);
    const c = await chrome(page);
    chk(`${tag}: Focus Mode hides the top bar`, c.topbar === "none" && c.main.top === 0, JSON.stringify(c));
    const ov = await overflow(page);
    chk(`${tag}: Focus Mode: no horizontal overflow`, ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
    const header = await page.getByTestId("workspace-header").evaluate((el) => {
      const btns = [...el.querySelectorAll("a,button")].map((b) => b.getBoundingClientRect());
      return btns.some((a, i) => btns.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
    });
    chk(`${tag}: header actions don't overlap`, !header);
    await page.locator("main").evaluate((el) => el.scrollTo(0, el.scrollHeight / 2));
    await page.waitForTimeout(300);
    const bar = await box(page, "status-bar");
    chk(`${tag}: sticky approval bar reachable in Focus Mode`, bar.y >= 0 && bar.y + bar.height <= vp.height + 1, JSON.stringify(bar));
    await page.locator("main").evaluate((el) => el.scrollTo(0, 0));
    await h.shot(page, `v2-${tag}-focus-statement`);
    await page.getByTestId("mobile-tab-existing").click();
    await page.waitForTimeout(250);
    await h.shot(page, `v2-${tag}-focus-flowfi`);
    await page.getByTestId("mobile-tab-statement").click();
    await page.getByRole("button", { name: "Exit Focus Mode" }).click();
    await page.waitForTimeout(300);
    chk(`${tag}: Exit Focus Mode restores the top bar`, (await chrome(page)).topbar !== "none");
  }
  await nothingWritten(chk, before);
});

scenario("recon-v2-few-rows", "V2 short statement: no filler rows, end-of-statement marker, Focus Mode resets on leaving the page — zero writes", async ({ page }, chk) => {
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  await page.setViewportSize({ width: 1366, height: 768 });
  await openWith(page, rowsText(3));
  chk("exactly 3 statement rows rendered (no filler rows)", (await page.getByTestId("recon-row").count()) === 3);
  chk("end-of-statement marker", /End of statement · 3 rows/.test(await page.getByTestId("statement-end").innerText()));
  await h.shot(page, "v2-1366-few-rows");
  await page.getByTestId("focus-mode-toggle").click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.next.router.push("/dashboard"));
  await page.waitForFunction(() => location.pathname.startsWith("/dashboard"), null, { timeout: 120000 });
  await page.waitForTimeout(800);
  const c = await chrome(page);
  chk("leaving the page turns Focus Mode off (other pages keep their layout)", c.sidebar !== "none" && c.topbar !== "none", JSON.stringify(c));
  await nothingWritten(chk, before);
});
