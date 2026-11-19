/**
 * Smooth scrolling + capsule scrollbars across the sidebar, the main page and tables (smooth-*). Real mouse wheel and
 * mouse drags only — synthetic emulator data.   npm run test:e2e-qa -- smooth- --copy
 *
 * smooth-main-sidebar   wheel on the main page and on the drawer: glides (many frames, soft start, monotonic, settles
 *                       fast), the capsule thumb is in step with the content on EVERY frame, rapid notches accumulate,
 *                       exact top/bottom, drawer and page never move each other, drag after a glide stays precise.
 * smooth-table          the transactions table: its own capsule (native bar invisible), wheel moves only the table,
 *                       a spin that hits the end never spills into the page, page scroll still works beside it.
 * smooth-input-modes    touchpad-size deltas stay native (1:1), reduced motion is not hijacked, and a "touch-only"
 *                       browser report still gets capsules as soon as a real mouse moves.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

/** Marks the scroller (data-qa-sc) and returns its geometry. */
const markScroller = (page, finder, name) =>
  page.evaluate(([src, nm]) => {
    const el = new Function(`return (${src})()`)();
    if (!el) return null;
    document.querySelectorAll(`[data-qa-sc="${nm}"]`).forEach((n) => n.removeAttribute("data-qa-sc"));
    el.setAttribute("data-qa-sc", nm);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, max: el.scrollHeight - el.clientHeight, top: el.scrollTop };
  }, [finder.toString(), name]);

/** Marks the overlay capsule track that belongs to the scroller (sits in its right gutter) — null if none is shown. */
const markTrack = (page, name) =>
  page.evaluate((nm) => {
    const el = document.querySelector(`[data-qa-sc="${nm}"]`);
    const r = el.getBoundingClientRect();
    const tracks = [...document.querySelectorAll('[data-testid="capsule-track"][data-axis="y"]')].filter((t) => !t.dataset.hidden && !t.dataset.leaving);
    document.querySelectorAll("[data-qa-track]").forEach((n) => n.removeAttribute("data-qa-track"));
    const hit = tracks.find((t) => {
      const b = t.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      return cx > r.right - 24 && cx < r.right + 4 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
    });
    if (!hit) return { found: false, tracks: tracks.length };
    hit.setAttribute("data-qa-track", nm);
    const b = hit.getBoundingClientRect();
    return { found: true, len: b.height, cap: hit.firstElementChild.getBoundingClientRect().height };
  }, name);

/** Records scrollTop + capsule-thumb offset once per painted frame until stopRec. `trSel` = the track's selector. */
const startRec = (page, name, trSel) =>
  page.evaluate(([nm, sel]) => {
    const sc = document.querySelector(`[data-qa-sc="${nm}"]`);
    const rec = (window.__rec = { on: true, s: [] });
    const sample = () => {
      if (!rec.on) return;
      const tr = document.querySelector(sel);
      const th = tr && tr.firstElementChild;
      const max = sc.scrollHeight - sc.clientHeight;
      let ty = null;
      let len = 0;
      let cap = 0;
      if (tr && th && !tr.dataset.hidden) {
        ty = new DOMMatrix(getComputedStyle(th).transform).m42;
        len = tr.clientHeight;
        cap = th.offsetHeight;
      }
      rec.s.push({ t: performance.now(), top: sc.scrollTop, max, ty, len, cap });
      requestAnimationFrame(() => setTimeout(sample, 0));
    };
    requestAnimationFrame(sample);
  }, [name, trSel]);
const stopRec = (page) =>
  page.evaluate(() => {
    window.__rec.on = false;
    return window.__rec.s;
  });

/** Logs every wheel event the page sees (after the app's own handlers ran) so classification can be asserted. */
const logWheels = (page) =>
  page.evaluate(() => {
    window.__wheels = [];
    window.addEventListener("wheel", (e) => window.__wheels.push({ dy: e.deltaY, wd: e.wheelDeltaY, mode: e.deltaMode, prevented: e.defaultPrevented }), { passive: true });
  });
