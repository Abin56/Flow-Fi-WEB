/**
 * People Ledger "people wall" (desktop): arrangement by head-count (1 → spotlight, 2–5 → row, many → wall), Dock-style
 * hover (tile magnifies, neighbours swell, the rest recede, details reveal OVER the next row without moving any slot;
 * last-row tiles reveal upward), sort menu, search / filter / cycle controls, and a tile opens the existing person page.
 * UI-only — the app writes nothing. Local emulator only (the many-people case adds synthetic people docs directly).
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();

async function openList(page) {
  await h.go(page, "/people");
  await page.getByRole("heading", { level: 1, name: "People Ledger" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
}
const grid = (page) => page.locator('[data-testid="people-grid"]');
const tiles = (page) => page.locator('[data-testid="people-grid"] > li');
const slots = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="people-grid"] > li')].map((li) => { const r = li.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
const names = (page) => tiles(page).locator("button").evaluateAll((els) => els.map((e) => /^Open (.*?)'s ledger/.exec(e.getAttribute("aria-label"))?.[1]));
const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });

scenario("pgrid-layout-hover-open", "People wall: row/spotlight arrangement, dock hover + reveal without layout shift, sort, tile opens the person page", async ({ page, logs }, chk) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await h.addFixture(page, "shared-emi");
  await openList(page);
  await h.shot(page, "pgrid-3-people-light");

  chk("three people → a natural row of 3 tiles", (await tiles(page).count()) === 3 && (await grid(page).getAttribute("data-mode")) === "row" && (await grid(page).getAttribute("data-cols")) === "3");
  const rest = await slots(page);
  chk("tiles are compact (≤ 240px wide, ≤ 130px tall)", rest.every((r) => r[2] <= 240 && r[3] <= 130), JSON.stringify(rest));
  const text = flat(await page.locator("main").innerText());
  chk("each tile shows To receive and To give", (text.match(/to receive/gi) ?? []).length >= 3 && (text.match(/to give/gi) ?? []).length >= 3);
  chk("current cycle shown with days left", /Current cycle\s*·\s*(last day|\d+ days? left)/.test(text), text.match(/Current cycle.{0,30}/)?.[0]);
  chk("summary strip keeps Receive / Give separate", /Receive\s*₹[\d,]+/.test(text) && /Give\s*₹[\d,]+/.test(text));
  chk("no NaN / undefined / Infinity", !/NaN|undefined|Infinity|\[object/.test(text));

  // Hover: slots never move; the tile magnifies, a neighbour swells less, details reveal over the space below.
  const first = tiles(page).first().locator("button");
  const before = await slots(page);
  const closed = await box(first);
  await first.hover();
  await page.waitForTimeout(650);
  chk("hover: every tile slot keeps its position and size", JSON.stringify(before) === JSON.stringify(await slots(page)));
  const scale = Number((await first.evaluate((b) => getComputedStyle(b).scale)).split(" ")[0]);
  const nScale = Number((await tiles(page).nth(1).locator("button").evaluate((b) => getComputedStyle(b).scale)).split(" ")[0] || 1);
  chk("hover: the tile magnifies more than its neighbour", scale > 1.03 && scale > nScale, `${scale} vs ${nScale}`);
  const nOpacity = await tiles(page).nth(2).locator("button").evaluate((b) => Number(getComputedStyle(b).opacity));
  chk("hover: farther tiles recede (opacity < 1)", nOpacity < 1, String(nOpacity));
  const open = await box(first);
  chk("hover: details reveal (tile grows downward over its slot)", open.height > closed.height + 30 && Math.abs(open.top - closed.top) < 6, JSON.stringify({ closed, open }));
  chk("reveal shows the cycle trail + open hint", /Previous/.test(await first.innerText()) && /Open ledger/.test(await first.innerText()));
  await h.shot(page, "pgrid-hover-light");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  chk("pointer leaves: neighbours return to full opacity", (await tiles(page).nth(2).locator("button").evaluate((b) => Number(getComputedStyle(b).opacity))) === 1);

  // Sort menu.
  await page.getByRole("button", { name: /^Sort people/ }).click();
  await page.getByRole("menuitemradio", { name: "Name" }).click();
  await page.waitForTimeout(400);
  const byName = await names(page);
  chk("sort by Name orders A→Z", JSON.stringify(byName) === JSON.stringify([...byName].sort((a, b) => a.localeCompare(b))), byName.join(","));
  await page.getByRole("button", { name: /^Sort people/ }).click();
  await page.getByRole("menuitemradio", { name: "Highest amount" }).click();
  await page.waitForTimeout(400);

  // Search → one person → spotlight record.
  await page.getByLabel("Search people").fill("priya");
  await page.waitForTimeout(500);
  const one = (await slots(page))[0];
  chk("one person → spotlight record (wide, short, capped)", (await tiles(page).count()) === 1 && (await grid(page).getAttribute("data-mode")) === "spotlight" && one[2] <= 890 && one[3] <= 120, JSON.stringify(one));
  await h.shot(page, "pgrid-1-person-light");
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.waitForTimeout(400);

  // Two people → row of 2.
  await page.getByRole("tab", { name: /You need to receive/ }).click();
  await page.waitForTimeout(500);
  chk("two people → row of two tiles", (await grid(page).getAttribute("data-mode")) === "row" && (await tiles(page).count()) === 2);
  await h.shot(page, "pgrid-2-people-light");
  await page.getByRole("tab", { name: /^All/ }).click();
  await page.waitForTimeout(400);

  // Dark mode.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await h.shot(page, "pgrid-3-people-dark");
  await first.hover();
  await page.waitForTimeout(650);
  await h.shot(page, "pgrid-hover-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.mouse.move(5, 5);

  // Cycle navigation.
  await page.getByRole("button", { name: "Previous cycle" }).first().click();
  await page.waitForTimeout(700);
  chk("previous cycle: page still renders, not labelled current", /Current cycle/.test(flat(await page.locator("main").innerText())) === false);
  await page.getByRole("button", { name: /Back to current/ }).first().click();
  await page.waitForTimeout(700);

  // Click opens the existing person page.
  const label = await first.getAttribute("aria-label");
  const name = /^Open (.*?)'s ledger/.exec(label)?.[1];
  await first.click();
  await page.waitForFunction(() => new URLSearchParams(location.search).has("person"), null, { timeout: 15000 });
  chk(`clicking '${name}' opens the person page (?person=…)`, true);
  await page.waitForTimeout(1200);

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("pgrid-many-people", "People wall: many people fill a multi-column wall; last-row tiles reveal upward", async ({ page, logs }, chk) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await h.addFixture(page, "shared-emi");
  const now = new Date();
  const first = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Sara", "Vikram", "Anika", "Dev", "Ishaan", "Nisha", "Tara", "Arjun", "Zoya"];
  for (const [i, n] of first.entries()) {
    const balance = i % 3 === 2 ? 0 : (i % 2 === 0 ? 1 : -1) * (500 + i * 375);
    await h.createDocUnderUser(`people/qa-wall-${i}`, { name: `QA ${n} ${i % 4 === 0 ? "Krishnamurthy" : "Shah"}`, phone: null, email: null, notes: "", avatarColorValue: 0, openingBalance: balance, currentBalance: balance, createdAt: new Date(now.getTime() - 86400000 * 60), deletedAt: null });
  }
  await openList(page);
  await h.shot(page, "pgrid-many-light");
  const count = await tiles(page).count();
  const cols = Number(await grid(page).getAttribute("data-cols"));
  chk(`${count} people → wall with ≥ 4 columns`, count >= 17 && (await grid(page).getAttribute("data-mode")) === "wall" && cols >= 4, `${count} / ${cols}`);
  const s = await slots(page);
  chk("all slots the same height (stable rows)", new Set(s.map((r) => r[3])).size === 1, JSON.stringify(s.slice(0, 3)));

  // Last tile (last row) reveals upward: its bottom edge stays put.
  const last = tiles(page).last().locator("button");
  await last.scrollIntoViewIfNeeded();
  const closed = await box(last);
  await last.hover();
  await page.waitForTimeout(650);
  const open = await box(last);
  chk("last-row tile opens upward (bottom fixed, grows up)", open.height > closed.height + 30 && Math.abs(open.bottom - closed.bottom) < 6, JSON.stringify({ closed, open }));
  await h.shot(page, "pgrid-many-hover-last");
  // A first-row tile opens downward over the second row.
  await page.mouse.move(5, 5);
  const top = tiles(page).nth(1).locator("button");
  await top.scrollIntoViewIfNeeded();
  await top.hover();
  await page.waitForTimeout(650);
  await h.shot(page, "pgrid-many-hover-first-row");
  await page.mouse.move(5, 5);

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  await h.shot(page, "pgrid-many-dark");
  await page.emulateMedia({ colorScheme: "light" });

  for (const w of [1280, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(500);
    const o = await page.evaluate(() => ({ main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
    chk(`${w}px: no horizontal overflow, cols=${await grid(page).getAttribute("data-cols")}`, o.main <= 1, JSON.stringify(o));
    await h.shot(page, `pgrid-many-${w}`);
  }

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});
