/**
 * Smart Capture + Reconciliation workspace layout at real screen sizes (1366×768, 1600×900, 1920×1080, 390 mobile).
 * Synthetic pasted rows only, local emulator only. Checks that on desktop the header/toolbar/action bar stay put and
 * only the grid scrolls (no footer overlap, no horizontal overflow), and that on mobile there is one page scroll with
 * a reachable sticky action bar. Reconciliation also proves nothing was written.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const DESKTOP = [
  { width: 1366, height: 768 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];
const MOBILE = { width: 390, height: 844 };

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const rowsText = (n) => Array.from({ length: n }, (_, i) => `${ddmmyyyy(-3 - (i % 5))}\tLAYOUT STORE ${String(i + 1).padStart(2, "0")}\t${(1000 + i * 37.25).toFixed(2)} Dr`).join("\n");

const metrics = (page, listTestId) =>
  page.evaluate((id) => {
    const main = document.querySelector("main");
    const list = document.querySelector(`[data-testid="${id}"]`);
    const header = document.querySelector('[data-testid="workspace-header"]').getBoundingClientRect();
    return {
      vh: window.innerHeight,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainOverflowX: main.scrollWidth - main.clientWidth,
      mainOverflowY: main.scrollHeight - main.clientHeight,
      headerHeight: Math.round(header.height),
      listOverflowY: getComputedStyle(list).overflowY,
      listScrolls: list.scrollHeight > list.clientHeight + 1,
    };
  }, listTestId);

const box = async (page, testId) => page.getByTestId(testId).first().boundingBox();

scenario("scap-layout-viewports", "Smart Capture review fits the viewport on desktop and scrolls naturally on mobile", async ({ page }, chk) => {
  await page.evaluate(() => window.next.router.push("/smart-capture"));
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
  await page.getByLabel("Pasted statement text").fill(rowsText(30));
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByTestId("progress-ready").waitFor();

  for (const vp of DESKTOP) {
    const tag = `${vp.width}×${vp.height}`;
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    await page.locator("main").evaluate((m) => m.scrollTo(0, 0));
    const m = await metrics(page, "review-list");
    chk(`${tag}: compact header (≤ 64px)`, m.headerHeight <= 64, m.headerHeight);
    chk(`${tag}: no horizontal overflow`, m.docOverflowX <= 1 && m.mainOverflowX <= 1, JSON.stringify(m));
    chk(`${tag}: the grid is the scroll region`, m.listOverflowY === "auto" && m.listScrolls, JSON.stringify(m));
    const footer = await box(page, "review-footer");
    chk(`${tag}: action bar on screen without scrolling the page`, footer.y + footer.height <= m.vh + 1, JSON.stringify({ footer, vh: m.vh, mainOverflowY: m.mainOverflowY }));
    // Scroll only the grid to its end: the toolbar stays put and the last row clears the action bar.
    const toolbarBefore = await box(page, "review-toolbar");
    await page.getByTestId("review-list").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(200);
    const toolbarAfter = await box(page, "review-toolbar");
    const last = await page.getByTestId("review-row").last().boundingBox();
    const footerNow = await box(page, "review-footer");
    chk(`${tag}: toolbar stays visible while the grid scrolls`, Math.abs(toolbarAfter.y - toolbarBefore.y) < 1, JSON.stringify({ toolbarBefore, toolbarAfter }));
    chk(`${tag}: last row fully above the action bar`, last.y + last.height <= footerNow.y + 1, JSON.stringify({ last, footerNow }));
    await h.shot(page, `scap-layout-${vp.width}`);
    await page.getByTestId("review-list").evaluate((el) => (el.scrollTop = 0));
  }

  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(500);
  const m = await metrics(page, "review-list");
  chk("390: no horizontal overflow", m.docOverflowX <= 0 && m.mainOverflowX <= 1, JSON.stringify(m));
  chk("390: one page scroll (the list is not its own scroller)", m.listOverflowY !== "auto", m.listOverflowY);
  await page.locator("main").evaluate((el) => el.scrollTo(0, el.scrollHeight / 2));
  await page.waitForTimeout(300);
  const footer = await box(page, "review-footer");
  chk("390: sticky action bar reachable mid-scroll", footer.y >= 0 && footer.y + footer.height <= MOBILE.height + 1, JSON.stringify(footer));
  await h.shot(page, "scap-layout-390");
});

scenario("recon-layout-viewports", "Reconciliation fits the viewport on desktop, keyboard selection stays visible, mobile scrolls naturally — and nothing is written", async ({ page }, chk) => {
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(rowsText(26));
  await page.getByRole("button", { name: "Compare rows" }).click();
  chk("no account is pre-selected", (await page.getByTestId("account-bar").getAttribute("data-selected")) === "false");
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="recon-row"]')?.getAttribute("data-state") !== "pending");
  await page.waitForTimeout(800);
  chk("selected account shows name and last four", /QA Credit Card[\s\S]*•••• 4242/.test(await page.getByTestId("selected-account").innerText()));

  for (const vp of DESKTOP) {
    const tag = `${vp.width}×${vp.height}`;
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    await page.locator("main").evaluate((m) => m.scrollTo(0, 0));
    const m = await metrics(page, "recon-grid-body");
    chk(`${tag}: compact header (≤ 64px)`, m.headerHeight <= 64, m.headerHeight);
    chk(`${tag}: no horizontal overflow`, m.docOverflowX <= 1 && m.mainOverflowX <= 1, JSON.stringify(m));
    chk(`${tag}: the grid body is the scroll region`, m.listOverflowY === "auto" && m.listScrolls, JSON.stringify(m));
    const bar = await box(page, "status-bar");
    chk(`${tag}: action bar on screen without scrolling the page`, bar.y + bar.height <= m.vh + 1, JSON.stringify({ bar, vh: m.vh, mainOverflowY: m.mainOverflowY }));
    const sheets = await Promise.all([box(page, "statement-sheet"), box(page, "existing-sheet")]);
    chk(`${tag}: both sheets side by side`, sheets[0].x + sheets[0].width <= sheets[1].x + 1 && sheets[1].x + sheets[1].width <= vp.width + 1, JSON.stringify(sheets));
    const existing = await page.getByTestId("existing-grid-body").evaluate((el) => getComputedStyle(el).overflowY);
    chk(`${tag}: the FlowFi sheet body scrolls on its own`, existing === "auto", existing);
    const dockBox = await box(page, "resolution-dock");
    chk(`${tag}: comparison dock above the action bar, on screen`, dockBox.y + dockBox.height <= bar.y + 1, JSON.stringify({ dockBox, bar }));
    const sideOverflow = await page.evaluate(() => ["statement-sheet", "existing-sheet", "resolution-dock"].map((id) => { const el = document.querySelector(`[data-testid="${id}"]`); return el.scrollWidth - el.clientWidth; }));
    chk(`${tag}: no sideways scroll inside the sheets or dock`, sideOverflow.every((o) => o <= 1), JSON.stringify(sideOverflow));
    const docked = false;

    // Keyboard: move down past the fold — the selected row stays inside the grid's visible body.
    await page.getByRole("grid", { name: "Statement rows" }).focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press("j");
    await page.waitForTimeout(250);
    const selected = await page.locator('[data-testid="recon-row"][aria-selected="true"]').boundingBox();
    const body = await box(page, "recon-grid-body");
    chk(`${tag}: keyboard selection stays in view`, selected.y >= body.y - 1 && selected.y + selected.height <= body.y + body.height + 1, JSON.stringify({ selected, body }));
    if (!docked) {
      await page.keyboard.press("o");
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(600); // let the slide-in finish before measuring
      const drawer = await page.getByRole("dialog").boundingBox();
      chk(`${tag}: comparison drawer fits the screen`, drawer.x >= 0 && drawer.x + drawer.width <= vp.width + 1, JSON.stringify(drawer));
      await page.keyboard.press("Escape");
    }
    await h.shot(page, `recon-layout-${vp.width}`);
    for (let i = 0; i < 20; i++) await page.keyboard.press("k");
  }

  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(500);
  const ov = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
  chk("390: no horizontal overflow", ov.doc <= 0 && ov.main <= 1, JSON.stringify(ov));
  await page.locator("main").evaluate((el) => el.scrollTo(0, el.scrollHeight / 2));
  await page.waitForTimeout(300);
  const bar = await box(page, "status-bar");
  chk("390: sticky action bar reachable mid-scroll", bar.y >= 0 && bar.y + bar.height <= MOBILE.height + 1, JSON.stringify(bar));
  chk("390: action bar stays compact (≤ 72px)", bar.height <= 72, bar.height);
  await h.shot(page, "recon-layout-390");

  const after = await Promise.all([h.list("transactions"), h.list("accounts")]);
  chk("nothing written: transactions unchanged", after[0].length === before[0].length);
  chk("nothing written: balances unchanged", JSON.stringify(after[1].map((a) => a.currentBalance).sort()) === JSON.stringify(before[1].map((a) => a.currentBalance).sort()));
});
