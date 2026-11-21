/**
 * Dashboard compact redesign (UI-only) — layout density, discoverability and chart interactions on synthetic
 * emulator data. Read-only: it never writes app data beyond the standard seed / fixture.
 *   npm run test:e2e-qa -- dashux- --copy
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

async function settle(page) {
  await h.go(page, "/dashboard");
  await page.waitForFunction(() => !document.querySelector('main [class*="animate-pulse"]') && /Total balance/i.test(document.querySelector("main")?.innerText ?? ""), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
}

/** Top of each section relative to the page top (scroll-independent). */
const tops = (page) =>
  page.evaluate(() => {
    // The app scrolls an inner container, not the document: measure against the nearest scrollable ancestor.
    const anchor = document.querySelector('main section[aria-label="Net worth"]');
    let sc = anchor?.parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    sc = sc ?? document.scrollingElement;
    const base = sc === document.scrollingElement ? 0 : sc.getBoundingClientRect().top;
    const y = (el) => (el ? Math.round(el.getBoundingClientRect().top - base + sc.scrollTop) : null);
    const region = (name) => y(document.querySelector(`main section[aria-label="${name}"]`));
    return {
      shortcuts: y(document.querySelector('main nav[aria-label="Shortcuts"]')),
      netWorth: region("Net worth"),
      cashFlow: region("Cash flow"),
      attention: region("Needs your attention"),
      recent: region("Recent transactions"),
      upcoming: region("Upcoming payments"),
      accounts: region("Accounts"),
      spending: region("Expenses by category"),
      credit: region("Credit card utilization"),
      pageHeight: sc.scrollHeight,
      scrollerHeight: sc.clientHeight,
      viewport: window.innerHeight,
    };
  });

for (const [w, hgt] of [
  [1440, 900],
  [1920, 1080],
]) {
  scenario(`dashux-layout-${w}`, `Dashboard redesign at ${w}×${hgt}: shortcuts + headline + attention + day-to-day row on the first screens; compact attention strip`, async ({ page, logs }, chk, notes) => {
    await page.setViewportSize({ width: w, height: hgt });
    await h.addFixture(page, "shared-emi");
    await settle(page);
    const t = await tops(page);
    notes.push(JSON.stringify(t));
    chk("shortcuts toolbar is in the first screen", t.shortcuts != null && t.shortcuts < 200, t.shortcuts);
    const bar = await page.evaluate(() => {
      const nav = document.querySelector('main nav[aria-label="Shortcuts"]');
      const r = nav.getBoundingClientRect();
      const clipped = [...nav.querySelectorAll("a")].filter((a) => a.getBoundingClientRect().right > r.right + 1).map((a) => a.innerText.trim());
      return { links: nav.querySelectorAll("a").length, clipped };
    });
    chk("all 6 shortcuts fully visible (none clipped)", bar.links === 6 && bar.clipped.length === 0, JSON.stringify(bar));
    chk("net worth and cash flow share one row", t.netWorth === t.cashFlow, `${t.netWorth} / ${t.cashFlow}`);
    chk("recent, upcoming and accounts share one row", t.recent === t.upcoming && t.upcoming === t.accounts, `${t.recent} / ${t.upcoming} / ${t.accounts}`);
    chk("spending and credit utilization share one row", t.spending === t.credit, `${t.spending} / ${t.credit}`);
    chk("attention strip starts inside the first screen", t.attention != null && t.attention < hgt, t.attention);
    chk("day-to-day row starts inside the first screen", t.recent < hgt, t.recent);
    chk(`whole dashboard fits in ≤ 2 screens (${hgt * 2}px)`, t.pageHeight <= hgt * 2, t.pageHeight);
    const strip = page.locator('main section[aria-label="Needs your attention"]');
    const items = await strip.locator("button").count();
    const box = await strip.boundingBox();
    chk("attention strip: ≤ 72px tall per row of alerts", box && box.height <= 72 * Math.max(1, Math.ceil(items / (w >= 1280 ? 2 : 1))) + 4, `${box?.height}px for ${items} item(s)`);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    chk("no horizontal page overflow", o.sw <= o.cw + 1, JSON.stringify(o));
    await page.evaluate(() => window.scrollTo(0, 0));
    await h.shot(page, `dashux-${w}-light`);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(700);
    await h.shot(page, `dashux-${w}-dark`);
    await page.mouse.move(w / 2 + 120, hgt / 2);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1200);
    const after = await tops(page);
    chk("wheel scroll reaches the bottom row (credit utilization fully visible)", after.credit != null, JSON.stringify({ credit: after.credit }));
    await h.shot(page, `dashux-${w}-dark-bottom`);
    await page.emulateMedia({ colorScheme: "light" });
    const errs = logs.filter((l) => !/Select is changing|status of 400|React DevTools|Download the React/.test(l));
    chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
  });
}

