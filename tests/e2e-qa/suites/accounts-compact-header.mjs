/**
 * Browser QA scenarios (accounts-compact-header.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Accounts' compact bar: the shared zero-height sticky overlay, shown once the page title has scrolled away.
 * These scenarios only read and navigate; the one write-capable control (Add Account) is opened and cancelled.
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
const intersects = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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
    const id = `acccompact-${vpName}-${scheme}`;
    scenario(id, `Accounts compact bar: ${vpName} ${vp.width}x${vp.height}, ${scheme} theme`, async ({ page }, chk) => {
      await goTo(page, "/accounts");
      await page.getByRole("heading", { level: 1, name: "Accounts" }).waitFor();
      await page.waitForTimeout(2500);

      const bar = page.getByRole("region", { name: "Accounts quick bar" });
      const barEl = page.locator("[data-compact-bar]");
      const summaryTotal = page.getByRole("region", { name: "Summary" }).getByRole("button", { name: "Explain total balance" });
      const search = page.getByRole("textbox", { name: "Search accounts" });
      const panel = page.locator("aside").filter({ hasText: "Account overview" });

      // ── Expanded: unchanged header, hidden bar ──
      chk("expanded: bar is inert, aria-hidden and not in the accessibility tree", (await barEl.getAttribute("inert")) !== null && (await barEl.getAttribute("aria-hidden")) === "true" && (await bar.count()) === 0);
      chk("expanded: header has exactly one Add Account, and Refresh/Groups are disabled", (await page.getByRole("button", { name: "Add Account", exact: true }).count()) === 1 && (await page.locator("main header button:disabled").count()) === 2);
      const total = (await summaryTotal.innerText()).replace(/\s+/g, " ").trim();
      const room = await maxScroll(page);
      chk("page is tall enough to scroll the title away", room > 250, `${room}px of scroll`);
      await h.shot(page, `${id}-1-expanded`);

      // ── State to retain: a search and a type filter ──
      await search.fill("QA");
      const chipsGroup = page.getByRole("radiogroup", { name: "Account type" });
      const chips = chipsGroup.getByRole("radio");
      const chipCount = await chips.count();
      let chipLabel = "All";
      if (chipCount > 1) { await chips.nth(1).click(); chipLabel = (await chips.nth(1).innerText()).trim(); }
      const tiles = async () => (await page.getByRole("region", { name: "My accounts" }).innerText()).replace(/\s+/g, " ");
      const tilesBefore = await tiles();
      await page.waitForTimeout(500);
      const baseline = { scrollHeight: await page.evaluate(() => document.querySelector("main").scrollHeight), totalTop: await summaryTotal.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop) };

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
      chk("compact Total balance equals the summary's figure", barText.includes(total.match(/₹[\d,]+(\.\d+)?/)?.[0] ?? "∅"), `summary "${total}" · bar "${barText}"`);
      const now = { scrollHeight: await page.evaluate(() => document.querySelector("main").scrollHeight), totalTop: await summaryTotal.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop) };
      chk("no layout shift: page height and content offsets unchanged by the bar", now.scrollHeight === baseline.scrollHeight && Math.abs(now.totalTop - baseline.totalTop) < 1, `${baseline.scrollHeight}→${now.scrollHeight}, ${baseline.totalTop}→${now.totalTop}`);
      const ox = await overflowX(page);
      chk("no horizontal overflow (page and main)", ox.doc <= 1 && ox.main <= 1, JSON.stringify(ox));
      for (const [name, role] of [["More actions", "button"], ["Add Account", "button"]]) {
        const b = await bar.getByRole(role, { name }).boundingBox();
        chk(`bar control "${name}" present with a ≥40px target`, b && b.height >= 39 && b.width >= 39, JSON.stringify(b && { w: Math.round(b.width), h: Math.round(b.height) }));
      }
      const tc = await colorsOf(bar.getByText("Accounts", { exact: true }));
      chk("bar title contrast ≥ 4.5:1", ratio(tc.fg, tc.bg) >= 4.5, `${ratio(tc.fg, tc.bg).toFixed(2)}:1`);

      // ── Overview panel: not covered ──
      if (await panel.count()) {
        const pb = await panel.boundingBox();
        chk("overview panel is not covered by the compact bar", !intersects(pb, bb), JSON.stringify({ panel: pb && { x: Math.round(pb.x), y: Math.round(pb.y - mainTop), w: Math.round(pb.width) }, bar: bb && { x: Math.round(bb.x), w: Math.round(bb.width) } }));
        chk("overview panel stays fully inside the content area (top not clipped)", pb && pb.y >= mainTop - 1, `top ${pb && Math.round(pb.y - mainTop)}px below the content area top`);
        const edits = await panel.getByRole("button", { name: /Edit|View transactions/ }).count();
        chk("overview panel actions still reachable (Edit / View transactions present)", edits >= 1, `${edits}`);
      } else chk.finding("ACC-NOPANEL", "overview panel present for this viewport", false, "no aside rendered");
      await h.shot(page, `${id}-3-collapsed`);

      // ── State retained across the bar appearing ──
      chk("search value and account list retained while collapsed", (await search.inputValue()) === "QA" && (await tiles()) === tilesBefore);
      if (chipCount > 1) chk("type filter retained while collapsed", (await chips.nth(1).getAttribute("aria-checked")) === "true", chipLabel);

      // ── ⋯ menu: disabled items, anchored while page scrolls ──
      await bar.getByRole("button", { name: "More actions" }).click();
      const refresh = page.getByRole("menuitem", { name: /Refresh/ });
      await refresh.waitFor();
      const groups = page.getByRole("menuitem", { name: /Groups/ });
      chk("menu: Refresh and Groups stay disabled and marked Soon", (await refresh.getAttribute("aria-disabled")) === "true" && (await groups.getAttribute("aria-disabled")) === "true" && /soon/i.test(await refresh.innerText()) && /soon/i.test(await groups.innerText()));
      const trig = page.locator('[data-compact-bar] button[aria-label="More actions"]'); // a modal menu hides the rest of the page from the a11y tree, so locate by attribute
      await page.waitForTimeout(400); // let the menu's 100ms open animation finish before measuring
      const t1 = await trig.boundingBox();
      const m1 = await refresh.boundingBox();
      await scrollMain(page, Math.min(room, 420));
      await page.waitForTimeout(300);
      const m2 = await refresh.boundingBox();
      const t2 = await trig.boundingBox();
      chk("menu stays anchored while open (offset from its trigger unchanged)", m1 && m2 && t1 && t2 && Math.abs((m1.y - t1.y) - (m2.y - t2.y)) < 2, JSON.stringify({ menu: [m1 && Math.round(m1.y), m2 && Math.round(m2.y)], trigger: [t1 && Math.round(t1.y), t2 && Math.round(t2.y)] }));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);

      // ── Add Account from the bar: opens the same dialog; cancel leaves nothing behind ──
      await bar.getByRole("button", { name: "Add Account" }).click();
      const dlg = page.getByRole("dialog");
      await dlg.waitFor();
      chk("Add Account from the compact bar opens the account dialog", await dlg.isVisible());
      await h.shot(page, `${id}-4-dialog`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      chk("dialog closes with Escape; page state intact (search + filter)", (await dlg.count()) === 0 && (await search.inputValue()) === "QA" && (await tiles()) === tilesBefore);

      // ── Viewport change with panel open and page scrolled ──
      const other = vp.width > 600 ? { width: 390, height: 844 } : { width: 1366, height: 768 };
      await page.setViewportSize(other);
      await page.waitForTimeout(900);
      await scrollMain(page, Math.min(await maxScroll(page), 400));
      await page.waitForTimeout(600);
      const ob = await barEl.boundingBox();
      const ox2 = await overflowX(page);
      chk(`viewport change → ${other.width}px: bar still pinned, no horizontal overflow`, ob && (await barEl.getAttribute("inert")) === null && ob.x >= 0 && ob.x + ob.width <= other.width + 1 && ox2.doc <= 1 && ox2.main <= 1, JSON.stringify({ bar: ob && { x: Math.round(ob.x), w: Math.round(ob.width) }, ox2 }));
      if (await panel.count()) {
        const pb2 = await panel.boundingBox();
        chk(`viewport change → ${other.width}px: overview panel not covered`, !intersects(pb2, ob), JSON.stringify(pb2 && { y: Math.round(pb2.y), w: Math.round(pb2.width) }));
      }
      await h.shot(page, `${id}-5-resized`);
      await page.setViewportSize(vp);
      await page.waitForTimeout(900);

      // ── Back to the top ──
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await scrollMain(page, 0);
      await page.waitForTimeout(700);
      chk("title back in view: bar hides and is inert again", (await barEl.getAttribute("inert")) !== null && (await bar.count()) === 0);
      chk("title back in view: Total balance unchanged", (await summaryTotal.innerText()).replace(/\s+/g, " ").trim() === total);
      chk("title back in view: search and filter retained", (await search.inputValue()) === "QA" && (await tiles()) === tilesBefore);
      await h.shot(page, `${id}-6-back-to-top`);
    }, { viewport: vp, scheme });
  }
}

scenario("acccompact-reduced-motion", "Accounts compact bar: prefers-reduced-motion — no slide", async ({ page }, chk) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await goTo(page, "/accounts");
  await page.getByRole("heading", { level: 1, name: "Accounts" }).waitFor();
  await page.waitForTimeout(2000);
  const barEl = page.locator("[data-compact-bar]");
  await scrollMain(page, 30);
  await page.waitForTimeout(300);
  chk("reduced motion: mid-transition the bar is still fully hidden", await barEl.evaluate((el) => getComputedStyle(el).visibility === "hidden"));
  await scrollMain(page, Math.min(await maxScroll(page), 400));
  await page.waitForTimeout(300);
  const s = await barEl.evaluate((el) => ({ vis: getComputedStyle(el).visibility, transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration, inert: el.hasAttribute("inert") }));
  chk("reduced motion: bar appears at once — no transform, no transition", s.vis === "visible" && s.transform === "none" && parseFloat(s.transition) < 0.001 && !s.inert, JSON.stringify(s));
  await h.shot(page, "acccompact-reduced-motion");
}, { viewport: VPS.laptop });