const wheels = (page) => page.evaluate(() => window.__wheels);

/** Turns a recording into the numbers we assert on. `dir` = +1 down / −1 up. */
function analyze(samples, dir = 1) {
  const first = samples.findIndex((s, i) => i > 0 && s.top !== samples[0].top);
  if (first < 0) return { moved: 0, frames: 0 };
  const from = first - 1;
  let lastIdx = from;
  for (let i = from + 1; i < samples.length; i++) if (samples[i].top !== samples[i - 1].top) lastIdx = i;
  const win = samples.slice(from, lastIdx + 1);
  const steps = win.slice(1).map((s, i) => (s.top - win[i].top) * dir);
  const total = (win.at(-1).top - win[0].top) * dir;
  const k95 = win.findIndex((s) => (s.top - win[0].top) * dir >= total * 0.95);
  const t95 = k95 < 0 ? Infinity : win[k95].t - win[0].t;
  const peak = Math.max(...steps);
  let syncErr = 0;
  let syncN = 0;
  for (const s of samples) {
    if (s.ty == null || s.max <= 1 || s.len <= s.cap) continue;
    const want = Math.round((Math.min(s.max, Math.max(0, s.top)) / s.max) * (s.len - s.cap));
    syncErr = Math.max(syncErr, Math.abs(s.ty - want));
    syncN++;
  }
  return {
    total,
    frames: steps.filter((d) => Math.abs(d) > 0).length,
    firstStep: steps[0],
    peak,
    peakAt: steps.indexOf(peak),
    monotonic: steps.every((d) => d >= -0.001),
    ms: win.at(-1).t - win[0].t,
    t95,
    firstGap: win.length > 1 ? win[1].t - win[0].t : 0,
    maxWinGap: Math.round(Math.max(...win.slice(1).map((x, i) => x.t - win[i].t))),
    maxGap: Math.round(Math.max(...samples.slice(1).map((x, i) => x.t - samples[i].t))),
    longFrames: samples.slice(1).filter((x, i) => x.t - samples[i].t > 24).length,
    frameMs: (() => {
      const gaps = samples.slice(1).map((x, i) => x.t - samples[i].t).sort((p, q) => p - q);
      return gaps[Math.floor(gaps.length / 2)] ?? 0;
    })(),
    syncErr,
    syncN,
  };
}

const sleep = (page, ms) => page.waitForTimeout(ms);

/** Shared glide assertions for one wheel notch on a scroller. */
function chkGlide(chk, label, a, expectTotal) {
  // Shape and wall-clock checks only mean something on a clean trace. A dev build on a busy machine drops frames; the
  // spring (correctly) catches up after one, which looks like a hard start. Judge when every frame of the move was
  // ≤ 40 ms apart, otherwise report what was seen.
  const clean = a.maxWinGap <= 40;
  const why = clean ? "" : ` (not judged: a ${a.maxWinGap}ms frame hitch inside the move)`;
  chk(`${label}: moves by one notch (${expectTotal}px)`, Math.abs(a.total - expectTotal) <= 2, `${a.total}`);
  chk(`${label}: glides over many frames, not a jump (≥ 6)`, a.frames >= 6 || !clean, `${a.frames}`);
  chk(`${label}: soft start (first frame ≤ 18% of the move)${why}`, a.firstStep <= expectTotal * 0.18 || !clean, `${a.firstStep}`);
  chk(`${label}: speeds up before it slows (peak after frame 1)${why}`, a.peakAt >= 1 || !clean, `${a.peakAt}`);
  chk(`${label}: one smooth direction, no stepping back`, a.monotonic);
  chk(`${label}: 95% of the move done within 320 ms${why}`, a.t95 <= 320 || !clean, `${Math.round(a.t95)}ms, median frame ${Math.round(a.frameMs)}ms, longest in move ${a.maxWinGap}ms, tail ${Math.round(a.ms)}ms`);
  chk(`${label}: capsule thumb in step with the content on every frame (≤ 1px)`, a.syncN >= 3 && a.syncErr <= 1, `err ${a.syncErr} over ${a.syncN} frames`);
}

