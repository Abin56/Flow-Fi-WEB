/**
 * SMS candidates — visual + layout sweep across viewports and themes (390 / 768 / 1366 / 1920, light + dark).
 * Local emulator only (see tests/e2e-qa/README.md). Synthetic candidates are written to the Firestore EMULATOR; the real UI
 * is then driven and photographed. Screenshots land in tests/e2e-qa/.results/shots as `smsv-<viewport>-<theme>-<view>.png`.
 * The checks are measurements (overflow, reachability, touch-target size, contrast), not pixel comparisons.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const DAY = 86400000;
const s = (v) => ({ stringValue: v });
const n = (v) => ({ doubleValue: v });
const nul = { nullValue: null };

async function putCandidate(uid, { id, amount, merchant, accountId, daysAgo, direction = "debit", eventType = "upiPayment", rawLastFour = null, confidenceLevel = "high", needsReview = false, reasons = [] }) {
  const fields = {
    amount: n(amount),
    direction: s(direction),
    eventType: s(eventType),
    transactionDate: { timestampValue: new Date(Date.now() - daysAgo * DAY).toISOString() },
    merchant: merchant ? s(merchant) : nul,
    bankName: s("QA Bank"),
    rawLastFour: rawLastFour ? s(rawLastFour) : nul,
    accountId: accountId ? s(accountId) : nul,
    cardId: nul,
    referenceNumber: nul,
    confidenceLevel: s(confidenceLevel),
    confidenceScore: n(confidenceLevel === "high" ? 0.9 : confidenceLevel === "medium" ? 0.66 : 0.4),
    needsReview: { booleanValue: needsReview },
    needsReviewReasons: { arrayValue: { values: reasons.map((r) => s(r)) } },
    source: s("sms"),
    createdAt: { timestampValue: new Date().toISOString() },
    deletedAt: nul,
  };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${id}: ${r.status} ${await r.text()}`);
}

const lum = (c) => {
  const [r, g, b] = c.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** computed fg + the first opaque ancestor background for an element */
