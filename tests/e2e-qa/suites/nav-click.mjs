/**
 * One-click navigation + top loading bar (navclick-*). Real mouse input only — synthetic emulator data.
 *   npm run test:e2e-qa -- navclick- --copy
 *
 * Regression guard for the recurring "I have to click twice / the bar at the top is stuck" bug. Every check uses a real
 * hover → press → release sequence (the user's), never `locator.click()` / `router.push`, because the original defect only
 * exists between pointerdown and pointerup: the sidebar re-rendered on pointerdown and swapped the node under the cursor,
 * so Chrome never dispatched `click`, leaving the optimistic "opening…" state (and the top bar) on with no navigation.
 */
import { scenario } from "../lib/core.mjs";

const SLOT = '[data-testid="app-sidebar-slot"]';
const BAR = '[data-testid="nav-progress"]';
const path = (page) => page.evaluate(() => location.pathname.replace(/\/+$/, "") || "/");
const bar = (page) => page.locator(BAR).count();

/** Client-side navigation with a long ceiling: a cold dev-server compile can take far longer than the harness default. */
async function goTo(page, href) {
  await page.evaluate((x) => window.next.router.push(x), href);
  await page.waitForFunction((x) => location.pathname.replace(/\/+$/, "") === x.replace(/\/+$/, ""), href, { timeout: 120000 });
}

/** hover (so the hover pill is mounted), press, release — exactly like a hand. */
async function humanClick(page, x, y, { holdMs = 70, hoverMs = 160 } = {}) {
  await page.mouse.move(x - 30, y - 6, { steps: 2 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(hoverMs);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

async function waitPath(page, href, ms) {
  const want = href.replace(/\/+$/, "");
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await path(page)) === want || (await path(page)).startsWith(want)) return Date.now() - t0;
    await page.waitForTimeout(40);
  }
  return -1;
}

const LINKS = ["/my-money", "/month-cycle", "/transactions", "/accounts", "/credit-cards", "/people", "/bills", "/savings", "/loans", "/debt-planner", "/reports", "/settings"];

scenario(
  "navclick-sidebar-one-click",
  "Sidebar rows: ONE real click opens the page, bar clears, active row follows (every row, 3 click spots)",
  async ({ page }, chk, notes) => {
    await goTo(page, "/dashboard");
    await page.waitForTimeout(2000);
    // Warm every route first so dev-server compile time is not mistaken for a swallowed click.
    for (const href of LINKS) {
      await goTo(page, href);
    }
    await goTo(page, "/dashboard");
    await page.waitForTimeout(800);

    const failures = [];
    let stuckBars = 0;
    for (const href of LINKS) {
      for (const spot of ["label", "padding", "icon"]) {
        await goTo(page, "/dashboard");
        await page.waitForTimeout(250);
        await page.mouse.move(900, 600);
        const link = page.locator(`${SLOT} .nav-scroll a[href="${href}/"], ${SLOT} .nav-scroll a[href="${href}"]`).first();
        await link.scrollIntoViewIfNeeded();
        await page.waitForTimeout(350);
        const b = await link.boundingBox();
        if (!b) {
          failures.push(`${href}:${spot}:nobox`);
          continue;
        }
        const x = spot === "label" ? b.x + b.width * 0.45 : spot === "icon" ? b.x + 20 : b.x + b.width - 48;
        await humanClick(page, x, b.y + b.height / 2);
        const t = await waitPath(page, href, 3500);
        if (t < 0) failures.push(`${href}:${spot}`);
        await page.waitForTimeout(500);
        if ((await bar(page)) > 0) stuckBars++;
      }
    }
    chk(`every row navigates on the FIRST click (${LINKS.length * 3} presses)`, failures.length === 0, failures.join(", ") || "none");
    chk("top bar is gone ~0.5s after each arrival", stuckBars === 0, `${stuckBars} stuck`);
  },
);

scenario(
  "navclick-quick-access-one-click",
  "Quick-access tiles + recents: ONE real click opens the page",
  async ({ page }, chk) => {
    await goTo(page, "/dashboard");
    await page.waitForTimeout(2000);
    const tiles = await page.locator(`${SLOT} section[aria-label="Quick access"] a`).evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    chk("quick access has tiles", tiles.length >= 2, tiles.join(","));
    const failures = [];
    for (const href of tiles) {
      await goTo(page, href);
    }
    for (const href of tiles) {
      const other = tiles.find((t) => t !== href);
      await goTo(page, other);
      await page.waitForTimeout(300);
      await page.mouse.move(900, 600);
      const link = page.locator(`${SLOT} section[aria-label="Quick access"] a[href="${href}"]`).first();
      const b = await link.boundingBox();
      await humanClick(page, b.x + b.width / 2, b.y + b.height / 2);
      if ((await waitPath(page, href, 3500)) < 0) failures.push(href);
      await page.waitForTimeout(500);
      if ((await bar(page)) > 0) failures.push(`${href}:bar`);
    }
    chk("every tile navigates on the first click and the bar clears", failures.length === 0, failures.join(", ") || "none");
  },
);