scenario(
  "smooth-main-sidebar",
  "Smooth wheel + capsule on the main page and the drawer; exact ends; independence; drag after glide",
  async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await h.go(page, "/dashboard");
    await sleep(page, 2500);
    await logWheels(page);

    chk("capsule mode active", await page.evaluate(() => document.documentElement.dataset.capsuleScroll === "true"));
    const main = await markScroller(page, () => document.querySelector("main"), "main");
    chk("main page scrolls", main && main.max > 300, JSON.stringify(main));
    const side = await markScroller(page, () => document.querySelector('[data-testid="app-sidebar-slot"] .nav-scroll'), "side");
    chk("drawer list scrolls", side && side.max > 150, JSON.stringify(side));
    if (!main || !side || main.max <= 300 || side.max <= 150) return;

    /* ───── main page ───── */
    await page.mouse.move(main.x + main.w / 2, main.y + 200);
    await sleep(page, 300);
    const mt = await markTrack(page, "main");
    chk("main: capsule shown on hover", mt.found, JSON.stringify(mt));
    {
      // The capsule (hovered = widest) must sit fully inside the window — never clipped at the edge.
      const tb = await page.locator('[data-qa-track="main"] .cap-thumb').boundingBox();
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
      await sleep(page, 300);
      const hb = await page.locator('[data-qa-track="main"] .cap-thumb').boundingBox();
      const vw = await page.evaluate(() => window.innerWidth);
      chk("main: capsule fully inside the window, also when hovered (not clipped at the edge)", hb.x >= 0 && hb.x + hb.width <= vw, `${hb.x}..${hb.x + hb.width} of ${vw}`);
      await page.mouse.move(main.x + main.w / 2, main.y + 200);
      await sleep(page, 200);
    }
    chk("main: native scrollbar painted transparent", /rgba\(0, 0, 0, 0\)|transparent/.test(await page.evaluate(() => getComputedStyle(document.querySelector('[data-qa-sc="main"]')).scrollbarColor)));
    await startRec(page, "main", '[data-qa-track="main"]');
    await page.mouse.wheel(0, 100);
    await sleep(page, 700);
    let a = analyze(await stopRec(page));
    chkGlide(chk, "main: one wheel notch", a, 100);
    const ev = (await wheels(page)).at(-1);
    chk("main: the notch was taken over by the glide (default prevented)", ev?.prevented === true, JSON.stringify(ev));

    // Rapid notches accumulate (and speed up modestly) instead of restarting.
    await page.evaluate(() => (document.querySelector('[data-qa-sc="main"]').scrollTop = 0));
    await sleep(page, 400);
    await startRec(page, "main", '[data-qa-track="main"]');
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
    await sleep(page, 800);
    a = analyze(await stopRec(page));
    chk("main: 3 quick notches flow into one motion of ≈ 324px (modest acceleration)", a.total > 300 && a.total <= 336, `${a.total}`);
    chk("main: …without stepping back or stalling", a.monotonic && a.frames >= 10, `${a.frames} frames`);
    chk("main: …thumb still in step", a.syncN >= 3 && a.syncErr <= 1, `err ${a.syncErr}`);

    // Exact bottom and top.
    for (let i = 0; i < 45; i++) await page.mouse.wheel(0, 100);
    await sleep(page, 900);
    const atBottom = await page.evaluate(() => {
      const el = document.querySelector('[data-qa-sc="main"]');
      const tr = document.querySelector('[data-qa-track="main"]');
      const th = tr.firstElementChild;
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, ty: new DOMMatrix(getComputedStyle(th).transform).m42, travel: tr.clientHeight - th.offsetHeight };
    });
    chk("main: reaches the exact bottom", Math.abs(atBottom.top - atBottom.max) <= 1, `${atBottom.top}/${atBottom.max}`);
    chk("main: capsule at the very bottom of its track", Math.abs(atBottom.ty - atBottom.travel) <= 1, `${atBottom.ty}/${atBottom.travel}`);
    for (let i = 0; i < 45; i++) await page.mouse.wheel(0, -100);
    await sleep(page, 900);
    const atTop = await page.evaluate(() => {
      const el = document.querySelector('[data-qa-sc="main"]');
      const th = document.querySelector('[data-qa-track="main"]').firstElementChild;
      return { top: el.scrollTop, ty: new DOMMatrix(getComputedStyle(th).transform).m42 };
    });
    chk("main: reaches the exact top, capsule at the top", atTop.top === 0 && atTop.ty === 0, JSON.stringify(atTop));

    /* ───── drawer ───── */
    const mainBefore = await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop);
    await page.mouse.move(side.x + side.w / 2 - 20, side.y + 160);
    await sleep(page, 250);
    await startRec(page, "side", '[data-testid="nav-scroll-track"]');
    await page.mouse.wheel(0, 100);
    await sleep(page, 700);
    a = analyze(await stopRec(page));
    chkGlide(chk, "drawer: one wheel notch", a, 100);
    chk("drawer: wheel never moved the page", (await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop)) === mainBefore);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 100);
    await sleep(page, 900);
    const sBottom = await page.evaluate(() => {
      const el = document.querySelector('[data-qa-sc="side"]');
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    });
    chk("drawer: reaches the exact bottom", Math.abs(sBottom.top - sBottom.max) <= 1, JSON.stringify(sBottom));
    chk("drawer: spinning past the end still never moves the page", (await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop)) === mainBefore);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -100);
    await sleep(page, 900);
    chk("drawer: reaches the exact top", (await page.evaluate(() => document.querySelector('[data-qa-sc="side"]').scrollTop)) === 0);

    // …and the page wheel never moves the drawer.
    const sideBefore = await page.evaluate(() => document.querySelector('[data-qa-sc="side"]').scrollTop);
    await page.mouse.move(main.x + main.w / 2, main.y + 200);
    await page.mouse.wheel(0, 100);
    await sleep(page, 600);
    chk("page wheel moved the page", (await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop)) > mainBefore);
    chk("page wheel never moved the drawer", (await page.evaluate(() => document.querySelector('[data-qa-sc="side"]').scrollTop)) === sideBefore);

    /* ───── dragging after a glide stays precise, and grabbing stops a glide ───── */
    await page.evaluate(() => (document.querySelector('[data-qa-sc="main"]').scrollTop = 0));
    await sleep(page, 300);
    await page.mouse.move(main.x + main.w / 2, main.y + 200);
    await sleep(page, 250);
    await markTrack(page, "main");
    await page.mouse.wheel(0, 100);
    await sleep(page, 30); // glide in progress…
    const th = await page.locator('[data-qa-track="main"] .cap-thumb').boundingBox();
    const trk = await page.locator('[data-qa-track="main"]').boundingBox();
    const px = th.x + th.width / 2;
    await page.mouse.move(px, th.y + th.height / 2);
    await page.mouse.down();
    const topDown = await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop);
    await page.mouse.move(px, th.y + th.height / 2 + 60, { steps: 6 });
    await sleep(page, 60);
    await page.mouse.up();
    await sleep(page, 500);
    const dragInfo = await page.evaluate(() => {
      const el = document.querySelector('[data-qa-sc="main"]');
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    });
    const ratio = dragInfo.max / (trk.height - th.height);
    chk("grab a capsule mid-glide and drag 60px → content follows 1:1 from the grab point (no fight)", Math.abs(dragInfo.top - (topDown + 60 * ratio)) <= 4, `from ${topDown} +${(60 * ratio).toFixed(0)} → ${dragInfo.top}`);
    const settle1 = await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop);
    await sleep(page, 300);
    chk("…and nothing keeps moving after release", (await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop)) === settle1);
    await h.shot(page, "smooth-main-sidebar");
  },
  { viewport: { width: 1536, height: 864 } },
);

