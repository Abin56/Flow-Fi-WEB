/**
 * Dashboard sweep (testing-phase check): every section renders, no console/page errors, no layout overflow, and every
 * link / button on the Dashboard goes where its label says. Read-only: it never writes data. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const strip = (p) => p.replace(/\/+$/, "") || "/";

async function openDashboard(page) {
  // A dev-server navigation can briefly reload the document; wait until the Next router exists again.
  const ready = await page.waitForFunction(() => !!window.next?.router, null, { timeout: 12000 }).then(() => true, () => false);
  if (!ready) {
    // Dev-server hot-reload glitch ("Router action dispatched before initialization"): reload once to recover.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.next?.router, null, { timeout: 30000 });
  }
  await h.go(page, "/dashboard");
  await page.waitForTimeout(2000);
  // Settled = every skeleton gone and the accounts panel rendered (data + animations finished).
  await page.waitForFunction(() => !document.querySelector('main [class*="animate-pulse"]') && /Total balance/i.test(document.querySelector("main")?.innerText ?? ""), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

scenario("dash-sweep-render", "Dashboard sweep: all sections render with seeded data, no errors, no overflow (desktop / dark / mobile)", async ({ page, logs }, chk) => {
  await openDashboard(page);
  const main = (await page.locator("main").innerText()).split("\n").join(" | ");
  await h.shot(page, "dash-sweep-desktop-light");
  for (const [label, re] of [
    ["greeting header", /Good (morning|afternoon|evening),/],
    ["Net worth", /NET WORTH/i],
    ["Cash flow", /Cash flow/i],
    ["attention strip", /Needs your attention|All caught up/],
    ["Recent transactions", /Recent transactions/],
    ["Upcoming payments", /Upcoming payments/],
    ["Accounts", /Total balance/i],
    ["Spending by category", /Spending by category/],
    ["Credit card utilization", /Credit card utilization/i],
    ["Shortcuts", /Shortcuts/],
  ]) chk(`section present: ${label}`, re.test(main), re);
  chk("no 'NaN' / 'undefined' / 'Infinity' text on the page", !/NaN|undefined|Infinity/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity).{0,30}/) || [""])[0]);
  chk("no skeleton left after load", (await page.locator('main [class*="animate-pulse"]').count()) === 0, await page.locator('main [class*="animate-pulse"]').count());

  const overflow = async () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  const o1 = await overflow();
  chk("desktop: no horizontal page overflow", o1.sw <= o1.cw + 1, JSON.stringify(o1));

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(600);
  await h.shot(page, "dash-sweep-desktop-dark");

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  await h.shot(page, "dash-sweep-mobile");
  const o2 = await overflow();
  chk("mobile 390px: no horizontal page overflow", o2.sw <= o2.cw + 1, JSON.stringify(o2));
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(700);
  await h.shot(page, "dash-sweep-tablet");
  const o3 = await overflow();
  chk("tablet 768px: no horizontal page overflow", o3.sw <= o3.cw + 1, JSON.stringify(o3));

  const errs = logs.filter((l) => !/Select is changing|status of 400|React DevTools|Download the React/.test(l));
  chk("no console errors / warnings / page errors while on the Dashboard", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("dash-sweep-clicks", "Dashboard sweep: every link and button on the Dashboard works", async ({ page, logs }, chk) => {
  await openDashboard(page);

  // 1) Collect every link on the dashboard (main content area) by label + href.
  const links = await page.evaluate(() =>
    [...document.querySelectorAll("main a[href]")].map((a) => ({
      href: a.getAttribute("href"),
      text: (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "),
    })),
  );
  chk("dashboard has links to test", links.length >= 10, links.length);
  const seenCount = new Map();
  for (const l of links) {
    if (!l.href || !l.href.startsWith("/")) continue;
    const nth = seenCount.get(l.href) ?? 0; // position among links sharing this href (e.g. every account row -> /accounts)
    seenCount.set(l.href, nth + 1);
    await openDashboard(page);
    const loc = page.locator(`main a[href="${l.href}"]`).nth(nth);
    if ((await loc.count()) === 0) { chk(`link "${l.text}" -> ${l.href} (locatable)`, false, "not found"); continue; }
    await loc.scrollIntoViewIfNeeded();
    await loc.click();
    const want = strip(l.href.split("?")[0]);
    const ok = await page.waitForFunction((w) => (location.pathname.replace(/\/+$/, "") || "/") === w, want, { timeout: 60000 }).then(() => true, () => false);
    await page.waitForTimeout(1200);
    const body = (await page.locator("body").innerText()).slice(0, 4000);
    const broken = /404|This page could not be found|Something went wrong|Application error/i.test(body);
    chk(`link "${l.text}" -> ${l.href} opens the page`, ok && !broken, ok ? (broken ? "error/404 content" : "") : `landed on ${await page.evaluate(() => location.pathname)}`);
  }

  // 2) Buttons: hide/show net worth toggles and persists; attention CTAs navigate.
  await openDashboard(page);
  const toggle = page.getByRole("button", { name: /Hide net worth|Show net worth/ });
  const before = (await page.locator('section[aria-label="Net worth"]').innerText()).split("\n").join(" | ");
  await toggle.click();
  await page.waitForTimeout(800);
  const hidden = (await page.locator('section[aria-label="Net worth"]').innerText()).split("\n").join(" | ");
  chk("Hide net worth masks the amount", /•{4,}/.test(hidden) && hidden !== before, hidden.slice(0, 120));
  await h.shot(page, "dash-sweep-networth-hidden");
  await page.getByRole("button", { name: /Show net worth|Hide net worth/ }).click();
  await page.waitForTimeout(800);
  const shown = (await page.locator('section[aria-label="Net worth"]').innerText()).split("\n").join(" | ");
  chk("Show net worth reveals the amount again", !/•{4,}/.test(shown) && /₹/.test(shown), shown.slice(0, 120));

  const cta = page.locator('section[aria-label="Needs your attention"] button');
  const n = await cta.count();
  for (let i = 0; i < n; i++) {
    await openDashboard(page);
    const b = page.locator('section[aria-label="Needs your attention"] button').nth(i);
    const label = (await b.innerText()).trim();
    await b.click();
    await page.waitForTimeout(1500);
    const path = await page.evaluate(() => location.pathname);
    chk(`attention button "${label}" navigates`, path !== "/dashboard" && path !== "/dashboard/", path);
  }

  const errs = logs.filter((l) => !/Select is changing|status of 400|React DevTools|Download the React/.test(l));
  chk("no console errors / page errors during the click sweep", errs.length === 0, errs.slice(0, 5).join(" || "));
});
