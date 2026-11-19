/**
 * App-wide capsule scrollbars (capscroll-*). Real mouse input only — synthetic emulator data.
 *   npm run test:e2e-qa -- capscroll- --copy
 *
 * capscroll-main-<scheme>  main page: capsule in the native gutter, layout unchanged, 0/25/50/75/100% drag mapping,
 *                          track click, wheel sync, release over a link never navigates, sidebar keeps its own.
 * capscroll-dialog         a scrollable dialog/sheet body: capsule works and pressing it never closes the dialog.
 * capscroll-dropdown       a long Select dropdown: capsule works and dragging never picks an option or closes it.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

/** Instant scroll reset (some panels use CSS scroll-behavior: smooth, which would animate a plain assignment). */
const resetTop = (loc) => loc.evaluate((n) => { const b = n.style.scrollBehavior; n.style.scrollBehavior = "auto"; n.scrollTop = 0; n.style.scrollBehavior = b; });
const path = (page) => page.evaluate(() => location.pathname.replace(/\/+$/, ""));

/** Finds the visible capsule track drawn for the element marked data-qa-cap. */
async function findTrack(page) {
  return page.evaluate(() => {
    const el = document.querySelector("[data-qa-cap]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const tracks = [...document.querySelectorAll('[data-testid="capsule-track"][data-axis="y"]')].filter((t) => !t.dataset.hidden && !t.dataset.leaving);
    const hit = tracks.find((t) => {
      const b = t.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      return cx > r.right - 24 && cx < r.right + 4 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
    });
    if (!hit) return { found: false, tracks: tracks.length };
    tracks.forEach((t) => delete t.dataset.qaTrack);
    hit.dataset.qaTrack = "1";
    const b = hit.getBoundingClientRect();
    const th = hit.firstElementChild.getBoundingClientRect();
    const vis = { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, innerHeight) };
    return {
      found: true,
      len: b.height,
      cap: th.height,
      capW: th.width,
      centreOff: b.top + b.height / 2 - (vis.top + vis.bottom) / 2,
      gutter: el.offsetWidth - el.clientWidth,
    };
  });
}

async function exercise(page, chk, label) {
  const el = page.locator("[data-qa-cap]");
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  await page.waitForTimeout(250);
  const info = await findTrack(page);
  chk(`${label}: capsule appears on hover`, info?.found, JSON.stringify(info));
  if (!info?.found) return;
  chk(`${label}: short track (≤ 228px)`, info.len <= 228, info.len);
  chk(`${label}: track centred on visible area`, Math.abs(info.centreOff) <= 2, info.centreOff);
  chk(`${label}: capsule 24–48px long, 12px wide`, info.cap >= 24 && info.cap <= 48 && info.capW === 12, `${info.cap}x${info.capW}`);
  const track = page.locator('[data-qa-track="1"]');
  const thumb = track.locator(".cap-thumb");
  const frac = () => el.evaluate((n) => n.scrollTop / (n.scrollHeight - n.clientHeight));

  // Hit-test: topmost element at the capsule centre is the capsule.
  const tb0 = await thumb.boundingBox();
  const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.dataset?.testid, [tb0.x + tb0.width / 2, tb0.y + tb0.height / 2]);
  chk(`${label}: capsule is hit-testable (nothing on top)`, topmost === "capsule-thumb", topmost);
  chk(`${label}: cursor grab`, (await thumb.evaluate((n) => getComputedStyle(n).cursor)) === "grab");

  for (const f of [0.25, 0.5, 0.75, 1, 0]) {
    const t = await track.boundingBox();
    const c = await thumb.boundingBox();
    const x = c.x + c.width / 2;
    await page.mouse.move(x, c.y + c.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, t.y + c.height / 2 + f * (t.height - c.height), { steps: 8 });
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(80);
    const got = await frac();
    chk(`${label}: drag to ${f * 100}% → ≈${f * 100}% scrolled`, Math.abs(got - f) <= 0.03, got.toFixed(3));
  }
  {
    const t = await track.boundingBox();
    const c = await thumb.boundingBox();
    await page.mouse.click(t.x + t.width / 2, t.y + c.height / 2 + 0.75 * (t.height - c.height));
    await page.waitForTimeout(900);
    const got = await frac();
    chk(`${label}: track click at 75% → ≈75%`, Math.abs(got - 0.75) <= 0.04, got.toFixed(3));
  }
  {
    await resetTop(el);
    const b = await el.boundingBox();
    await page.mouse.move(b.x + b.width / 3, b.y + Math.min(b.height / 2, 200));
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(700);
    const t = await track.boundingBox();
    const c = await thumb.boundingBox();
    const lf = await frac();
    const cf = (c.y - t.y) / (t.height - c.height);
    chk(`${label}: wheel scrolls and capsule stays synced`, lf > 0.02 && Math.abs(lf - cf) <= 0.03, `list ${lf.toFixed(3)} capsule ${cf.toFixed(3)}`);
  }
}

