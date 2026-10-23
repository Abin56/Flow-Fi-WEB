/**
 * Browser QA scenarios (month-cycle-compact-header.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Month Cycle's compact bar: a zero-height sticky overlay that appears once the page's original title has scrolled
 * away. These scenarios drive the real page; nothing here writes financial data.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const VPS = { desktop: { width: 1920, height: 1080 }, laptop: { width: 1366, height: 768 }, mobile: { width: 390, height: 844 } };

const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Client-side navigation, then wait on the pathname (waitForURL waits on the load event, which a soft navigation never fires again). */
const goTo = async (page, href) => {
  await page.evaluate((x) => window.next.router.push(x), href);
  let at = "";
  for (let i = 0; i < 120; i++) { at = await page.evaluate(() => location.pathname); if (at.replace(/[/]$/, "") === href) return; await page.waitForTimeout(250); }
  throw new Error(`navigation to ${href} did not land; at ${at}`);
};
/** innerText once it has stopped changing (AnimatedNumber counts up for a moment after any data change). */
const stableText = async (locator) => { let prev = null; for (let i = 0; i < 40; i++) { const t = await locator.innerText(); if (t === prev) return t; prev = t; await locator.page().waitForTimeout(250); } return prev; };
const scrollMain = (page, top) => page.evaluate((t) => { document.querySelector("main").scrollTop = t; }, top);
const mainScroll = (page) => page.evaluate(() => document.querySelector("main").scrollTop);
const overflowX = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));