scenario(
  "navclick-bar-lifecycle",
  "Top bar: press-then-drag-off and a cancelled/slow navigation never leave it stuck; it completes and clears",
  async ({ page }, chk, notes) => {
    await goTo(page, "/dashboard");
    await page.waitForTimeout(2000);
    // Warm every route used below: a cold dev-server compile (seconds) is not what this scenario measures.
    for (const href of ["/accounts", "/bills", "/savings", "/reports"]) await goTo(page, href);
    await goTo(page, "/dashboard");
    await page.waitForTimeout(500);

    // 1. press on a row, drag off it, release elsewhere → not a click → bar must clear, no navigation.
    const link = page.locator(`${SLOT} .nav-scroll a[href^="/accounts"]`).first();
    await link.scrollIntoViewIfNeeded();
    const b = await link.boundingBox();
    await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 3 });
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.mouse.move(900, 500, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    chk("press → drag off → release: no bar left", (await bar(page)) === 0, await bar(page));
    chk("…and it did not navigate", (await path(page)) === "/dashboard", await path(page));

    // 2. two quick clicks on different rows → lands on the LAST one, bar cleared.
    const l1 = page.locator(`${SLOT} .nav-scroll a[href^="/bills"]`).first();
    const l2 = page.locator(`${SLOT} .nav-scroll a[href^="/savings"]`).first();
    await l1.scrollIntoViewIfNeeded();
    const b1 = await l1.boundingBox();
    const b2 = await l2.boundingBox();
    await humanClick(page, b1.x + 80, b1.y + b1.height / 2, { holdMs: 30, hoverMs: 20 });
    await humanClick(page, b2.x + 80, b2.y + b2.height / 2, { holdMs: 30, hoverMs: 20 });
    const landed = await waitPath(page, "/savings", 5000);
    await page.waitForTimeout(700);
    chk("rapid A→B clicks land on B", landed >= 0, await path(page));
    chk("bar cleared after rapid navigation", (await bar(page)) === 0, await bar(page));
    chk("only B is marked current", (await page.locator(`${SLOT} .nav-scroll a[aria-current="page"]`).count()) === 1, await page.locator(`${SLOT} .nav-scroll a[aria-current="page"]`).evaluateAll((as) => as.map((a) => a.getAttribute("href")).join(",")));

    // 3. navigation that never resolves in time: the bar may show, but must clear once the route does arrive.
    await goTo(page, "/dashboard");
    await page.waitForTimeout(400);
    const l3 = page.locator(`${SLOT} .nav-scroll a[href^="/reports"]`).first();
    await l3.scrollIntoViewIfNeeded();
    const b3 = await l3.boundingBox();
    await humanClick(page, b3.x + 80, b3.y + b3.height / 2);
    await waitPath(page, "/reports", 8000);
    await page.waitForTimeout(700);
    chk("bar cleared after arrival", (await bar(page)) === 0, await bar(page));

    // 3b. a slow (cold, still compiling) route: the bar must SHOW while it opens, then complete and clear on arrival.
    await goTo(page, "/dashboard");
    await page.waitForTimeout(400);
    const l4 = page.locator(`${SLOT} .nav-scroll a[href^="/analytics"]`).first();
    await l4.scrollIntoViewIfNeeded();
    const b4 = await l4.boundingBox();
    await humanClick(page, b4.x + 80, b4.y + b4.height / 2);
    let sawBar = false;
    const tNav = Date.now();
    while (Date.now() - tNav < 60000 && !(await path(page)).startsWith("/analytics")) {
      if ((await bar(page)) > 0) sawBar = true;
      await page.waitForTimeout(60);
    }
    const openedMs = Date.now() - tNav;
    notes.push(`cold /analytics opened in ${openedMs} ms; bar seen while pending: ${sawBar}`);
    chk("bar is visible while a slow route is opening (or it opened in <0.5 s)", sawBar || openedMs < 500, `${openedMs} ms, seen=${sawBar}`);
    await page.waitForTimeout(700);
    chk("…and is gone once it has opened", (await bar(page)) === 0, await bar(page));

    // 4. browser Back / Forward (history here: … → /dashboard → /analytics).
    await page.goBack();
    await waitPath(page, "/dashboard", 5000);
    await page.waitForTimeout(500);
    chk("Back: no stuck bar, correct page", (await bar(page)) === 0 && (await path(page)) === "/dashboard", await path(page));
    await page.goForward();
    await waitPath(page, "/analytics", 5000);
    await page.waitForTimeout(500);
    chk("Forward: no stuck bar, correct page", (await bar(page)) === 0 && (await path(page)) === "/analytics", await path(page));
  },
);
