/**
 * Drawer capsule scrollbar (navthumb-*). Real mouse input only — synthetic emulator data.
 *   npm run test:e2e-qa -- navthumb- --copy
 *
 * Desktop rail at 1536x864 (125% Windows scaling) so the list overflows. Checks: capsule visible + wide enough,
 * lives in its own gutter (no nav row under it), drag moves the list 1:1 with the pointer and stays put after
 * release, releasing over a nav row never navigates, track press glides + hold-to-drag, wheel still scrolls.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const SLOT = '[data-testid="app-sidebar-slot"]';

for (const scheme of ["light", "dark"]) {
  scenario(
    `navthumb-${scheme}`,
    `Drawer capsule scrollbar: drag, track press, wheel, no accidental navigation (${scheme})`,
    async ({ page }, chk, notes) => {
      await h.go(page, "/dashboard");
      await page.waitForTimeout(1500);
      const track = page.locator(`${SLOT} [data-testid="nav-scroll-track"]`).first();
      const thumb = page.locator(`${SLOT} [data-testid="nav-scroll-thumb"]`).first();
      const scroller = page.locator(`${SLOT} .nav-scroll`).first();
      const top = () => scroller.evaluate((el) => el.scrollTop);
      const max = () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
      const path = () => page.evaluate(() => location.pathname.replace(/\/+$/, ""));

      chk("list overflows at 1536x864", (await max()) > 40, await max());
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(200);

      const tb = await track.boundingBox();
      const cb = await thumb.boundingBox();
      chk("track grab zone ≥ 18px wide", tb.width >= 18, tb.width);
      chk("capsule is short: 44–64px tall", cb.height >= 44 && cb.height <= 64, cb.height);
      chk("capsule is 12–16px wide at rest", cb.width >= 12 && cb.width <= 16, cb.width);
      const restOpacity = await track.evaluate((el) => Number(getComputedStyle(el).opacity));
      chk("capsule fully visible at rest", restOpacity === 1, restOpacity);
      chk("cursor: grab on the capsule", (await thumb.evaluate((el) => getComputedStyle(el).cursor)) === "grab");

      // Hit-testing: the topmost element under the capsule centre is the capsule itself (no overlay blocks it),
      // at the top, middle and bottom of the list.
      const hitAt = async (label, setTop) => {
        await scroller.evaluate((el, f) => (el.scrollTop = f * (el.scrollHeight - el.clientHeight)), setTop);
        await page.waitForTimeout(150);
        const b = await thumb.boundingBox();
        const hit = await page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el?.dataset?.testid ?? el?.className ?? String(el);
        }, [b.x + b.width / 2, b.y + b.height / 2]);
        chk(`capsule is hit-testable at ${label}`, hit === "nav-scroll-thumb", hit);
        // and draggable from there
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.mouse.down();
        const from = await top();
        const dir = setTop > 0.5 ? -1 : 1;
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + dir * 40, { steps: 5 });
        await page.waitForTimeout(40);
        const to = await top();
        await page.mouse.up();
        chk(`capsule drags from ${label}`, Math.sign(to - from) === dir && Math.abs(to - from) > 20, `${from} -> ${to}`);
      };
      await hitAt("top", 0);
      await hitAt("middle", 0.5);
      await hitAt("bottom", 1);
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.mouse.move(10, 500);
      await page.waitForTimeout(300);

      // Gutter: nothing clickable from the nav sits under any point of the track.
      const overlap = await page.evaluate((sel) => {
        const t = document.querySelector(`${sel} [data-testid="nav-scroll-track"]`).getBoundingClientRect();
        return [...document.querySelectorAll(`${sel} .nav-scroll a, ${sel} .nav-scroll button`)].filter((a) => {
          const r = a.getBoundingClientRect();
          return r.width > 0 && r.right > t.left && r.left < t.right && r.bottom > t.top && r.top < t.bottom;
        }).length;
      }, SLOT);
      chk("no nav row or star button under the track", overlap === 0, overlap);

      // Short-range track: ~6 cm (226.8 CSS px), centred on the list's right edge.
      const tk = await track.boundingBox();
      const lst = await scroller.boundingBox();
      chk("track is ~6 cm tall (≈227px)", Math.abs(tk.height - 228) <= 2, tk.height);
      chk("track centred vertically on the list", Math.abs(tk.y + tk.height / 2 - (lst.y + lst.height / 2)) <= 4, `${tk.y + tk.height / 2} vs ${lst.y + lst.height / 2}`);
      chk("track much shorter than the list", tk.height < lst.height * 0.6, `${tk.height} / ${lst.height}`);
      const frac = async () => scroller.evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight));
      const capFrac = async () => {
        const t = await track.boundingBox();
        const c = await thumb.boundingBox();
        return (c.y - t.y) / (t.height - c.height);
      };

      // Drag mapping: capsule at 0/25/50/75/100% of its travel → list at the same fraction.
      for (const f of [0.25, 0.5, 0.75, 1, 0]) {
        const t = await track.boundingBox();
        const c = await thumb.boundingBox();
        const travel = t.height - c.height;
        const x = c.x + c.width / 2;
        const y0 = c.y + c.height / 2;
        const targetY = t.y + c.height / 2 + f * travel;
        await page.mouse.move(x, y0);
        await page.mouse.down();
        await page.mouse.move(x, targetY, { steps: 8 });
        await page.waitForTimeout(40);
        await page.mouse.up();
        await page.waitForTimeout(80);
        const got = await frac();
        chk(`drag capsule to ${f * 100}% → list ≈${f * 100}% scrolled`, Math.abs(got - f) <= 0.02, got.toFixed(3));
      }
      const fullTravel = (await track.boundingBox()).height - (await thumb.boundingBox()).height;
      chk("whole list covered by ≤ ~180px of mouse travel", fullTravel <= 185, fullTravel);

      // Track click at a fraction → list glides to that fraction (capsule centred on the click).
      for (const f of [0.25, 0.75]) {
        const t = await track.boundingBox();
        const c = await thumb.boundingBox();
        const y = t.y + c.height / 2 + f * (t.height - c.height);
        await page.mouse.click(t.x + t.width / 2, y);
        await page.waitForTimeout(700);
        const got = await frac();
        chk(`track click at ${f * 100}% → list ≈${f * 100}%`, Math.abs(got - f) <= 0.03, got.toFixed(3));
      }
      // Wheel keeps the capsule in sync.
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(150);
      const lb0 = await scroller.boundingBox();
      await page.mouse.move(lb0.x + 60, lb0.y + lb0.height / 2);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(700);
      const wf = await frac();
      const cf = await capFrac();
      chk("wheel scroll keeps capsule synced (capsule% = list%)", wf > 0.1 && Math.abs(wf - cf) <= 0.02, `list ${wf.toFixed(3)} capsule ${cf.toFixed(3)}`);
      await h.shot(page, `navthumb-${scheme}-mid`);
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.mouse.move(10, 500);
      await page.waitForTimeout(300);

      // Grip lines sit exactly in the capsule's centre (horizontally and vertically).
      const grip = await thumb.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el, "::before");
        const bw = parseFloat(getComputedStyle(el).borderTopWidth);
        const inner = { w: r.width - 2 * bw, h: r.height - 2 * bw };
        const left = parseFloat(cs.left), top = parseFloat(cs.top), w = parseFloat(cs.width), h = parseFloat(cs.height);
        return { dx: left + w / 2 - inner.w / 2, dy: top + h / 2 - inner.h / 2, whole: Number.isInteger(left) && Number.isInteger(top) };
      });
      chk("grip lines centred in the capsule", Math.abs(grip.dx) < 0.01 && Math.abs(grip.dy) < 0.01 && grip.whole, JSON.stringify(grip));
      await h.shot(page, `navthumb-${scheme}-grip`);

      // Hover feedback
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await page.waitForTimeout(250);
      const hoverW = (await thumb.boundingBox()).width;
      chk("capsule widens on hover", hoverW > cb.width, `${cb.width} -> ${hoverW}`);
      await h.shot(page, `navthumb-${scheme}-hover`);

      // Drag down with real mouse, grabbing at the gutter edge (not the capsule's centre) — whole width is the grab zone.
      const before = await path();
      const gx = tb.x + 1.5;
      const gy = cb.y + cb.height / 2;
      await page.mouse.move(gx, gy);
      await page.mouse.down();
      const dragging = await track.evaluate((el) => el.dataset.drag === "true");
      const dragCursor = await page.evaluate(() => getComputedStyle(document.querySelector(".nav-scroll a")).cursor);
      chk("cursor: grabbing while dragging", dragCursor === "grabbing", dragCursor);
      for (let i = 1; i <= 10; i++) await page.mouse.move(gx, gy + i * 6);
      await page.waitForTimeout(50);
      const midTop = await top();
      const capY = (await thumb.boundingBox()).y;
      await h.shot(page, `navthumb-${scheme}-drag`);
      // Release far to the left, over the nav rows.
      await page.mouse.move(tb.x - 120, gy + 80, { steps: 4 });
      const preRelease = await top();
      await page.mouse.up();
      await page.waitForTimeout(500);
      chk("press on gutter edge starts a drag", dragging);
      const expected = (60 * (await max())) / (tb.height - cb.height);
      chk("60px drag scrolls the list proportionally (±6%)", Math.abs(midTop - expected) <= expected * 0.06 + 2, `${midTop} vs ${expected.toFixed(1)}`);
      chk("capsule follows the pointer (~60px)", Math.abs(capY - cb.y - 60) <= 3, capY - cb.y);
      chk("releasing over a nav row did not navigate", (await path()) === before, await path());
      chk("position stays where released", Math.abs((await top()) - preRelease) <= 1, `${preRelease} -> ${await top()}`);
      chk("drag state cleared after release", await page.evaluate(() => !document.documentElement.dataset.navThumbDrag));

      // Drag past the end clamps to the bottom; back to top clamps to 0.
      const c2 = await thumb.boundingBox();
      await page.mouse.move(c2.x + c2.width / 2, c2.y + 10);
      await page.mouse.down();
      await page.mouse.move(c2.x + c2.width / 2, c2.y + 2000, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      chk("drag to bottom reaches the last item", Math.abs((await top()) - (await max())) <= 1, `${await top()} / ${await max()}`);
      const lastVisible = await page.evaluate((sel) => {
        const sc = document.querySelector(`${sel} .nav-scroll`);
        const links = [...sc.querySelectorAll("a[href]")];
        const r = links[links.length - 1].getBoundingClientRect();
        return r.bottom <= sc.getBoundingClientRect().bottom + 1;
      }, SLOT);
      chk("last nav item fully reachable", lastVisible);
      const c3 = await thumb.boundingBox();
      await page.mouse.move(c3.x + c3.width / 2, c3.y + 10);
      await page.mouse.down();
      await page.mouse.move(c3.x + c3.width / 2, c3.y - 2000, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      chk("drag to top returns to 0", (await top()) <= 1, await top());

      // Track press below the capsule glides there; hold + move continues as a drag.
      const t2 = await track.boundingBox();
      await page.mouse.move(t2.x + t2.width / 2, t2.y + t2.height * 0.75);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(700);
      const afterClick = await top();
      chk("track click glides toward that spot", afterClick > (await max()) * 0.4, `${afterClick} / ${await max()}`);
      chk("track click did not navigate", (await path()) === before);
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(200);
      await page.mouse.move(t2.x + t2.width / 2, t2.y + t2.height * 0.6);
      await page.mouse.down();
      await page.waitForTimeout(400);
      const held = await top();
      await page.mouse.move(t2.x + t2.width / 2, t2.y + t2.height * 0.6 + 30, { steps: 5 });
      await page.waitForTimeout(50);
      const heldMoved = await top();
      await page.mouse.up();
      chk("press-and-hold on track then move keeps dragging", heldMoved > held + 5, `${held} -> ${heldMoved}`);

      // Wheel over the list still scrolls and never changes page.
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(200);
      const lb = await scroller.boundingBox();
      await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(600);
      chk("mouse wheel scrolls the list", (await top()) > 50, await top());
      chk("wheel did not navigate", (await path()) === before);
      const pageTop = await page.evaluate(() => (document.scrollingElement?.scrollTop ?? 0));
      chk("wheel did not scroll the page", pageTop === 0, pageTop);

      // Collapsed rail: scrollbar still present, draggable and clear of the icons.
      await page.getByRole("button", { name: /collapse/i }).first().click();
      await page.waitForTimeout(800);
      await h.shot(page, `navthumb-${scheme}-collapsed`);
      const cmax = await max();
      if (cmax > 20) {
        const cb4 = await thumb.boundingBox();
        await scroller.evaluate((el) => (el.scrollTop = 0));
        await page.mouse.move(cb4.x + cb4.width / 2, cb4.y + cb4.height / 2);
        await page.mouse.down();
        await page.mouse.move(cb4.x + cb4.width / 2, cb4.y + cb4.height / 2 + 60, { steps: 5 });
        await page.mouse.up();
        chk("collapsed: capsule still drags the list", (await top()) > 20, await top());
      } else chk("collapsed: list fits, scrollbar hidden", await track.evaluate((el) => el.dataset.hidden === "true"));
      const cOverlap = await page.evaluate((sel) => {
        const t = document.querySelector(`${sel} [data-testid="nav-scroll-track"]`).getBoundingClientRect();
        return [...document.querySelectorAll(`${sel} .nav-scroll a, ${sel} .nav-scroll button`)].filter((a) => {
          const r = a.getBoundingClientRect();
          return r.width > 0 && r.right > t.left && r.left < t.right && r.bottom > t.top && r.top < t.bottom;
        }).length;
      }, SLOT);
      chk("collapsed: no icon under the track", cOverlap === 0, cOverlap);
      // The expand button sits at the very bottom of the rail where the Next dev-tools badge can cover it in dev
      // (pre-existing, unrelated to the scrollbar) — activate it directly.
      const expand = await page.evaluate(() => {
        const b = document.querySelector('button[aria-label="Expand sidebar"]');
        if (!b) return "missing";
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        b.click();
        return `bottom=${Math.round(r.bottom)} vh=${innerHeight} topmost=${top === b || b.contains(top) ? "button" : top?.tagName}`;
      });
      notes.push(`expand button: ${expand}`);
      await page.waitForTimeout(800);
      const eb = await thumb.boundingBox();
      chk("expanded again: capsule back to compact size", eb && eb.height >= 44 && eb.height <= 64, eb?.height);

      // A normal click on a row still navigates (we didn't break the nav).
      const link = page.locator(`${SLOT} .nav-scroll a[href*="/accounts"]`).first();
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await page.waitForFunction(() => location.pathname.startsWith("/accounts"), null, { timeout: 15000 }).catch(() => {});
      chk("ordinary row click still navigates", (await path()).startsWith("/accounts"), await path());
    },
    { viewport: { width: 1536, height: 864 }, scheme },
  );
}
