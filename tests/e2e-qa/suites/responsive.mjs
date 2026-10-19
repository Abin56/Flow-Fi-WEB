/**
 * Browser QA scenarios (responsive.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const VPS = { desktop: { width: 1920, height: 1080 }, laptop: { width: 1366, height: 768 }, mobile: { width: 390, height: 844 } };

const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** computed fg + the first non-transparent ancestor background for an element */
async function colors(page, locator) {
  return locator.evaluate((el) => {
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = s; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; } const p = m[1].split(/[ ,/]+/).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
    const fg = parse(getComputedStyle(el).color);
    let n = el, bg = null;
    while (n) { const b = parse(getComputedStyle(n).backgroundColor); if (b[3] > 0.95) { bg = b; break; } n = n.parentElement; }
    return { fg: fg.slice(0, 3), bg: (bg || [255, 255, 255]).slice(0, 3), fgAlpha: fg[3] };
  });
}

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    const id = `resp-${vpName}-${scheme}`;
    scenario(id, `Responsive: ${vpName} ${vp.width}x${vp.height}, ${scheme} theme — Loan payment dialog`, async ({ page }, chk) => {
      await h.go(page, "/loans-installments");
      await page.waitForTimeout(2500);
      const listOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      chk("loans list: no horizontal page overflow", listOverflow <= 1, `${listOverflow}px`);
      await h.shot(page, `${id}-list`);
      await page.getByText("QA Loan 12").first().click();
      await page.getByRole("button", { name: "Record Payment" }).click();
      const dlg = page.getByRole("dialog", { name: /Pay installment/ });
      await dlg.getByText("TO PAY LENDER").waitFor();
      await page.waitForTimeout(500);
      const box = await dlg.boundingBox();
      chk("dialog fits inside the viewport", box && box.x >= -1 && box.y >= -1 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1, JSON.stringify(box && { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }));
      const ov = await dlg.evaluate((d) => ({ x: d.scrollWidth - d.clientWidth, canScroll: [...d.querySelectorAll("*")].some((e) => e.scrollHeight > e.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(e).overflowY)) }));
      chk("dialog: no horizontal overflow", ov.x <= 1, `${ov.x}px; vertical scroll area present=${ov.canScroll}`);
      await dlg.getByText("Choose paying account").click();
      await page.getByRole("option", { name: /QA Bank/ }).waitFor();
      const optBox = await page.getByRole("option", { name: /QA Bank/ }).boundingBox();
      chk("account picker options are within the viewport", optBox && optBox.x >= 0 && optBox.x + optBox.width <= vp.width + 1 && optBox.y + optBox.height <= vp.height + 1, JSON.stringify(optBox && { x: Math.round(optBox.x), y: Math.round(optBox.y), w: Math.round(optBox.width) }));
      await page.getByRole("option", { name: /QA Bank/ }).click();
      const pay = dlg.getByRole("button", { name: /Pay ₹5,330\.93 to lender/ });
      await pay.scrollIntoViewIfNeeded();
      const pb = await pay.boundingBox();
      chk("primary button visible & reachable in the viewport", pb && pb.y >= 0 && pb.y + pb.height <= vp.height + 1 && pb.x >= 0 && pb.x + pb.width <= vp.width + 1, JSON.stringify(pb && { x: Math.round(pb.x), y: Math.round(pb.y), w: Math.round(pb.width), h: Math.round(pb.height) }));
      chk("primary button touch target ≥ 40px tall", pb && pb.height >= 40, `${pb && Math.round(pb.height)}px`);
      const c1 = await colors(page, pay);
      const r1 = ratio(c1.fg, c1.bg);
      chk("primary button text contrast ≥ 4.5:1", r1 >= 4.5, `${r1.toFixed(2)}:1 fg ${c1.fg} on ${c1.bg}`);
      const lbl = dlg.getByText("TO PAY LENDER").first();
      const c2 = await colors(page, lbl);
      const r2 = ratio(c2.fg, c2.bg);
      chk("label text ('TO PAY LENDER') contrast ≥ 4.5:1", r2 >= 4.5, `${r2.toFixed(2)}:1 fg ${c2.fg} on ${c2.bg}`);
      const amt = dlg.getByText("₹5,330.93").first();
      const c3 = await colors(page, amt);
      chk("amount text contrast ≥ 4.5:1", ratio(c3.fg, c3.bg) >= 4.5, `${ratio(c3.fg, c3.bg).toFixed(2)}:1`);
      await h.shot(page, `${id}-dialog`);
      // keyboard: Tab from the top of the dialog reaches the primary action; Enter on it submits once
      await dlg.getByRole("button", { name: "Close" }).first().focus();
      let reached = false;
      for (let i = 0; i < 60 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => /^Pay ₹5,330\.93/.test(document.activeElement?.textContent?.trim() || "")); }
      chk("keyboard: Tab reaches the primary 'Pay' button", reached);
      const focusVisible = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return cs.outlineStyle !== "none" || cs.boxShadow !== "none"; });
      chk("keyboard: focused primary button shows a focus indicator", focusVisible);
      await page.evaluate(() => window.__reset());
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3500);
      const tl = await h.timeline(page);
      const commits = await page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);
      chk("keyboard: Enter submits exactly once (2 Enter presses)", commits === 1, `commits ${commits}`);
      const toastEl = page.getByText(/recorded successfully/i).last();
      await toastEl.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      if (await toastEl.count()) {
        const tb = await toastEl.boundingBox();
        chk("success toast is visible inside the viewport", tb && tb.x >= 0 && tb.x + tb.width <= vp.width + 1 && tb.y >= 0 && tb.y + tb.height <= vp.height + 1, JSON.stringify(tb && { x: Math.round(tb.x), y: Math.round(tb.y), w: Math.round(tb.width) }));
        await h.shot(page, `${id}-toast`);
      } else chk("success toast seen", false, "no 'Payment recorded' text found after submit (toast may have auto-dismissed)");
      const after = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      chk("no horizontal overflow after the payment", after <= 1, `${after}px`);
      return tl;
    }, { viewport: vp, scheme });
  }
}

scenario("resp-esc-idle", "Keyboard: Escape closes an idle payment dialog without writing", async ({ page }, chk) => {
  await h.go(page, "/loans-installments");
  await page.getByText("QA Loan 12").first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await page.evaluate(() => window.__reset());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  chk("dialog closed by Escape", (await dlg.count()) === 0 || !(await dlg.isVisible()));
  chk("no write", (await page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length)) === 0);
});