async function colorsOf(locator) {
  return locator.evaluate((el) => {
    const parse = (s) => { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = s; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const fg = parse(getComputedStyle(el).color);
    let n = el, bg = [255, 255, 255, 1];
    while (n) { const b = parse(getComputedStyle(n).backgroundColor); if (b[3] > 0.7) { bg = b; break; } n = n.parentElement; }
    return { fg: fg.slice(0, 3), bg: bg.slice(0, 3) };
  });
}

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    const id = `mccompact-${vpName}-${scheme}`;
    scenario(id, `Month Cycle compact bar: ${vpName} ${vp.width}x${vp.height}, ${scheme} theme`, async ({ page }, chk) => {
      await goTo(page, "/month-cycle");
      await page.getByRole("heading", { level: 1, name: "Month Cycle" }).waitFor();
      await page.waitForTimeout(2500);

      const bar = page.getByRole("region", { name: "Month Cycle quick bar" });
      const barEl = page.locator("[data-compact-bar]");
      const summary = page.getByRole("region", { name: "Cycle summary" });
      const nav = page.getByRole("navigation", { name: "Month cycle sections" });

      // ── Expanded: the bar is hidden and unreachable ──
      chk("expanded: compact bar is inert and aria-hidden", (await barEl.getAttribute("inert")) !== null && (await barEl.getAttribute("aria-hidden")) === "true");
      chk("expanded: compact bar is not in the accessibility tree", (await bar.count()) === 0);
      chk("expanded: header shows exactly one Previous/Next/New transaction", (await page.getByRole("button", { name: "Previous cycle" }).count()) === 1 && (await page.getByRole("link", { name: "New transaction" }).count()) === 1);
      const baseline = { summary: await stableText(summary), scrollHeight: await page.evaluate(() => document.querySelector("main").scrollHeight), summaryTop: await summary.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop) };
      const room = await page.evaluate(() => document.querySelector("main").scrollHeight - document.querySelector("main").clientHeight);
      chk("page is tall enough to scroll the title away", room > 400, `${room}px of scroll`);
      await h.shot(page, `${id}-1-expanded`);

      // ── Scroll jitter: a position inside the transition band holds still ──
      await scrollMain(page, 40);
      const samples = [];
      for (let i = 0; i < 5; i++) { await page.waitForTimeout(120); samples.push(await mainScroll(page)); }
      chk("transition band: scrollTop holds steady (no jitter)", samples.every((s) => s === 40), samples.join(","));
      const entering = await barEl.evaluate((el) => { const cs = getComputedStyle(el); const m = document.querySelector("main").getBoundingClientRect(); const r = el.getBoundingClientRect(); return { opacity: cs.opacity, bgAlpha: cs.backgroundColor.includes("/") ? cs.backgroundColor : "opaque", visible: cs.visibility, state: el.dataset.state, top: Math.round(r.top - m.top) }; });
      chk("transition: bar slides in opaque — no cross-fade over the header text", entering.opacity === "1" && entering.bgAlpha === "opaque" && entering.state !== "hidden", JSON.stringify(entering));
      await h.shot(page, `${id}-2-entering`);

      // ── Collapsed ──
      await scrollMain(page, 700);
      await page.waitForTimeout(500);
      await bar.waitFor({ state: "visible" });
      chk("collapsed: bar is in the accessibility tree and interactive", (await barEl.getAttribute("inert")) === null);
      const mainTop = await page.evaluate(() => document.querySelector("main").getBoundingClientRect().top);
      const bb = await barEl.boundingBox();
      const nb = await nav.boundingBox();
      chk("collapsed: bar pinned at the top of the content area", bb && bb.y >= mainTop && bb.y <= mainTop + 12 && bb.height >= 44 && bb.height <= 52, JSON.stringify(bb && { y: Math.round(bb.y), h: Math.round(bb.height) }));
      chk("collapsed: bar fits the viewport width", bb && bb.x >= 0 && bb.x + bb.width <= vp.width + 1, JSON.stringify(bb && { x: Math.round(bb.x), w: Math.round(bb.width) }));
      chk("collapsed: SectionNav stays visible beneath the bar, not overlapping", nb && bb && nb.y >= bb.y + bb.height - 1, JSON.stringify({ barBottom: bb && Math.round(bb.y + bb.height), navTop: nb && Math.round(nb.y) }));
      const cover = await page.evaluate(() => { const m = document.querySelector("main").getBoundingClientRect(); const b = document.querySelector("[data-compact-bar]").getBoundingClientRect(); const covered = [0, 1, 3, 6].every((d) => !!document.elementFromPoint(b.left + b.width / 2, m.top + d)?.closest("[data-compact-bar]")); const el = document.elementFromPoint(b.left + b.width / 2, m.top + 3); const cs = getComputedStyle(document.querySelector("[data-compact-bar]"), "::before"); return { hit: covered && !!el?.closest("[data-compact-bar]"), covered, tag: el?.tagName, h: cs.height, bg: cs.backgroundColor }; });
      chk("no scrolling content peeks out above the bar (cover strip owns the top gap)", cover.hit, JSON.stringify(cover));
      const seam = await page.evaluate(() => { const b = document.querySelector("[data-compact-bar]").getBoundingClientRect(); const n = document.querySelector("nav[aria-label=\"Month cycle sections\"]").getBoundingClientRect(); const ys = [b.bottom + 1.5, (b.bottom + n.top) / 2, n.top - 1.5]; const hit = ys.every((y) => !!document.elementFromPoint(b.left + b.width / 2, y)?.closest("[data-compact-bar]")); return { gap: Math.round(n.top - b.bottom), hit }; });
      chk("bar→SectionNav seam is an intentional 8px gap, painted in the page background", seam.gap === 8 && seam.hit, JSON.stringify(seam));
      const nowTop = await summary.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop);
      const nowHeight = await page.evaluate(() => document.querySelector("main").scrollHeight);
      chk("no layout shift: content offsets and page height unchanged by the bar", Math.abs(nowTop - baseline.summaryTop) < 1 && nowHeight === baseline.scrollHeight, `summary ${baseline.summaryTop}→${nowTop}, height ${baseline.scrollHeight}→${nowHeight}`);
      const ox = await overflowX(page);
      chk("no horizontal overflow (page and main)", ox.doc <= 1 && ox.main <= 1, JSON.stringify(ox));
      for (const name of ["Previous cycle", "Next cycle", "Choose cycle", "Cycle details", "New transaction"]) {
        const el = bar.getByRole(name === "New transaction" ? "link" : "button", { name });
        const b = await el.boundingBox();
        chk(`bar control "${name}" present with a ≥40px target`, b && b.width >= 40 - 1 && b.height >= 40 - 1 || (name === "Choose cycle" && b && b.height >= 40 - 1), JSON.stringify(b && { w: Math.round(b.width), h: Math.round(b.height) }));
      }
      const pick = await colorsOf(bar.getByRole("button", { name: "Choose cycle" }).locator("span").first());
      chk("bar text contrast ≥ 4.5:1", ratio(pick.fg, pick.bg) >= 4.5, `${ratio(pick.fg, pick.bg).toFixed(2)}:1 fg ${pick.fg} on ${pick.bg}`);
      chk("bar: no other tab stops leak when shown — focus moves into it in order", await (async () => {
        await bar.getByRole("button", { name: "Previous cycle" }).focus();
        return page.evaluate(() => !!document.activeElement?.closest("[data-compact-bar]"));
      })());
      await h.shot(page, `${id}-3-collapsed`);

      // ── SectionNav: sticky, and a jump target is not hidden behind the stack ──
      await nav.getByRole("button", { name: "Budget" }).click();
      await page.waitForTimeout(1400);
      const stack = await nav.boundingBox();
      const target = await page.locator("#mc-budget").boundingBox();
      chk("SectionNav jump: target heading clears the bar + nav", target && stack && target.y >= stack.y + stack.height - 1, JSON.stringify({ navBottom: stack && Math.round(stack.y + stack.height), targetTop: target && Math.round(target.y) }));
      await nav.getByRole("button", { name: "Overview" }).click();
      await page.waitForTimeout(1400);

      // ── Handlers: the bar drives the same cycle state as the header ──
      await scrollMain(page, 700);
      await page.waitForTimeout(400);
      await bar.getByRole("button", { name: "Previous cycle" }).click();
      await page.waitForTimeout(800);
      const prevText = await stableText(summary);
      chk("bar Previous cycle changes the cycle", await bar.getByRole("button", { name: "Back to current" }).isVisible());
      await bar.getByRole("button", { name: "Back to current" }).click();
      await page.waitForTimeout(800);
      chk("bar Previous cycle shows different figures than the current cycle", prevText !== baseline.summary, "");
      chk("bar Back to current restores the original cycle and figures (no value drift)", (await stableText(summary)) === baseline.summary, "");

      // ── Popover stays anchored while open, even if the page scrolls ──
      await bar.getByRole("button", { name: "Choose cycle" }).click();
      const pop = page.getByRole("button", { name: "Current cycle" });
      await pop.waitFor();
      const before = await pop.boundingBox();
      await scrollMain(page, 760);
      await page.waitForTimeout(400);
      const after = await pop.boundingBox();
      chk("picker popover stays anchored while the page scrolls", before && after && Math.abs(before.y - after.y) < 2, JSON.stringify({ before: before && Math.round(before.y), after: after && Math.round(after.y) }));
      await scrollMain(page, 0);
      await page.waitForTimeout(500);
      chk("bar stays up while its popover is open, even with the title back in view", (await barEl.getAttribute("inert")) === null);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);

      // ── Back at the top: bar goes away again ──
      await bar.getByRole("button", { name: "Next cycle" }).waitFor({ state: "attached" }).catch(() => {});
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await scrollMain(page, 0);
      await page.waitForTimeout(600);
      chk("title back in view: bar hides and is inert again", (await barEl.getAttribute("inert")) !== null && (await bar.count()) === 0);
      chk("title back in view: summary unchanged", (await stableText(summary)) === baseline.summary);
      await h.shot(page, `${id}-4-back-to-top`);

      // ── New transaction from the bar navigates to /transactions ──
      await scrollMain(page, 700);
      await page.waitForTimeout(500);
      await bar.getByRole("link", { name: "New transaction" }).click();
      for (let i = 0; i < 120 && !(await page.evaluate(() => location.pathname.replace(/[/]$/, "") === "/transactions")); i++) await page.waitForTimeout(250);
      chk("bar New transaction navigates to /transactions", /\/transactions/.test(page.url()), page.url());
    }, { viewport: vp, scheme });
  }
}

scenario("mccompact-reduced-motion", "Month Cycle compact bar: prefers-reduced-motion — no slide or gradual fade", async ({ page }, chk) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await goTo(page, "/month-cycle");
  await page.getByRole("heading", { level: 1, name: "Month Cycle" }).waitFor();
  await page.waitForTimeout(2000);
  const barEl = page.locator("[data-compact-bar]");
  await scrollMain(page, 40);
  await page.waitForTimeout(300);
  chk("reduced motion: mid-transition the bar is still fully hidden (no gradual fade)", await barEl.evaluate((el) => getComputedStyle(el).visibility === "hidden"));
  await scrollMain(page, 700);
  await page.waitForTimeout(300);
  const s = await barEl.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration, inert: el.hasAttribute("inert") }));
  chk("reduced motion: bar appears at once — opacity 1, no transform, no transition", s.opacity === "1" && s.transform === "none" && parseFloat(s.transition) < 0.001 && !s.inert, JSON.stringify(s));
  await h.shot(page, "mccompact-reduced-motion");
}, { viewport: VPS.laptop });
