/**
 * Browser QA scenarios (credit-cards-compact-header.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Credit Cards' compact bar: the shared zero-height sticky overlay, shown once the page title has scrolled away.
 * Scenarios only read and navigate; Add Card and the activity sheet are opened and cancelled, nothing is saved.
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
const norm = (t) => t.replace(/\s+/g, " ").trim();
/** Is the element's centre point actually hit by that element (not covered by something above it)? */
const reachable = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && el.contains(hit); });

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
    const id = `cccompact-${vpName}-${scheme}`;
    scenario(id, `Credit Cards compact bar: ${vpName} ${vp.width}x${vp.height}, ${scheme} theme`, async ({ page }, chk) => {
      await goTo(page, "/credit-cards");
      await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
      await page.waitForTimeout(3000);

      const bar = page.getByRole("region", { name: "Credit Cards quick bar" });
      const barEl = page.locator("[data-compact-bar]");
      const summary = page.locator("#cc-summary");
      const aside = page.locator("main aside");
      const viewGroup = page.getByRole("radiogroup", { name: "View" });
      const sheetEl = page.getByRole("dialog", { name: "Card activity" });
      /** After View statements: the existing activity sheet is open on Bills, with the statements section revealed below its sticky tabs. */
      const verifyStatements = async (from) => {
        await sheetEl.waitFor();
        await page.waitForTimeout(1500);
        const tabSel = await sheetEl.getByRole("tab", { name: /Bills/ }).getAttribute("aria-selected");
        chk(`View statements (${from}): opens the existing activity sheet on the Bills tab`, tabSel === "true", `aria-selected=${tabSel}`);
        const target = page.locator("#upcoming-statements");
        const geo = await target.evaluate((el) => { const r = el.getBoundingClientRect(); const tabs = document.querySelector('#card-activity [role="tablist"]')?.getBoundingClientRect(); const body = document.getElementById("card-activity-body").getBoundingClientRect(); return { top: Math.round(r.top), tabsBottom: tabs ? Math.round(tabs.bottom) : null, bodyTop: Math.round(body.top), hit: !!document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + 8)?.closest("#upcoming-statements") }; }).catch(() => null);
        chk(`View statements (${from}): #upcoming-statements exists in the sheet and is revealed (not under the sticky tabs)`, !!geo && geo.hit && (geo.tabsBottom == null || geo.top >= geo.tabsBottom - 1), JSON.stringify(geo));
        const bbSheet = await sheetEl.boundingBox();
        const barBox = await page.locator("[data-compact-bar]").boundingBox();
        chk(`View statements (${from}): sheet is fully visible (not covered by the compact bar)`, await sheetEl.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return !!hit && el.contains(hit); }), JSON.stringify({ sheet: bbSheet && Math.round(bbSheet.y), bar: barBox && Math.round(barBox.y) }));
        chk(`View statements (${from}): no horizontal overflow`, (await overflowX(page)).doc <= 1);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(700);
        chk(`View statements (${from}): sheet closes with Escape`, (await sheetEl.count()) === 0);
      };

      // ── Expanded: unchanged header, hidden bar ──
      chk("expanded: bar is inert, aria-hidden and not in the accessibility tree", (await barEl.getAttribute("inert")) !== null && (await barEl.getAttribute("aria-hidden")) === "true" && (await bar.count()) === 0);
      chk("expanded: header has exactly one Add Card and one More menu", (await page.getByRole("button", { name: "Add Card", exact: true }).count()) === 1 && (await page.locator("main header button").count()) === 2);
      const summaryText = norm(await summary.innerText());
      const used = (await summary.locator("p").first().innerText()).trim();
      const pct = summaryText.match(/(\d+)% used/)?.[1];
      const availableText = await summary.evaluate((el) => { const lbl = [...el.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === "Available"); return lbl?.parentElement?.textContent.match(/₹[0-9,]+(?:[.][0-9]+)?/)?.[0] ?? null; });
      chk("summary values readable for comparison", !!used && !!pct && !!availableText, `used ${used} · ${pct}% · available ${availableText}`);
      const room = await maxScroll(page);
      chk("page is tall enough to scroll the title away", room > 100, `${room}px of scroll`);
      await h.shot(page, `${id}-1-expanded`);

      // ── State to retain: Cards/List switch ──
      await viewGroup.getByRole("radio", { name: "List" }).click();
      await page.waitForTimeout(400);
      const baseline = { scrollHeight: await page.evaluate(() => document.querySelector("main").scrollHeight), summaryTop: await summary.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop) };
      const roomList = await maxScroll(page);

      // ── Scroll jitter + opaque slide-in ──
      await scrollMain(page, 30);
      const samples = [];
      for (let i = 0; i < 5; i++) { await page.waitForTimeout(120); samples.push(await page.evaluate(() => document.querySelector("main").scrollTop)); }
      chk("transition band: scrollTop holds steady (no jitter)", samples.every((s) => s === samples[0]), samples.join(","));
      const entering = await barEl.evaluate((el) => { const cs = getComputedStyle(el); return { opacity: cs.opacity, bg: cs.backgroundColor.includes("/") ? "translucent" : "opaque", state: el.dataset.state }; });
      chk("transition: bar slides in opaque — no cross-fade over header text", entering.opacity === "1" && entering.bg === "opaque", JSON.stringify(entering));
      await h.shot(page, `${id}-2-entering`);

      // ── Collapsed ──
      await scrollMain(page, Math.min(roomList, 380));
      await page.waitForTimeout(500);
      await bar.waitFor({ state: "visible" });
      const mainTop = await page.evaluate(() => document.querySelector("main").getBoundingClientRect().top);
      const bb = await barEl.boundingBox();
      chk("collapsed: bar interactive and pinned 8px below the top of the content area", (await barEl.getAttribute("inert")) === null && bb && Math.abs(bb.y - (mainTop + 8)) <= 2 && Math.abs(bb.height - 48) <= 2, JSON.stringify(bb && { y: Math.round(bb.y - mainTop), h: Math.round(bb.height) }));
      chk("collapsed: bar fits the viewport width", bb && bb.x >= 0 && bb.x + bb.width <= vp.width + 1, JSON.stringify(bb && { x: Math.round(bb.x), w: Math.round(bb.width) }));
      chk("no scrolling content peeks out above the bar", await page.evaluate(() => { const m = document.querySelector("main").getBoundingClientRect(); const b = document.querySelector("[data-compact-bar]").getBoundingClientRect(); return [0, 1, 3, 6].every((d) => !!document.elementFromPoint(b.left + b.width / 2, m.top + d)?.closest("[data-compact-bar]")); }));
      const barText = norm(await bar.innerText());
      chk("compact Credit used equals the summary's figure", barText.includes(used), `summary "${used}" · bar "${barText}"`);
      chk("compact utilization % equals the summary's", barText.includes(`${pct}%`), `${pct}%`);
      if (vp.width >= 1024) chk("compact Available equals the summary's figure (lg+)", barText.includes(availableText), availableText);
      const clipped = await bar.evaluate((el) => [...el.querySelectorAll("span")].filter((s) => s.scrollWidth > s.clientWidth + 1 && getComputedStyle(s).overflow !== "visible").map((s) => s.textContent.trim()));
      chk("no clipped figures in the bar", clipped.length === 0, JSON.stringify(clipped));
      const now = { scrollHeight: await page.evaluate(() => document.querySelector("main").scrollHeight), summaryTop: await summary.evaluate((el) => el.getBoundingClientRect().top + document.querySelector("main").scrollTop) };
      chk("no layout shift: page height and content offsets unchanged by the bar", now.scrollHeight === baseline.scrollHeight && Math.abs(now.summaryTop - baseline.summaryTop) < 1, `${baseline.scrollHeight}→${now.scrollHeight}, ${baseline.summaryTop}→${now.summaryTop}`);
      const ox = await overflowX(page);
      chk("no horizontal overflow (page and main)", ox.doc <= 1 && ox.main <= 1, JSON.stringify(ox));
      for (const name of ["More actions", "Add Card"]) {
        const b = await bar.getByRole("button", { name }).boundingBox();
        chk(`bar control "${name}" present with a ≥40px target`, b && b.height >= 39 && b.width >= 39, JSON.stringify(b && { w: Math.round(b.width), h: Math.round(b.height) }));
      }
      const tc = await colorsOf(bar.getByText("Credit Cards", { exact: true }));
      chk("bar title contrast ≥ 4.5:1", ratio(tc.fg, tc.bg) >= 4.5, `${ratio(tc.fg, tc.bg).toFixed(2)}:1`);
      chk("Cards/List choice retained while collapsed", (await viewGroup.getByRole("radio", { name: "List" }).getAttribute("aria-checked")) === "true");
      await h.shot(page, `${id}-3-collapsed`);

      // ── Selected-card aside: not covered; Pay bill / Statement reachable ──
      const ab = await aside.boundingBox();
      chk("selected-card panel is not covered by the compact bar", !intersects(ab, bb), JSON.stringify({ aside: ab && { y: Math.round(ab.y - mainTop), h: Math.round(ab.height) }, bar: bb && { y: Math.round(bb.y - mainTop), h: Math.round(bb.height) } }));
      if (vp.width >= 1280) chk("xl: panel sticks below the bar (top ≥ bar bottom)", ab && bb && ab.y >= bb.y + bb.height - 1, JSON.stringify({ asideTop: ab && Math.round(ab.y - mainTop), barBottom: bb && Math.round(bb.y + bb.height - mainTop) }));
      const payBill = aside.getByRole("button", { name: "Pay bill", exact: true });
      const statement = aside.getByRole("button", { name: "Statement", exact: true });
      await payBill.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      chk("Pay bill is reachable (not covered by the bar) while scrolled", await reachable(payBill));
      chk("Statement is reachable (not covered by the bar) while scrolled", await reachable(statement));
      await h.shot(page, `${id}-4-aside`);
      await scrollMain(page, Math.min(roomList, 380));
      await page.waitForTimeout(400);

      // ── More menu: items, disabled export, scroll targets ──
      await bar.getByRole("button", { name: "More actions" }).click();
      const exp = page.getByRole("menuitem", { name: /Export statements/ });
      await exp.waitFor();
      chk("bar More: View statements, Manage cards present; Export statements disabled and Soon", (await page.getByRole("menuitem", { name: /View statements/ }).count()) === 1 && (await page.getByRole("menuitem", { name: /Manage cards/ }).count()) === 1 && (await exp.getAttribute("aria-disabled")) === "true" && /soon/i.test(await exp.innerText()));
      await page.waitForTimeout(400);
      const trig = page.locator('[data-compact-bar] button[aria-label="More actions"]');
      const t1 = await trig.boundingBox(); const m1 = await exp.boundingBox();
      await scrollMain(page, Math.min(roomList, 340));
      await page.waitForTimeout(300);
      const t2 = await trig.boundingBox(); const m2 = await exp.boundingBox();
      chk("menu stays anchored while open (offset from its trigger unchanged)", t1 && t2 && m1 && m2 && Math.abs((m1.y - t1.y) - (m2.y - t2.y)) < 2, JSON.stringify({ menu: [m1 && Math.round(m1.y), m2 && Math.round(m2.y)], trigger: [t1 && Math.round(t1.y), t2 && Math.round(t2.y)] }));
      await page.getByRole("menuitem", { name: /Manage cards/ }).click();
      await page.waitForTimeout(1500);
      const mc = await page.locator("#my-credit-cards").boundingBox();
      const bb2 = await barEl.boundingBox();
      chk("Manage cards: scroll target (#my-credit-cards) is not hidden under the bar", mc && bb2 && mc.y >= bb2.y + bb2.height - 1, JSON.stringify({ targetTop: mc && Math.round(mc.y - mainTop), barBottom: bb2 && Math.round(bb2.y + bb2.height - mainTop) }));
      await scrollMain(page, Math.min(roomList, 380));
      await page.waitForTimeout(400);
      await bar.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: /View statements/ }).click();
      await verifyStatements("compact bar");

      // ── Add Card from the bar ──
      await scrollMain(page, Math.min(roomList, 380));
      await page.waitForTimeout(400);
      await bar.getByRole("button", { name: "Add Card" }).click();
      const dlg = page.getByRole("dialog");
      await dlg.waitFor();
      chk("Add Card from the compact bar opens the card dialog", await dlg.isVisible());
      await h.shot(page, `${id}-5-dialog`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      chk("dialog closes with Escape; Cards/List choice intact", (await dlg.count()) === 0 && (await viewGroup.getByRole("radio", { name: "List" }).getAttribute("aria-checked")) === "true");

      // ── Card selection + activity sheet while scrolled ──
      await viewGroup.getByRole("radio", { name: "Cards" }).click();
      await page.waitForTimeout(400);
      await page.locator("#my-credit-cards").getByText("QA Credit Card").first().click();
      const sheet = page.getByRole("dialog", { name: "Card activity" });
      await sheet.waitFor();
      await page.waitForTimeout(900);
      const sb = await sheet.boundingBox();
      chk("activity sheet opens on top of the page while scrolled (not under the bar)", sb && (await sheet.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return !!hit && el.contains(hit); })), JSON.stringify(sb && { y: Math.round(sb.y - mainTop), h: Math.round(sb.height) }));
      chk("activity sheet: no horizontal overflow", (await overflowX(page)).doc <= 1);
      await h.shot(page, `${id}-6-sheet`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
      chk("activity sheet closes with Escape; bar still correct", (await sheet.count()) === 0 && (await barEl.getAttribute("inert")) === null);

      // ── Viewport change ──
      const other = vp.width > 600 ? { width: 390, height: 844 } : { width: 1366, height: 768 };
      await page.setViewportSize(other);
      await page.waitForTimeout(900);
      await scrollMain(page, Math.min(await maxScroll(page), 380));
      await page.waitForTimeout(600);
      const ob = await barEl.boundingBox();
      const ox2 = await overflowX(page);
      chk(`viewport change → ${other.width}px: bar pinned, no horizontal overflow`, ob && (await barEl.getAttribute("inert")) === null && ob.x >= 0 && ob.x + ob.width <= other.width + 1 && ox2.doc <= 1 && ox2.main <= 1, JSON.stringify({ bar: ob && { x: Math.round(ob.x), w: Math.round(ob.width) }, ox2 }));
      const ab2 = await aside.boundingBox();
      chk(`viewport change → ${other.width}px: selected-card panel not covered`, !intersects(ab2, ob), JSON.stringify(ab2 && { y: Math.round(ab2.y), w: Math.round(ab2.width) }));
      await h.shot(page, `${id}-7-resized`);
      await page.setViewportSize(vp);
      await page.waitForTimeout(900);

      // ── Back to the top ──
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await scrollMain(page, 0);
      await page.waitForTimeout(700);
      chk("title back in view: bar hides and is inert again", (await barEl.getAttribute("inert")) !== null && (await bar.count()) === 0);
      chk("title back in view: summary unchanged", norm(await summary.innerText()) === summaryText);
      await h.shot(page, `${id}-8-back-to-top`);

      // ── Expanded header's More: accessible name (also at 390px), keyboard, View statements ──
      const headerMore = page.locator("main header").getByRole("button", { name: "More actions" });
      chk("expanded header: More button has the accessible name \"More actions\" (at every width)", (await headerMore.count()) === 1);
      await headerMore.focus();
      chk("expanded header: More button is keyboard-focusable", await headerMore.evaluate((el) => document.activeElement === el));
      await page.keyboard.press("Enter");
      const hv = page.getByRole("menuitem", { name: /View statements/ });
      await hv.waitFor();
      chk("expanded header: Enter opens the More menu (View statements, Manage cards, disabled Export)", (await page.getByRole("menuitem", { name: /Manage cards/ }).count()) === 1 && (await page.getByRole("menuitem", { name: /Export statements/ }).getAttribute("aria-disabled")) === "true");
      await hv.click();
      await verifyStatements("expanded header");
      await headerMore.click();
      await page.getByRole("menuitem", { name: /Manage cards/ }).click();
      await page.waitForTimeout(1200);
      chk("expanded header: Manage cards still scrolls to #my-credit-cards", (await page.locator("#my-credit-cards").boundingBox())?.y !== undefined);
      await scrollMain(page, 0);
      await page.waitForTimeout(600);

      // ── Add Card from the original header ──
      await page.getByRole("button", { name: "Add Card", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      chk("Add Card from the expanded header opens the same dialog", await page.getByRole("dialog").isVisible());
      await page.keyboard.press("Escape");
    }, { viewport: vp, scheme });
  }
}

scenario("cccompact-reduced-motion", "Credit Cards compact bar: prefers-reduced-motion — no slide", async ({ page }, chk) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await goTo(page, "/credit-cards");
  await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
  await page.waitForTimeout(2500);
  const barEl = page.locator("[data-compact-bar]");
  await scrollMain(page, 30);
  await page.waitForTimeout(300);
  chk("reduced motion: mid-transition the bar is still fully hidden", await barEl.evaluate((el) => getComputedStyle(el).visibility === "hidden"));
  await scrollMain(page, Math.min(await maxScroll(page), 380));
  await page.waitForTimeout(300);
  const s = await barEl.evaluate((el) => ({ vis: getComputedStyle(el).visibility, transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration, inert: el.hasAttribute("inert") }));
  chk("reduced motion: bar appears at once — no transform, no transition", s.vis === "visible" && s.transform === "none" && parseFloat(s.transition) < 0.001 && !s.inert, JSON.stringify(s));
  await h.shot(page, "cccompact-reduced-motion");
}, { viewport: VPS.laptop });