async function colors(locator) {
  return locator.evaluate((el) => {
    const parse = (str) => {
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = str;
      c.fillRect(0, 0, 1, 1);
      const d = c.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const fg = parse(getComputedStyle(el).color);
    let node = el;
    let bg = null;
    while (node) {
      const b = parse(getComputedStyle(node).backgroundColor);
      if (b[3] > 0.95) {
        bg = b;
        break;
      }
      node = node.parentElement;
    }
    return { fg: fg.slice(0, 3), bg: (bg || [255, 255, 255]).slice(0, 3) };
  });
}

const VPS = { m390: { width: 390, height: 844 }, t768: { width: 768, height: 1024 }, l1366: { width: 1366, height: 768 }, d1920: { width: 1920, height: 1080 } };
const rowOf = (page, text) => page.getByTestId("candidate-row").filter({ hasText: text }).first();
const openRow = (page, text) => rowOf(page, text).getByRole("button", { name: /^Review/ }).click();

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    const id = `smsv-${vpName}-${scheme}`;
    scenario(
      id,
      `SMS candidates visual sweep: ${vp.width}x${vp.height}, ${scheme}`,
      async ({ page }, chk, notes) => {
        const uid = await h.authUid();
        const bank = (await h.accountBalance("QA Bank")).id;
        await putCandidate(uid, { id: "smsv-clean-0001", amount: 321, merchant: "Swiggy", accountId: bank, daysAgo: 1 });
        await putCandidate(uid, { id: "smsv-medium-001", amount: 1904, merchant: "BigBasket", accountId: bank, daysAgo: 1, confidenceLevel: "medium", needsReview: true });
        await putCandidate(uid, { id: "smsv-nomatch-01", amount: 323, merchant: "Uber", accountId: null, rawLastFour: "7743", daysAgo: 2, confidenceLevel: "low", needsReview: true, reasons: ["No matching account or card found for this message."] });
        await putCandidate(uid, { id: "smsv-deleted-001", amount: 324, merchant: "Ola", accountId: "deleted-account-0001", daysAgo: 2 });
        await putCandidate(uid, { id: "smsv-dup-000001", amount: 850, merchant: "QA groceries", accountId: bank, daysAgo: 2 });
        await putCandidate(uid, { id: "smsv-credit-001", amount: 62000, merchant: "Acme Corp", accountId: bank, daysAgo: 3, direction: "credit", eventType: "salaryCredit" });
        await putCandidate(uid, { id: "smsv-rawref-001", amount: 58, merchant: "IGST-VPS2717151193919-RATE 18.0 -32", accountId: bank, daysAgo: 3, confidenceLevel: "low", needsReview: true, reasons: ["Parsed by a generic, lower-confidence parser rather than a bank-specific one."] });

        const tag = (view) => `${id}-${view}`;
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

        // ── list ──
        await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
        await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
        await page.waitForTimeout(800);
        chk("list: no horizontal page overflow", (await overflow()) <= 1, `${await overflow()}px`);
        const laneBox = await page.getByRole("group", { name: "Inbox views" }).boundingBox();
        notes.push(`lanes strip: ${laneBox ? Math.round(laneBox.width) + "x" + Math.round(laneBox.height) : "n/a"}`);
        const reviewBtn = page.getByRole("button", { name: /^Review Swiggy/ }).first();
        const rb = await reviewBtn.boundingBox().catch(() => null);
        chk("list: the Review button is on screen at this width", !!rb && rb.x >= 0 && rb.x + rb.width <= vp.width + 1, rb ? `${Math.round(rb.x)}..${Math.round(rb.x + rb.width)} of ${vp.width}` : "not visible");
        const ledgerScrolls = await page.evaluate(() => [...document.querySelectorAll('[data-testid="candidates-ledger"] *')].some((d) => d.scrollWidth > d.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(d).overflowX)));
        notes.push(`ledger scrolls horizontally: ${ledgerScrolls}`);
        chk("list: nothing in the ledger scrolls sideways", !ledgerScrolls);
        // The row reflows from its container: stacked (44px controls) below 56rem, one aligned line (40px) from there up.
        const ledgerWidth = await page.getByTestId("candidates-ledger").evaluate((el) => el.clientWidth);
        const cardsLayout = ledgerWidth < 896;
        notes.push(`list layout: ${cardsLayout ? "stacked" : "single-line"} (${ledgerWidth}px)`);
        chk("list: the first actionable candidate is visible without scrolling", !!rb && rb.y >= 0 && rb.y + rb.height <= vp.height, rb ? `Review button y ${Math.round(rb.y)}..${Math.round(rb.y + rb.height)} of ${vp.height}` : "none");
        chk(`list: Review button is at least ${cardsLayout ? 44 : 40}px tall`, !!rb && rb.height >= (cardsLayout ? 44 : 40), rb ? `${Math.round(rb.height)}px` : "none");
        const cbBox = await page.getByRole("checkbox", { name: /^Select Swiggy/ }).locator("xpath=..").boundingBox().catch(() => null);
        chk("list: the row checkbox has a 44px hit area", !!cbBox && cbBox.width >= 44 && cbBox.height >= 44, cbBox ? `${Math.round(cbBox.width)}x${Math.round(cbBox.height)}` : "none");
        const laneBtn0 = await page.getByRole("group", { name: "Inbox views" }).getByRole("button").first().boundingBox();
        chk(`list: view tabs are at least ${vp.width >= 1024 ? 40 : 44}px tall`, !!laneBtn0 && laneBtn0.height >= (vp.width >= 1024 ? 40 : 44), laneBtn0 ? `${Math.round(laneBtn0.height)}px` : "none");
        const nestedInteractive = await page.evaluate(() => [...document.querySelectorAll('[data-testid="candidate-row"]')].some((r) => r.matches('[role="button"], button, a') || r.closest('[role="button"]')));
        chk("list: no row is itself a button (no nested interactive controls)", !nestedInteractive);
        await h.shot(page, tag("list"));

        // The Filters button opens the advanced-filters sheet on every width: it must fit the viewport, its controls must be
        // touch-sized, a draft applies only on Apply, and Escape discards it.
        const filtersBtn = page.getByTestId("open-filters");
        await filtersBtn.click();
        const sheet = page.getByRole("dialog", { name: "Filters" });
        await sheet.waitFor({ timeout: 5000 });
        await page.waitForTimeout(400);
        const sb = await sheet.boundingBox();
        chk("filters sheet: fits the viewport", !!sb && sb.x >= -1 && sb.x + sb.width <= vp.width + 1 && sb.height <= vp.height + 1, sb ? `${Math.round(sb.width)}x${Math.round(sb.height)} at ${Math.round(sb.x)},${Math.round(sb.y)}` : "none");
        chk("filters sheet: no horizontal overflow inside", await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
        const monthSel = sheet.getByRole("combobox").first();
        const mb = await monthSel.boundingBox();
        chk("filters sheet: the controls are 44px tall", !!mb && mb.height >= 44, mb ? `${Math.round(mb.height)}px` : "none");
        const apply = await sheet.getByTestId("apply-filters").boundingBox();
        chk("filters sheet: Apply is on screen and 44px tall", !!apply && apply.height >= 44 && apply.y + apply.height <= vp.height + 1, apply ? `y ${Math.round(apply.y)}..${Math.round(apply.y + apply.height)} of ${vp.height}` : "none");
        await h.shot(page, tag("filters-open"));
        await sheet.getByRole("button", { name: "Credit", exact: true }).click();
        const rowsBefore = await page.getByTestId("candidate-row").count();
        chk("filters sheet: a draft changes nothing until Apply", (await page.getByTestId("candidate-row").count()) === rowsBefore && (await page.getByTestId("active-filter-count").count()) === 0);
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "hidden", timeout: 5000 });
        chk("filters sheet: Escape discards the draft", (await page.getByTestId("candidate-row").count()) === rowsBefore && (await page.getByTestId("active-filter-count").count()) === 0);

        // ── bulk selection + dialog ──
        await page.getByRole("checkbox", { name: /^Select Swiggy/ }).click();
        await page.getByRole("checkbox", { name: /^Select BigBasket/ }).click();
        await page.getByText("2 selected").waitFor({ timeout: 10000 });
        await h.shot(page, tag("bulk-bar"));
        await page.getByRole("button", { name: /Import selected \(2\)/ }).click();
        const bulk = page.getByRole("dialog").first();
        await bulk.getByText(/Import 2 transactions/).waitFor({ timeout: 20000 });
        await page.waitForTimeout(400);
        const bb = await bulk.boundingBox();
        chk("bulk dialog fits the viewport", !!bb && bb.x >= -1 && bb.y >= -1 && bb.x + bb.width <= vp.width + 1 && bb.y + bb.height <= vp.height + 1, bb ? `${Math.round(bb.width)}x${Math.round(bb.height)} at ${Math.round(bb.x)},${Math.round(bb.y)}` : "none");
        const importBtn = bulk.getByRole("button", { name: /^Import 2/ });
        await importBtn.scrollIntoViewIfNeeded();
        const ib = await importBtn.boundingBox();
        chk("bulk dialog: the Import button is reachable and 44px tall on touch-sized screens (36px on desktop)", !!ib && ib.y + ib.height <= vp.height + 1 && ib.height >= (vp.width < 1024 ? 44 : 36), ib ? `${Math.round(ib.height)}px tall, bottom ${Math.round(ib.y + ib.height)}/${vp.height}` : "none");
        await h.shot(page, tag("bulk-dialog"));
        await bulk.getByRole("button", { name: "Cancel" }).click();
        await bulk.waitFor({ state: "detached", timeout: 10000 });
        await page.getByRole("button", { name: "Clear selection" }).click();

        // ── review drawer: clean candidate ──
        async function openDrawer(text) {
          await openRow(page, text);
          const d = page.getByRole("dialog").first();
          await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
          await page.waitForTimeout(700);
          return d;
        }
        async function closeDrawer(d) {
          await d.getByLabel("Close", { exact: true }).click();
          const discard = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
          if (await discard.isVisible().catch(() => false)) await discard.getByRole("button", { name: "Discard and close" }).click();
          await d.waitFor({ state: "detached", timeout: 10000 });
          await page.waitForTimeout(300);
        }
        let d = await openDrawer("Swiggy");
        const db = await d.boundingBox();
        chk("drawer: fits the viewport", !!db && db.x >= -1 && db.y >= -1 && db.x + db.width <= vp.width + 1 && db.y + db.height <= vp.height + 1, db ? `${Math.round(db.width)}x${Math.round(db.height)} at ${Math.round(db.x)},${Math.round(db.y)}` : "none");
        chk("drawer: no horizontal overflow inside", (await d.evaluate((el) => el.scrollWidth - el.clientWidth)) <= 1);
        notes.push(`drawer width ${db ? Math.round(db.width) : "?"} of ${vp.width} (${db ? Math.round((db.width / vp.width) * 100) : "?"}%)`);
        const imp = d.getByRole("button", { name: /Import as Transaction/ });
        const ibx = await imp.boundingBox();
        chk("drawer: the Import button is visible without scrolling and ≥ 40px tall", !!ibx && ibx.y >= 0 && ibx.y + ibx.height <= vp.height + 1 && ibx.height >= 40, ibx ? `${Math.round(ibx.height)}px tall, y ${Math.round(ibx.y)}..${Math.round(ibx.y + ibx.height)} of ${vp.height}` : "none");
        const scrollable = await d.evaluate((el) => [...el.querySelectorAll("*")].some((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)));
        notes.push(`drawer has an internal scroll area: ${scrollable}`);
        await h.shot(page, tag("drawer-top"));
        // contrast of the muted caption + the (enabled) primary button once a category is picked
        await d.getByRole("combobox").first().click();
        await page.getByRole("option").first().click();
        await page.waitForTimeout(300);
        const cp = await colors(imp);
        const cr = ratio(cp.fg, cp.bg);
        chk("drawer: enabled Import button text contrast ≥ 4.5:1", cr >= 4.5, `${cr.toFixed(2)}:1`);
        const status = d.getByText("Still needed").first();
        if (await status.isVisible().catch(() => false)) {
          const cs = await colors(status);
          notes.push(`'Still needed' caption contrast ${ratio(cs.fg, cs.bg).toFixed(2)}:1`);
        }
        await d.evaluate((el) => {
          const sc = [...el.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY));
          if (sc) sc.scrollTop = sc.scrollHeight;
        });
        await page.waitForTimeout(300);
        await h.shot(page, tag("drawer-bottom"));
        // expand People & split on the expense
        const splitBtn = d.getByRole("radio", { name: "Split expense" });
        if (await splitBtn.isVisible().catch(() => false)) {
          await splitBtn.click();
          await page.waitForTimeout(300);
          chk("drawer: no horizontal overflow with the split editor open", (await d.evaluate((el) => el.scrollWidth - el.clientWidth)) <= 1);
          await h.shot(page, tag("drawer-split"));
        } else notes.push("Split ownership option not visible (layout)");
        await closeDrawer(d);

        // ── duplicate candidate ──
        d = await openDrawer("QA groceries");
        const dupVisible = await d.getByText("Possible duplicate").first().isVisible().catch(() => false);
        chk("duplicate drawer: shows the possible-duplicate panel", dupVisible);
        await h.shot(page, tag("drawer-duplicate"));
        await closeDrawer(d);

        // ── unmatched / deleted-account candidate ──
        d = await openDrawer("Uber");
        await h.shot(page, tag("drawer-unmatched"));
        await closeDrawer(d);
        d = await openDrawer("IGST-VPS2717151193919-RATE 18.0 -32");
        await h.shot(page, tag("drawer-rawref"));
        await closeDrawer(d);

        // ── status lane buttons: touch target sizes (mobile guidance ≥ 40–44px) ──
        const laneBtn = page.getByRole("group", { name: "Inbox views" }).getByRole("button").first();
        const lb = await laneBtn.boundingBox();
        notes.push(`lane button height ${lb ? Math.round(lb.height) : "?"}px`);
        const dismiss = rowOf(page, "Swiggy").getByRole("button", { name: /^Dismiss/ });
        const dbx = await dismiss.boundingBox().catch(() => null);
        notes.push(`row Dismiss button ${dbx ? Math.round(dbx.width) + "x" + Math.round(dbx.height) : "not visible"}`);
        chk(`list: Dismiss button is at least ${cardsLayout ? 44 : 40}px tall`, !!dbx && dbx.height >= (cardsLayout ? 44 : 40), dbx ? `${Math.round(dbx.height)}px` : "none");
        const cbx = await page.getByRole("checkbox", { name: /^Select Swiggy/ }).boundingBox().catch(() => null);
        notes.push(`row checkbox ${cbx ? Math.round(cbx.width) + "x" + Math.round(cbx.height) : "not visible"}`);
      },
      { viewport: vp, scheme },
    );
  }
}