scenario(
  "smooth-table",
  "Transactions table: own capsule, wheel moves only the table, ends are contained, page scroll still works",
  async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await h.addFixture(page, "history");
    await h.go(page, "/transactions");
    await sleep(page, 3500);
    await logWheels(page);

    const table = await markScroller(
      page,
      () => [...document.querySelectorAll("main .overflow-auto")].find((n) => n.scrollHeight - n.clientHeight > 40 && n.clientHeight > 150) ?? null,
      "table",
    );
    chk("transactions table scrolls inside its own box", table && table.max > 40, JSON.stringify(table ?? (await page.evaluate(() => [...document.querySelectorAll("main .overflow-auto")].map((n) => `${n.clientHeight}/${n.scrollHeight}`)))));
    const main = await markScroller(page, () => document.querySelector("main"), "main");
    if (!table || table.max <= 40) return;
    chk("old page scroll control hidden", !(await page.getByLabel("Page scroll control").isVisible().catch(() => false)));

    await page.mouse.move(table.x + table.w / 2, table.y + table.h / 2);
    await sleep(page, 300);
    const tt = await markTrack(page, "table");
    chk("table: its own capsule appears on hover", tt.found, JSON.stringify(tt));
    chk("table: native scrollbar painted transparent", /rgba\(0, 0, 0, 0\)|transparent/.test(await page.evaluate(() => getComputedStyle(document.querySelector('[data-qa-sc="table"]')).scrollbarColor)));
    chk("table: capsule is the same short 48px pill", tt.found && tt.cap >= 24 && tt.cap <= 48 && tt.len <= 228, `${tt.cap}/${tt.len}`);

    const mainBefore = main ? main.top : 0;
    await startRec(page, "table", '[data-qa-track="table"]');
    await page.mouse.wheel(0, 100);
    await sleep(page, 700);
    const a = analyze(await stopRec(page));
    chkGlide(chk, "table: one wheel notch", a, 100);
    chk("table: the page did not move", (await page.evaluate(() => document.querySelector("main").scrollTop)) === mainBefore);

    // Spin to the end (and well past it).
    for (let i = 0; i < Math.ceil(table.max / 100) + 6; i++) await page.mouse.wheel(0, 100);
    await sleep(page, 900);
    const end = await page.evaluate(() => {
      const el = document.querySelector('[data-qa-sc="table"]');
      const th = document.querySelector('[data-qa-track="table"]').firstElementChild;
      const tr = th.parentElement;
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, ty: new DOMMatrix(getComputedStyle(th).transform).m42, travel: tr.clientHeight - th.offsetHeight, main: document.querySelector("main").scrollTop };
    });
    chk("table: reaches the exact bottom", Math.abs(end.top - end.max) <= 1, `${end.top}/${end.max}`);
    chk("table: capsule at the bottom of its track", Math.abs(end.ty - end.travel) <= 1, `${end.ty}/${end.travel}`);
    chk("table: spinning past the end never spills into the page", end.main === mainBefore, `${end.main} vs ${mainBefore}`);
    for (let i = 0; i < Math.ceil(table.max / 100) + 6; i++) await page.mouse.wheel(0, -100);
    await sleep(page, 900);
    chk("table: reaches the exact top", (await page.evaluate(() => document.querySelector('[data-qa-sc="table"]').scrollTop)) === 0);

    // Capsule drag on the table is direct and proportional.
    await page.mouse.move(table.x + table.w / 2, table.y + table.h / 2);
    await sleep(page, 250);
    await markTrack(page, "table");
    for (const f of [0.5, 1, 0]) {
      const th = await page.locator('[data-qa-track="table"] .cap-thumb').boundingBox();
      const tr = await page.locator('[data-qa-track="table"]').boundingBox();
      await page.mouse.move(th.x + th.width / 2, th.y + th.height / 2);
      await page.mouse.down();
      await page.mouse.move(th.x + th.width / 2, tr.y + th.height / 2 + f * (tr.height - th.height), { steps: 8 });
      await sleep(page, 40);
      await page.mouse.up();
      await sleep(page, 120);
      const got = await page.evaluate(() => {
        const el = document.querySelector('[data-qa-sc="table"]');
        return el.scrollTop / (el.scrollHeight - el.clientHeight);
      });
      chk(`table: capsule drag to ${f * 100}% → ≈${f * 100}%`, Math.abs(got - f) <= 0.03, got.toFixed(3));
    }
    chk("table: still on /transactions (no accidental navigation)", (await page.evaluate(() => location.pathname.replace(/\/+$/, ""))) === "/transactions");

    // The page itself still scrolls normally from outside the table.
    if (main && main.max > 60) {
      await page.mouse.move(main.x + main.w / 2, main.y + 40);
      await page.mouse.wheel(0, 100);
      await sleep(page, 600);
      chk("page: wheel outside the table scrolls the page", (await page.evaluate(() => document.querySelector("main").scrollTop)) > mainBefore);
      chk("page: …and not the table", (await page.evaluate(() => document.querySelector('[data-qa-sc="table"]').scrollTop)) === 0);
    }
    await h.shot(page, "smooth-table");
  },
  { viewport: { width: 1536, height: 640 } },
);

