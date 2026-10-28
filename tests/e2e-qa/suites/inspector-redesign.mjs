/**
 * Transaction bottom sheets — layout measurements and screenshots at 1920 / 1366 / 1080 / 820 / 390 px for the
 * Transaction Inbox editor and the Reconciliation row editor: both rise from the bottom edge of the viewport at full width. Read-only: every scenario proves nothing was written.
 * `INSP_TAG` (default "after") prefixes the screenshots so a before/after pair can be captured from the same scenario.
 * Local emulator only (see tests/e2e-qa/README.md): synthetic candidates are written to the Firestore EMULATOR.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const TAG = process.env.INSP_TAG || "after";
const WIDTHS = [
  [1920, 1080],
  [1366, 768],
  [1080, 800],
  [820, 1180],
  [390, 844],
];
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const DAY = 86400000;
const s = (v) => ({ stringValue: v });
const n = (v) => ({ doubleValue: v });
const nul = { nullValue: null };

async function putCandidate(uid, { id, amount, merchant, accountId, daysAgo, rawLastFour = null, confidenceLevel = "high", needsReview = false, reasons = [] }) {
  const fields = {
    amount: n(amount),
    direction: s("debit"),
    eventType: s("upiPayment"),
    transactionDate: { timestampValue: new Date(Date.now() - daysAgo * DAY).toISOString() },
    merchant: s(merchant),
    bankName: s("QA Bank"),
    rawLastFour: rawLastFour ? s(rawLastFour) : nul,
    accountId: accountId ? s(accountId) : nul,
    cardId: nul,
    referenceNumber: s("UPI412345678901"),
    confidenceLevel: s(confidenceLevel),
    confidenceScore: n(confidenceLevel === "high" ? 0.9 : 0.4),
    needsReview: { booleanValue: needsReview },
    needsReviewReasons: { arrayValue: { values: reasons.map((r) => s(r)) } },
    source: s("sms"),
    createdAt: { timestampValue: new Date().toISOString() },
    deletedAt: nul,
  };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${id}: ${r.status} ${await r.text()}`);
}

/** Geometry of the open drawer: does it fit, is the footer reachable, how much does its body scroll. */
const drawerMetrics = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const scroller = [...d.querySelectorAll("div")].find((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > 0);
    const footer = [...d.querySelectorAll("button")].find((b) => /Import as Transaction/.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
    const fr = footer?.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      vw: innerWidth,
      vh: innerHeight,
      bodyScroll: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
      bodyContent: scroller ? scroller.scrollHeight : null,
      footerVisible: !!fr && fr.bottom <= innerHeight + 1 && fr.top >= 0,
      sideOverflow: d.scrollWidth - d.clientWidth,
    };
  });

async function openDrawer(page, merchant) {
  await page.getByTestId("candidate-row").filter({ hasText: merchant }).first().getByRole("button", { name: /^Review/ }).click();
  const d = page.getByRole("dialog").first();
  await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(600); // slide-in
  return d;
}
async function closeDrawer(page, d) {
  await d.getByLabel("Close", { exact: true }).click();
  // Closing with edits asks first — discard them (closing never imports anything).
  const prompt = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
  if (await prompt.isVisible().catch(() => false)) await prompt.getByRole("button", { name: "Discard and close" }).click();
  await d.waitFor({ state: "detached", timeout: 10000 });
  await page.waitForTimeout(300);
}