/** Effective foreground / background of an element, compositing every translucent ancestor layer (a tinted badge on a tinted row on a card). */
async function effective(locator) {
  return locator.evaluate((el) => {
    const parse = (str) => {
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = str;
      c.fillRect(0, 0, 1, 1);
      const d = c.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const layers = [];
    for (let node = el; node; node = node.parentElement) layers.push(parse(getComputedStyle(node).backgroundColor));
    let bg = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const f = parse(getComputedStyle(el).color);
    const fg = [f[0] * f[3] + bg[0] * (1 - f[3]), f[1] * f[3] + bg[1] * (1 - f[3]), f[2] * f[3] + bg[2] * (1 - f[3])];
    const bc = parse(getComputedStyle(el).borderTopColor);
    const border = [bc[0] * bc[3] + bg[0] * (1 - bc[3]), bc[1] * bc[3] + bg[1] * (1 - bc[3]), bc[2] * bc[3] + bg[2] * (1 - bc[3])];
    return { fg, bg, border };
  });
}

for (const scheme of ["light", "dark"]) {
  scenario(
    `smsv-contrast-${scheme}`,
    `SMS candidates contrast audit (${scheme}) — real badges, captions, checkboxes, drawer panels`,
    async ({ page }, chk, notes) => {
      const uid = await h.authUid();
      const bank = (await h.accountBalance("QA Bank")).id;
      await putCandidate(uid, { id: "smsc-medium-001", amount: 1904, merchant: "BigBasket", accountId: bank, daysAgo: 1, confidenceLevel: "medium", needsReview: true });
      await putCandidate(uid, { id: "smsc-clean-0001", amount: 321, merchant: "Swiggy", accountId: bank, daysAgo: 1 });
      await putCandidate(uid, { id: "smsc-nomatch-01", amount: 323, merchant: "Uber", accountId: null, rawLastFour: "7743", daysAgo: 2, confidenceLevel: "low", needsReview: true, reasons: ["No matching account or card found for this message."] });
      await putCandidate(uid, { id: "smsc-dup-000001", amount: 850, merchant: "QA groceries", accountId: bank, daysAgo: 2 });
      await putCandidate(uid, { id: "smsc-lowrev-0001", amount: 58, merchant: "Chai Point", accountId: bank, daysAgo: 3, confidenceLevel: "low", needsReview: true, reasons: ["Parsed by a generic, lower-confidence parser rather than a bank-specific one."] });
      await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
      await page.getByText("Swiggy").first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(800);

      const text = async (label, locator, min = 4.5) => {
        const target = locator.filter({ visible: true }).first();
        if (!(await target.isVisible().catch(() => false))) return notes.push(`${label}: not visible`);
        const c = await effective(target);
        const r = ratio(c.fg, c.bg);
        chk(`${label} — text contrast ≥ ${min}:1`, r >= min, `${r.toFixed(2)}:1`);
      };
      const row = (t) => rowOf(page, t);
      await text("list: 'Review suggested' notice", row("BigBasket").getByText("Review suggested"));
      await text("list: month heading", page.getByTestId("candidate-group").first().getByRole("heading"));
      await text("list: 'Needs account' notice", row("Uber").getByRole("button", { name: /Needs account/ }));
      await text("list: 'Possible duplicate' notice", row("QA groceries").getByText("Possible duplicate"));
      await text("list: 'Needs review' notice", row("Chai Point").getByText("Needs review", { exact: true }));
      await text("list: confidence note", row("BigBasket").getByText(/Medium confidence/));
      await text("list: merchant name", row("Swiggy").getByText("Swiggy", { exact: true }));
      await text("list: debit amount", row("Swiggy").getByLabel(/^Debit/));
      await text("list: date · type · account meta line", row("Uber").getByText(/Not matched/));
      const cb = page.getByRole("checkbox", { name: /^Select Swiggy/ });
      const cbc = await effective(cb);
      const cbr = ratio(cbc.border, cbc.bg);
      chk("list: an unchecked row checkbox's border is visible (non-text ≥ 3:1)", cbr >= 3, `${cbr.toFixed(2)}:1`);

      await openRow(page, "QA groceries");
      const d = page.getByRole("dialog").first();
      await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(600);
      await text("drawer: 'POSSIBLE DUPLICATE' panel heading", d.getByText("Possible duplicate", { exact: true }));
      await text("drawer: duplicate reason text", d.getByText(/Same description/));
      await text("drawer: status badge in the amount hero", d.getByText("Possible Duplicate"));
      await text("drawer: 'Importing will re-check…' note", d.getByText(/Importing will re-check/));
      await text("drawer: 'Still needed:' caption", d.getByText("Still needed:"));
      await text("drawer: 'Matched from SMS' pill", d.getByText("Matched from SMS"));
      await h.shot(page, `smsv-contrast-${scheme}-drawer-dup`);
    },
    { viewport: VPS.l1366, scheme },
  );
}