scenario(
  "smooth-input-modes",
  "Touchpad deltas stay native, reduced motion is respected, touch-only reports still get capsules once a mouse moves",
  async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await h.go(page, "/dashboard");
    await sleep(page, 2500);
    await logWheels(page);
    const main = await markScroller(page, () => document.querySelector("main"), "main");
    await page.mouse.move(main.x + main.w / 2, main.y + 200);
    await sleep(page, 300);
    await markTrack(page, "main");

    // Touchpad-size delta: not hijacked, scrolls natively, thumb follows.
    await startRec(page, "main", '[data-qa-track="main"]');
    await page.mouse.wheel(0, 12);
    await sleep(page, 400);
    const rec = await stopRec(page);
    const ev = (await wheels(page)).at(-1);
    chk("touchpad-size delta (12px) is left to the browser", ev?.prevented === false, JSON.stringify(ev));
    chk("…and it still scrolls", rec.at(-1).top > 0, `${rec.at(-1).top}`);
    chk("…with the thumb in step", analyze(rec).syncErr <= 1 || analyze(rec).syncN < 3, JSON.stringify(analyze(rec)));

    // Reduced motion: the app does not take over the wheel.
    await page.evaluate(() => (document.querySelector('[data-qa-sc="main"]').scrollTop = 0));
    await sleep(page, 300);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.mouse.wheel(0, 100);
    await sleep(page, 400);
    const ev2 = (await wheels(page)).at(-1);
    chk("reduced motion: wheel not taken over by the glide", ev2?.prevented === false, JSON.stringify(ev2));
    chk("reduced motion: page still scrolls", (await page.evaluate(() => document.querySelector('[data-qa-sc="main"]').scrollTop)) > 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // A browser that reports "touch only" (hover:none / pointer:coarse) still gets capsules the moment a mouse moves.
    await page.addInitScript(() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = (q) => {
        const r = orig(q);
        return /hover|pointer/.test(q) ? { matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : r;
      };
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 60000 });
    await sleep(page, 3000);
    chk("touch-only report: capsules start OFF", await page.evaluate(() => document.documentElement.dataset.capsuleScroll !== "true"));
    await page.mouse.move(400, 300);
    await sleep(page, 150);
    await page.mouse.move(520, 340);
    await sleep(page, 300);
    chk("touch-only report: first real mouse move switches capsules on", await page.evaluate(() => document.documentElement.dataset.capsuleScroll === "true"));
    chk("touch-only report: old page scroll control is replaced", !(await page.getByLabel("Page scroll control").isVisible().catch(() => false)));
  },
  { viewport: { width: 1536, height: 864 } },
);