for (const scheme of ["light", "dark"]) {
  scenario(
    `capscroll-main-${scheme}`,
    `Capsule scrollbar on the main page (${scheme})`,
    async ({ page }, chk) => {
      await h.addFixture(page, "shared-emi");
      await h.go(page, "/dashboard");
      await page.waitForTimeout(2500);
      await page.locator("main").evaluate((n) => n.setAttribute("data-qa-cap", ""));
      const before = await path(page);

      const layout = await page.locator("main").evaluate((n) => {
        const on = n.clientWidth;
        const color = getComputedStyle(n).scrollbarColor;
        delete document.documentElement.dataset.capsuleScroll;
        void n.offsetWidth;
        const off = n.clientWidth;
        document.documentElement.dataset.capsuleScroll = "true";
        return { on, off, color };
      });
      chk("layout unchanged (same content width as native scrollbar)", layout.on === layout.off, `${layout.on} vs ${layout.off}`);
      chk("native scrollbar painted transparent", /rgba\(0, 0, 0, 0\)|transparent/.test(layout.color), layout.color);

      await exercise(page, chk, "main");
      await h.shot(page, `capscroll-main-${scheme}`);

      // Drag then release over a link inside the page: no navigation.
      await resetTop(page.locator("main"));
      const b = await page.locator("main").boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + 200);
      await page.waitForTimeout(250);
      await findTrack(page);
      const c = await page.locator('[data-qa-track="1"] .cap-thumb').boundingBox();
      const link = await page.locator("main a[href]").first().boundingBox();
      await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
      await page.mouse.down();
      await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2 + 30, { steps: 4 });
      await page.mouse.move(link.x + link.width / 2, link.y + link.height / 2, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(500);
      chk("releasing over a link did not navigate", (await path(page)) === before, await path(page));

      // Sidebar keeps its own capsule — no second one over the drawer.
      const sb = await page.locator('[data-testid="app-sidebar-slot"] .nav-scroll').boundingBox();
      await page.mouse.move(sb.x + 80, sb.y + 120);
      await page.waitForTimeout(300);
      const overSidebar = await page.evaluate((right) => [...document.querySelectorAll('[data-testid="capsule-track"]')].filter((t) => !t.dataset.hidden && !t.dataset.leaving && t.getBoundingClientRect().left < right).length, sb.x + sb.width);
      chk("sidebar: no duplicate capsule over the drawer", overSidebar === 0, overSidebar);
      chk("sidebar: own capsule still present", await page.locator('[data-testid="app-sidebar-slot"] [data-testid="nav-scroll-thumb"]').isVisible());
    },
    { viewport: { width: 1536, height: 864 }, scheme },
  );
}

scenario(
  "capscroll-dialog",
  "Capsule scrollbar inside a scrollable dialog/sheet; pressing it never closes the dialog",
  async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await h.go(page, "/transactions");
    await page.waitForTimeout(2500);
    chk("old page scroll control hidden (capsule replaces it)", !(await page.getByLabel("Page scroll control").isVisible().catch(() => false)));
    await page.getByRole("button", { name: "Edit transaction" }).first().click();
    const dlg = page.getByRole("dialog").first();
    await dlg.waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const marked = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const all = [d, ...d.querySelectorAll("*")];
      const sc = all.find((n) => {
        const cs = getComputedStyle(n);
        return /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight - n.clientHeight > 40 && n.clientHeight > 120;
      });
      if (!sc) return null;
      sc.setAttribute("data-qa-cap", "");
      return `${sc.tagName}.${String(sc.className).slice(0, 60)} ${sc.clientHeight}/${sc.scrollHeight}`;
    });
    chk("dialog has a scrollable body at 1536x600", !!marked, marked);
    if (!marked) return;
    {
      const el = page.locator("[data-qa-cap]");
      const b = await el.boundingBox();
      for (const [nm, x] of [["third", b.x + b.width / 3]]) {
        await resetTop(el);
        await page.mouse.move(x, b.y + Math.min(b.height / 2, 200));
        await page.mouse.wheel(0, 150);
        await page.waitForTimeout(600);
        chk(`dialog: plain wheel at ${nm} scrolls the body`, (await el.evaluate((n) => n.scrollTop)) > 0, await el.evaluate((n) => n.scrollTop));
      }
      await resetTop(el);
    }
    await exercise(page, chk, "dialog");
    await h.shot(page, "capscroll-dialog");
    chk("dialog still open after capsule interaction", await dlg.isVisible());
  },
  { viewport: { width: 1536, height: 600 } },
);

scenario(
  "capscroll-dropdown",
  "Capsule scrollbar in a long dropdown; dragging never picks an option or closes it",
  async ({ page }, chk) => {
    await h.go(page, "/settings");
    await page.waitForTimeout(1500);
    await page.getByRole("tab", { name: "Profile" }).click().catch(() => {});
    const trigger = page.getByRole("combobox", { name: /Cycle starts on/ });
    await trigger.waitFor({ timeout: 15000 });
    const valueBefore = await trigger.innerText();
    await trigger.click();
    await page.getByRole("listbox").waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const marked = await page.evaluate(() => {
      const lb = document.querySelector('[role="listbox"]');
      const cands = [lb, ...lb.querySelectorAll("*"), lb.parentElement];
      const sc = cands.find((n) => n && n.scrollHeight - n.clientHeight > 20 && /(auto|scroll)/.test(getComputedStyle(n).overflowY));
      if (!sc) return null;
      sc.setAttribute("data-qa-cap", "");
      return `${sc.tagName} ${sc.clientHeight}/${sc.scrollHeight}`;
    });
    chk("dropdown list scrolls", !!marked, marked);
    if (!marked) return;
    await exercise(page, chk, "dropdown");
    await h.shot(page, "capscroll-dropdown");
    chk("dropdown still open after capsule interaction", await page.getByRole("listbox").isVisible());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    chk("no option was picked by dragging", (await trigger.innerText()) === valueBefore, `${valueBefore} -> ${await trigger.innerText()}`);
  },
  { viewport: { width: 1366, height: 640 } },
);