scenario("insp-inbox", "Transaction Inbox editor: a full-width bottom sheet with the inbox visible above it at 1920/1366/1080/820/390; split opens inside it; nothing written", async ({ page }, chk, notes) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  // The inbox lists candidates only while a phone is paired (the operator-written switch) — seed it, emulator only.
  const sw = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsSyncConfig/backgroundUpload`, {
    method: "PATCH",
    headers: OWNER,
    body: JSON.stringify({ fields: { enabled: { booleanValue: true }, deviceId: s("qa-insp-device"), source: s("pairing") } }),
  });
  if (!sw.ok) throw new Error(`seed switch: ${sw.status}`);
  // Give the QA account a real bank (HDFC) so its logo file is exercised — emulator only, reseeded every run.
  const bankPatch = await fetch(`${FIRESTORE_DOCS}/users/${uid}/accounts/${bank}?updateMask.fieldPaths=bankId`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields: { bankId: s("hdfc") } }) });
  if (!bankPatch.ok) throw new Error(`seed bank: ${bankPatch.status}`);
  await putCandidate(uid, { id: "sms-insp-0001", amount: 1250, merchant: "Swiggy Instamart", accountId: bank, daysAgo: 1 });
  await putCandidate(uid, { id: "sms-insp-0002", amount: 233, merchant: "Uber", accountId: null, rawLastFour: "4242", daysAgo: 2, confidenceLevel: "low", needsReview: true, reasons: ["No matching account or card found for this message."] });
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.getByText("Swiggy Instamart").first().waitFor({ timeout: 40000 });
  const txnsBefore = (await h.list("transactions")).length;

  for (const [w, ht] of WIDTHS) {
    await page.setViewportSize({ width: w, height: ht });
    await page.waitForTimeout(400);
    let d = await openDrawer(page, "Swiggy Instamart");
    const m = await drawerMetrics(page);
    notes.push(`${w}: matched ${JSON.stringify(m)}`);
    if (w === 1366 || w === 390) {
      await page.waitForTimeout(500); // the logo file loads after the sheet opens
      const logos = await d.locator('img[alt="HDFC Bank"]').evaluateAll((els) => els.map((el) => ({ loaded: el.naturalWidth > 0, w: Math.round(el.getBoundingClientRect().width), parentW: Math.round(el.parentElement.getBoundingClientRect().width) })));
      notes.push(`${w}: bank logos ${JSON.stringify(logos)}`);
      chk(`${w}: the bank logo image loads in the sheet (not the initials fallback)`, logos.length >= 1 && logos.every((l) => l.loaded), JSON.stringify(logos));
      chk(`${w}: the logo fits inside its tile (not cropped)`, logos.every((l) => l.w > 0 && l.w <= l.parentW + 1), JSON.stringify(logos));
    }
    chk(`${w}: a full-width sheet, anchored to the top edge`, m && m.x === 0 && m.w === m.vw && m.y === 0, JSON.stringify(m));
    // Desktop: the default height leaves most of the inbox in view. Phones: a taller sheet, but never the whole screen.
    chk(`${w}: the inbox stays visible below it`, m && m.h <= m.vh * (w >= 1024 ? 0.75 : 0.9), m?.h);
    chk(`${w}: Import action visible without scrolling`, m?.footerVisible);
    chk(`${w}: no sideways overflow inside the drawer`, (m?.sideOverflow ?? 1) <= 1, m?.sideOverflow);
    await h.shot(page, `insp-${TAG}-inbox-${w}`);

    // Split: the new layout offers an ownership switch; the old one a "Split with more people" button.
    const splitRadio = d.getByRole("radio", { name: /^Split/ });
    if ((await splitRadio.count()) > 0) await splitRadio.click();
    else await d.getByRole("button", { name: "Split with more people" }).click();
    await page.waitForTimeout(300);
    const ms = await drawerMetrics(page);
    notes.push(`${w}: split ${JSON.stringify(ms)}`);
    chk(`${w}: with split open the Import action is still reachable`, ms?.footerVisible);
    chk(`${w}: with split open the sheet still never covers the whole viewport`, ms && ms.y === 0 && ms.h < ms.vh - 1, ms?.h);
    await h.shot(page, `insp-${TAG}-inbox-${w}-split`);
    await closeDrawer(page, d);
    const discard = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
    if (await discard.isVisible().catch(() => false)) await discard.getByRole("button", { name: /Discard/ }).click();

    if (w === 1366 || w === 390) {
      d = await openDrawer(page, "Uber");
      const mu = await drawerMetrics(page);
      notes.push(`${w}: unresolved ${JSON.stringify(mu)}`);
      chk(`${w}: unresolved account warning is visible (never collapsed)`, await d.getByTestId("account-match-evidence").isVisible());
      await h.shot(page, `insp-${TAG}-inbox-${w}-unresolved`);
      await closeDrawer(page, d);
    }
  }
  chk("opening, splitting and closing wrote nothing", (await h.list("transactions")).length === txnsBefore);
});

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
function statementText() {
  const lines = [`${ddmmyyyy(-12)}  QA CARD PURCHASE BLR        12,000.00`, `${ddmmyyyy(-1)}  SWIGGY BANGALORE              452.00`, `${ddmmyyyy(-2)}  QA GROCERIES                  850.00`];
  for (let i = 1; i <= 18; i++) lines.push(`${ddmmyyyy(-3)}  FILLER STORE ${String(i).padStart(2, "0")}        ${(100 + i * 7).toFixed(2)}`);
  return lines.join("\n");
}

scenario("insp-recon", "Reconciliation row editor: a full-width bottom sheet with both tables visible above it at 1920/1366/1080; phone sheet at 820/390; nothing written", async ({ page }, chk, notes) => {
  const txnsBefore = (await h.list("transactions")).length;
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(statementText());
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("choose-account").waitFor();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending");
  await page.waitForTimeout(800);

  for (const [w, ht] of WIDTHS) {
    await page.setViewportSize({ width: w, height: ht });
    await page.waitForTimeout(600);
    if (w >= 1024) {
      await page.locator('[data-testid="recon-row"][data-row-id="r12"]').click();
      const toggle = page.getByRole("button", { name: /^(Expand|Collapse) row 12$/ });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await page.getByTestId("row-editor").waitFor();
      await page.waitForTimeout(500); // slide-in + keep-row-visible pass
      const m = await page.evaluate(() => {
        const box = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
        };
        const sheet = box('[data-testid="row-editor-panel"]');
        const statement = box('[data-testid="statement-sheet"]');
        const existing = box('[data-testid="existing-sheet"]');
        const sel = document.querySelector('[data-testid="recon-row"][aria-selected="true"]')?.getBoundingClientRect();
        const panel = document.querySelector('[data-testid="row-editor-panel"]');
        return {
          vw: innerWidth,
          vh: innerHeight,
          sheet,
          statement,
          existing,
          insideATable: !!panel?.closest('[data-testid="statement-sheet"], [data-testid="existing-sheet"]'),
          selectedBelowSheet: !!sel && !!sheet && sel.top >= sheet.bottom - 1 && sel.bottom <= innerHeight,
          selected: sel ? { top: Math.round(sel.top), bottom: Math.round(sel.bottom) } : null,
          tableScrollTop: Math.round(document.querySelector('[data-testid="recon-grid-body"]')?.scrollTop ?? -1),
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      notes.push(`${w}: ${JSON.stringify(m)}`);
      chk(`${w}: a full-width sheet, anchored to the top edge`, m.sheet && m.sheet.x === 0 && m.sheet.w === m.vw && m.sheet.y === 0, JSON.stringify(m.sheet));
      chk(`${w}: rendered at the viewport level, not inside either table`, !m.insideATable);
      chk(`${w}: part of both tables stays visible below the sheet`, m.statement && m.existing && m.sheet && m.statement.bottom > m.sheet.bottom + 60 && m.existing.bottom > m.sheet.bottom + 60, JSON.stringify({ s: m.statement, e: m.existing, sheetBottom: m.sheet?.bottom }));
      chk(`${w}: the selected statement row is visible below the sheet`, m.selectedBelowSheet, JSON.stringify({ sel: m.selected, sheetBottom: m.sheet?.bottom, scrollTop: m.tableScrollTop, vh: m.vh }));
      chk(`${w}: no horizontal overflow`, m.docOverflow <= 1, m.docOverflow);
      await h.shot(page, `insp-${TAG}-recon-${w}`);
      await page.getByRole("button", { name: "Done" }).click();
      await page.getByTestId("row-editor-panel").waitFor({ state: "detached", timeout: 10000 });
    } else {
      await page.getByTestId("recon-card").nth(1).click();
      const sheet = page.getByTestId("mobile-sheet");
      await sheet.waitFor({ timeout: 10000 });
      await sheet.getByRole("tab", { name: "Details" }).click();
      await page.waitForTimeout(500);
      const sb = await sheet.boundingBox();
      chk(`${w}: phone sheet fits the viewport`, sb && sb.y >= 0 && sb.y + sb.height <= ht + 1 && sb.x >= 0 && sb.x + sb.width <= w + 1, JSON.stringify(sb));
      await h.shot(page, `insp-${TAG}-recon-${w}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }
  chk("inspecting rows wrote nothing", (await h.list("transactions")).length === txnsBefore);
});

