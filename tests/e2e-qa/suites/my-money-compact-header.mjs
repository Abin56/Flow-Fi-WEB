/**
 * Browser QA scenarios (my-money-compact-header.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * My Money's compact bar: the shared zero-height sticky overlay, shown once the page title has scrolled away.
 * Read-only scenarios — period nav buttons are clicked and then returned to the starting period.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const VPS = { desktop: { width: 1920, height: 720 }, laptop: { width: 1366, height: 768 }, mobile: { width: 390, height: 844 } };

const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const goTo = async (page, href) => {
  await page.evaluate((x) => window.next.router.push(x), href);
  let at = "";
  for (let i = 0; i < 120; i++) { at = await page.evaluate(() => location.pathname); if (at.replace(/[/]$/, "") === href) return; await page.waitForTimeout(250); }
  throw new Error(`navigation to ${href} did not land; at ${at}`);
};
const scrollMain = (page, top) => page.evaluate((t) => { document.querySelector("main").scrollTop = t; }, top);
const maxScroll = (page) => page.evaluate(() => document.querySelector("main").scrollHeight - document.querySelector("main").clientHeight);
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
    const id = `mmcompact-${vpName}-${scheme}`;
    scenario(id, `My Money compact bar: ${vpName} ${vp.width}x${vp.height}, ${scheme} theme`, async ({ page }, chk) => {
      await goTo(page, "/my-money");
      await page.getByRole("heading", { level: 1, name: "My Money" }).waitFor();
      await page.waitForTimeout(2500);

      const bar = page.getByRole("region", { name: "My Money quick bar" });
      const barEl = page.locator("[data-compact-bar]");
      const summary = page.getByRole("region", { name: "Period summary" });
      const periodLabelHeading = await page.locator("main header").first().innerText();

      // ── Expanded: hidden bar ──
      chk("expanded: bar is inert, aria-hidden and not in the accessibility tree", (await barEl.getAttribute("inert")) !== null && (await barEl.getAttribute("aria-hidden")) === "true" && (await bar.count()) === 0);
      const room = await maxScroll(page);
      chk("page has at least some scroll room to move the title out of view", room > 50, `${room}px of scroll`);
      await h.shot(page, `${id}-1-expanded`);

      const toPayText = (await summary.innerText()).match(/₹[\d,]+(\.\d+)?/)?.[0] ?? "∅";
      await page.waitForTimeout(500);
      const baseline = { scrollHeight: await page.evaluate(() => document.querySelector("main").scrollHeight), summaryTop: await summary.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop) };

      // ── Scroll jitter in the transition band ──
      await scrollMain(page, 30);
      const samples = [];
      for (let i = 0; i < 5; i++) { await page.waitForTimeout(120); samples.push(await page.evaluate(() => document.querySelector("main").scrollTop)); }
      chk("transition band: scrollTop holds steady (no jitter)", samples.every((s) => s === samples[0]), samples.join(","));
      const entering = await barEl.evaluate((el) => { const cs = getComputedStyle(el); return { opacity: cs.opacity, bg: cs.backgroundColor.includes("/") ? "translucent" : "opaque", state: el.dataset.state }; });
      chk("transition: bar slides in opaque — no cross-fade over header text", entering.opacity === "1" && entering.bg === "opaque", JSON.stringify(entering));
      await h.shot(page, `${id}-2-entering`);

      // ── Collapsed ──
      await scrollMain(page, Math.min(room, 400));
      await page.waitForTimeout(500);
      await bar.waitFor({ state: "visible" });
      const mainTop = await page.evaluate(() => document.querySelector("main").getBoundingClientRect().top);
      const bb = await barEl.boundingBox();
      chk("collapsed: bar interactive, pinned 8px below the top of the content area", (await barEl.getAttribute("inert")) === null && bb && Math.abs(bb.y - (mainTop + 8)) <= 2 && Math.abs(bb.height - 48) <= 2, JSON.stringify(bb && { y: Math.round(bb.y - mainTop), h: Math.round(bb.height) }));
      chk("collapsed: bar fits the viewport width", bb && bb.x >= 0 && bb.x + bb.width <= vp.width + 1, JSON.stringify(bb && { x: Math.round(bb.x), w: Math.round(bb.width) }));
      const cover = await page.evaluate(() => { const m = document.querySelector("main").getBoundingClientRect(); const b = document.querySelector("[data-compact-bar]").getBoundingClientRect(); return [0, 1, 3, 6].every((d) => !!document.elementFromPoint(b.left + b.width / 2, m.top + d)?.closest("[data-compact-bar]")); });
      chk("no scrolling content peeks out above the bar", cover);
      const barText = (await bar.innerText()).replace(/\s+/g, " ");
      const nextLink = bar.getByRole("link");
      // The To pay figure is dropped below `sm` to save space — only the Next obligation CTA stays on mobile.
      if (vp.width >= 640) chk("compact To pay figure equals the summary's figure", barText.includes(toPayText), `summary "${toPayText}" · bar "${barText}"`);
      else chk("mobile: To pay figure intentionally hidden, Next obligation CTA still shown", !barText.includes("To pay") && (await nextLink.count()) >= 1, barText);
      const now = { scrollHeight: await page.evaluate(() => document.querySelector("main").scrollHeight), summaryTop: await summary.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop) };
      chk("no layout shift: page height and content offsets unchanged by the bar", now.scrollHeight === baseline.scrollHeight && Math.abs(now.summaryTop - baseline.summaryTop) < 1, `${baseline.scrollHeight}→${now.scrollHeight}, ${baseline.summaryTop}→${now.summaryTop}`);
      const ox = await overflowX(page);
      chk("no horizontal overflow (page and main)", ox.doc <= 1 && ox.main <= 1, JSON.stringify(ox));
      if (await nextLink.count()) {
        const nb = await nextLink.boundingBox();
        chk("Next obligation CTA has a ≥40px target", nb && nb.height >= 39, JSON.stringify(nb && { w: Math.round(nb.width), h: Math.round(nb.height) }));
      }
      for (const name of ["Previous period", "Next period"]) {
        const b = await bar.getByRole("button", { name }).boundingBox();
        chk(`bar control "${name}" present with a ≥28px target`, b && b.height >= 27 && b.width >= 27, JSON.stringify(b && { w: Math.round(b.width), h: Math.round(b.height) }));
      }
      const tc = await colorsOf(bar.getByText("My Money", { exact: true }));
      chk("bar title contrast ≥ 4.5:1", ratio(tc.fg, tc.bg) >= 4.5, `${ratio(tc.fg, tc.bg).toFixed(2)}:1`);
      await h.shot(page, `${id}-3-collapsed`);

      // ── Period nav from the bar drives the same state as the header, then returns ──
      await bar.getByRole("button", { name: "Previous period" }).click();
      await page.waitForTimeout(700);
      const headerAfterPrev = await page.locator("main header").first().innerText();
      chk("Previous period from the bar changes the expanded header's period too", headerAfterPrev !== periodLabelHeading, `before "${periodLabelHeading.slice(0, 40)}" · after "${headerAfterPrev.slice(0, 40)}"`);
      await h.shot(page, `${id}-4-after-prev`);
      await bar.getByRole("button", { name: "Next period" }).click();
      await page.waitForTimeout(700);
      const headerRestored = await page.locator("main header").first().innerText();
      chk("Next period restores the original header period", headerRestored === periodLabelHeading, `restored "${headerRestored.slice(0, 40)}"`);

      // ── Viewport change while scrolled ──
      const other = vp.width > 600 ? { width: 390, height: 844 } : { width: 1366, height: 768 };
      await page.setViewportSize(other);
      await page.waitForTimeout(900);
      await scrollMain(page, Math.min(await maxScroll(page), 400));
      await page.waitForTimeout(600);
      const ob = await barEl.boundingBox();
      const ox2 = await overflowX(page);
      chk(`viewport change → ${other.width}px: bar still pinned, no horizontal overflow`, ob && (await barEl.getAttribute("inert")) === null && ob.x >= 0 && ob.x + ob.width <= other.width + 1 && ox2.doc <= 1 && ox2.main <= 1, JSON.stringify({ bar: ob && { x: Math.round(ob.x), w: Math.round(ob.width) }, ox2 }));
      await h.shot(page, `${id}-5-resized`);
      await page.setViewportSize(vp);
      await page.waitForTimeout(900);

      // ── Back to the top ──
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await scrollMain(page, 0);
      await page.waitForTimeout(700);
      chk("title back in view: bar hides and is inert again", (await barEl.getAttribute("inert")) !== null && (await bar.count()) === 0);
      chk("title back in view: header period unchanged", (await page.locator("main header").first().innerText()) === periodLabelHeading);
      await h.shot(page, `${id}-6-back-to-top`);
    }, { viewport: vp, scheme });
  }
}

scenario("mmcompact-reduced-motion", "My Money compact bar: prefers-reduced-motion — no slide", async ({ page }, chk) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await goTo(page, "/my-money");
  await page.getByRole("heading", { level: 1, name: "My Money" }).waitFor();
  await page.waitForTimeout(2000);
  const barEl = page.locator("[data-compact-bar]");
  await scrollMain(page, 30);
  await page.waitForTimeout(300);
  chk("reduced motion: mid-transition the bar is still fully hidden", await barEl.evaluate((el) => getComputedStyle(el).visibility === "hidden"));
  await scrollMain(page, Math.min(await maxScroll(page), 400));
  await page.waitForTimeout(300);
  const s = await barEl.evaluate((el) => ({ vis: getComputedStyle(el).visibility, transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration, inert: el.hasAttribute("inert") }));
  chk("reduced motion: bar appears at once — no transform, no transition", s.vis === "visible" && s.transform === "none" && parseFloat(s.transition) < 0.001 && !s.inert, JSON.stringify(s));
  await h.shot(page, "mmcompact-reduced-motion");
}, { viewport: VPS.laptop });