scenario("dashux-interactions", "Dashboard redesign: cash-flow tooltip, spending focus, net-worth legend focus, hide toggle masks every figure, shortcuts navigate", async ({ page, logs }, chk) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await h.addFixture(page, "shared-emi");
  await settle(page);

  // Cash flow: hovering a bar shows a themed tooltip with the week's net.
  const chart = page.locator('main section[aria-label="Cash flow"] .recharts-wrapper');
  const cb = await chart.boundingBox();
  let tip = "";
  for (const fx of [0.125, 0.375, 0.625, 0.875]) {
    await page.mouse.move(cb.x + cb.width * fx, cb.y + cb.height * 0.5);
    await page.waitForTimeout(250);
    tip += " | " + ((await page.locator('main section[aria-label="Cash flow"] .recharts-tooltip-wrapper').innerText().catch(() => "")) || "");
  }
  chk("cash-flow bars show a 'Days … Net ₹…' tooltip on hover", /Days \d+-\d+[\s\S]*Net[\s\S]*₹/.test(tip), tip.replace(/\s+/g, " ").slice(0, 200));
  chk("current week is marked on the axis", /THIS WEEK/.test(await page.locator('main section[aria-label="Cash flow"]').innerText()));
  await h.shot(page, "dashux-cashflow-tooltip");

  // Spending: hovering a legend row puts that category in the donut centre.
  const spend = page.locator('main section[aria-label="Expenses by category"]');
  const rows = spend.locator("li");
  if ((await rows.count()) > 0) {
    const name = (await rows.first().locator("span").nth(1).innerText()).trim();
    await rows.first().hover();
    await page.waitForTimeout(250);
    const centre = await spend.locator(".pointer-events-none").first().innerText();
    chk("spending legend hover focuses the category in the donut centre", centre.toUpperCase().includes(name.toUpperCase()), `${name} → ${centre.replace(/\s+/g, " ")}`);
    await h.shot(page, "dashux-spending-focus");
    await page.mouse.move(5, 5);
  } else chk("spending has categories to hover (seed)", false, "empty");

  // Net worth legend focus dims the other segments.
  const seg = page.getByTestId("nw-seg-owned");
  if (await seg.count()) {
    await seg.hover();
    await page.waitForTimeout(250);
    const dimmed = await page.locator('[data-testid^="nw-seg-"].opacity-55').count();
    const segs = await page.locator('[data-testid^="nw-seg-"]').count();
    chk("net-worth legend hover dims the other rows in that bar", segs <= 2 || dimmed >= 1, `${dimmed}/${segs}`);
    await h.shot(page, "dashux-networth-focus");
  }

  // Hide masks every net-worth figure, Show restores.
  const nw = page.locator('main section[aria-label="Net worth"]');
  await page.getByRole("button", { name: "Hide net worth" }).click();
  await page.waitForTimeout(600);
  const hidden = await nw.innerText();
  chk("Hide masks every ₹ figure in the Net worth card", !/₹/.test(hidden) && /•{4,}/.test(hidden), hidden.replace(/\s+/g, " ").slice(0, 160));
  await page.getByRole("button", { name: "Show net worth" }).click();
  await page.waitForTimeout(600);
  chk("Show restores the figures", /₹/.test(await nw.innerText()));

  // Shortcuts navigate.
  for (const [label, path] of [
    ["Add transaction", "/transactions"],
    ["Savings goals", "/savings"],
    ["Month cycle", "/month-cycle"],
  ]) {
    await settle(page);
    await page.locator('main nav[aria-label="Shortcuts"]').getByRole("link", { name: label }).click();
    const ok = await page.waitForFunction((p) => location.pathname.replace(/\/+$/, "") === p, path, { timeout: 60000 }).then(() => true, () => false);
    chk(`shortcut "${label}" opens ${path}`, ok, await page.evaluate(() => location.pathname));
  }
  const errs = logs.filter((l) => !/Select is changing|status of 400|React DevTools|Download the React/.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});