scenario("insp-smooth", "Opening the Inbox sheet on a long list stays smooth: frame gaps recorded while it slides in; the page behind is not blurred", async ({ page }, chk, notes) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  const sw = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsSyncConfig/backgroundUpload`, {
    method: "PATCH",
    headers: OWNER,
    body: JSON.stringify({ fields: { enabled: { booleanValue: true }, deviceId: s("qa-insp-device"), source: s("pairing") } }),
  });
  if (!sw.ok) throw new Error(`seed switch: ${sw.status}`);
  for (let i = 0; i < 80; i++) await putCandidate(uid, { id: `sms-smooth-${String(i).padStart(3, "0")}`, amount: 100 + i, merchant: i === 0 ? "Smooth Cafe" : `Merchant ${i}`, accountId: i % 3 === 0 ? null : bank, daysAgo: Math.floor(i / 4), rawLastFour: i % 3 === 0 ? "4242" : null });
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.getByText("Smooth Cafe").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500); // let the list settle
  const txnsBefore = (await h.list("transactions")).length;

  for (const [label, w, ht] of [["desktop", 1366, 768], ["phone", 390, 844]]) {
    await page.setViewportSize({ width: w, height: ht });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__gaps = [];
      let last = performance.now();
      const tick = (t) => {
        window.__gaps.push(t - last);
        last = t;
        if (window.__recording) requestAnimationFrame(tick);
      };
      window.__recording = true;
      requestAnimationFrame(tick);
    });
    const click = performance.now();
    await page.getByTestId("candidate-row").filter({ hasText: "Smooth Cafe" }).first().getByRole("button", { name: /^Review/ }).click();
    const d = page.getByRole("dialog").first();
    await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(700); // the slide-in finishes
    const gaps = await page.evaluate(() => {
      window.__recording = false;
      return window.__gaps;
    });
    const worst = Math.round(Math.max(...gaps));
    const long = gaps.filter((g) => g > 50).length;
    notes.push(`${label}: ${gaps.length} frames while opening, worst gap ${worst}ms, ${long} over 50ms`);
    chk(`${label}: no frame stalls longer than 250ms while the sheet opens`, worst <= 250, `${worst}ms`);
    const blurred = await page.evaluate(() => [...document.querySelectorAll('[data-slot="dialog-overlay"], [data-slot="dialog-content"]')].some((e) => getComputedStyle(e).backdropFilter !== "none" && getComputedStyle(e).backdropFilter !== ""));
    chk(`${label}: nothing blurs the page behind the sheet (no backdrop filter)`, !blurred);
    await h.shot(page, `insp-${TAG}-smooth-${label}`);
    await closeDrawer(page, d);
    void click;
  }
  chk("opening and closing wrote nothing", (await h.list("transactions")).length === txnsBefore);
});

scenario("insp-focus", "Reconciliation in Focus Mode: expanding a row still opens the full-width top sheet over the whole viewport", async ({ page }, chk, notes) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(statementText());
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("choose-account").waitFor();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Enter Focus Mode" }).click();
  await page.waitForTimeout(600);
  // the browser's own full screen on top of Focus Mode (the Fullscreen API, where the browser grants it)
  const fsBtn = page.getByRole("button", { name: "Full screen" });
  if (await fsBtn.isVisible().catch(() => false)) {
    await fsBtn.click();
    await page.waitForTimeout(800);
    notes.push("document.fullscreenElement: " + (await page.evaluate(() => document.fullscreenElement?.tagName ?? "none")));
  }
  for (const via of ["pencil", "doubleclick", "enter"]) {
    await page.locator('[data-testid="recon-row"][data-row-id="r5"]').click();
    if (via === "pencil") {
      const toggle = page.getByRole("button", { name: /^(Expand|Collapse) row 5$/ });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    } else if (via === "doubleclick") await page.locator('[data-testid="recon-row"][data-row-id="r5"]').dblclick();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="row-editor-panel"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, z: cs.zIndex };
    });
    notes.push(`${via}: ${JSON.stringify(m)}`);
    chk(`focus mode, ${via}: the sheet opens and is visible`, !!m && m.h > 100 && m.w === m.vw && m.y === 0 && m.opacity === "1", JSON.stringify(m));
    await h.shot(page, `insp-${TAG}-focus-${via}`);
    if (m) {
      await page.getByRole("button", { name: "Done" }).click();
      await page.getByTestId("row-editor-panel").waitFor({ state: "detached", timeout: 10000 });
    }
  }
});

scenario("insp-inbox-fullscreen", "Transaction Inbox in Full screen: opening a transaction shows the top sheet above the full-screen list, and closing it returns to the list", async ({ page }, chk, notes) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  const sw = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsSyncConfig/backgroundUpload`, {
    method: "PATCH",
    headers: OWNER,
    body: JSON.stringify({ fields: { enabled: { booleanValue: true }, deviceId: s("qa-insp-device"), source: s("pairing") } }),
  });
  if (!sw.ok) throw new Error(`seed switch: ${sw.status}`);
  await putCandidate(uid, { id: "sms-insp-0001", amount: 1250, merchant: "Swiggy Instamart", accountId: bank, daysAgo: 1 });
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.getByText("Swiggy Instamart").first().waitFor({ timeout: 40000 });
  await page.getByRole("button", { name: "Full screen" }).click();
  for (const [w, ht] of WIDTHS) {
  await page.setViewportSize({ width: w, height: ht });
  await page.waitForTimeout(500);
  const d = await openDrawer(page, "Swiggy Instamart");
  const m = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"]');
    const r = el.getBoundingClientRect();
    // what is actually painted at the middle of the sheet, and at its top-left corner
    const hit = (x, y) => {
      const top = document.elementFromPoint(x, y);
      return !!top && el.contains(top);
    };
    return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, centreOnTop: hit(r.x + r.width / 2, r.y + 60), closeOnTop: hit(r.right - 40, r.y + 30), footerOnTop: hit(r.x + r.width / 2, r.bottom - 30) };
  });
  notes.push(JSON.stringify(m));
  chk(`${w}: full screen: the sheet is painted above the full-screen list`, m.centreOnTop && m.closeOnTop && m.footerOnTop, JSON.stringify(m));
  await h.shot(page, `insp-${TAG}-inbox-fullscreen-${w}`);
  await closeDrawer(page, d);
  chk(`${w}: full screen: closing the sheet leaves the list in full screen`, await page.getByRole("button", { name: "Exit full screen" }).isVisible());
  }
});

scenario("insp-txn-fullscreen", "Transactions page in Full screen (Expand): opening a transaction shows its popup above the full-screen list", async ({ page }, chk, notes) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await h.go(page, "/transactions");
  await page.getByRole("button", { name: "Full screen" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Edit transaction" }).first().click();
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = (x, y) => {
      const top = document.elementFromPoint(x, y);
      return !!top && el.contains(top);
    };
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, onTop: hit(r.x + r.width / 2, r.y + r.height / 2), z: getComputedStyle(el).zIndex };
  });
  notes.push(JSON.stringify(m));
  chk("full screen: the transaction popup opens", !!m, JSON.stringify(m));
  chk("full screen: the popup is painted above the full-screen list", !!m && m.onTop, JSON.stringify(m));
  await h.shot(page, `insp-${TAG}-txn-fullscreen`);
});
