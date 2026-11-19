/**
 * Transaction Inbox — compact Grid cards + safe Dismiss (2026-11-18). Local emulator only (see tests/e2e-qa/README.md).
 * Seeds synthetic candidates in the Firestore EMULATOR, switches the Inbox to Grid (one day at a time — see sms-day-nav.mjs) and measures the real cards:
 *  - compact: every card in a row is the same height, well under the old ~236px; 10px corners; nothing clipped or overflowing;
 *  - Dismiss is a labelled control with a tooltip, far from Review;
 *  - an empty-space click opens Review and never dismisses;
 *  - a second click at the same spot right after a Dismiss (the next card slides under the pointer) dismisses nothing;
 *  - Undo — even after hovering the toast — restores the card, and the delete never runs; without Undo it commits.
 * Screenshots: tests/e2e-qa/.results/shots/igrid-*.png
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
    transactionDate: { timestampValue: new Date(Date.now() - daysAgo * DAY - 3600000 * 5).toISOString() },
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

async function candidateExists(uid, id) {
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { headers: OWNER });
  return r.status === 200;
}

async function seedPairedSwitch(uid) {
  const sw = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsSyncConfig/backgroundUpload`, {
    method: "PATCH",
    headers: OWNER,
    body: JSON.stringify({ fields: { enabled: { booleanValue: true }, deviceId: { stringValue: "qa-sms-device" }, source: { stringValue: "pairing" } } }),
  });
  if (!sw.ok) throw new Error(`seed Auto Sync switch: ${sw.status}`);
}

async function seed(uid, prefix) {
  await seedPairedSwitch(uid);
  const bank = (await h.accountBalance("QA Bank")).id;
  const list = [
    { amount: 299, merchant: null, daysAgo: 1 },
    { amount: 2000, merchant: "QA Employer Payroll Services", daysAgo: 1, direction: "credit", eventType: "salaryCredit" },
    { amount: 20, merchant: "Chai Point", daysAgo: 2 },
    { amount: 500, merchant: "9595679917@ptyes", daysAgo: 2 },
    { amount: 125000.5, merchant: "Very Long Merchant Name Private Limited", daysAgo: 3 },
    { amount: 101, merchant: "Refund desk", daysAgo: 3, accountId: null, rawLastFour: "7743", confidenceLevel: "low", needsReview: true, reasons: ["No matching account or card found for this message."] },
    { amount: 12000, merchant: null, daysAgo: 4, direction: "credit", eventType: "bankCredit" },
    { amount: 1904, merchant: "BigBasket", daysAgo: 4, confidenceLevel: "medium", needsReview: true },
  ];
  for (let i = 0; i < 16; i++) {
    const c = list[i % list.length];
    // The Grid shows ONE day at a time, so the first eight (every card variant) share yesterday — a full day of cards to measure — and the rest sit on other days.
    await putCandidate(uid, { id: `${prefix}-${String(i).padStart(4, "0")}`, accountId: "accountId" in c ? c.accountId : bank, ...c, daysAgo: i < list.length ? 1 : c.daysAgo + Math.floor(i / list.length) * 5 });
  }
}

async function openGrid(page) {
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.getByText("Chai Point", { exact: true }).first().waitFor({ timeout: 40000 });
  const grid = page.getByRole("button", { name: "Grid view" });
  if ((await grid.getAttribute("aria-pressed")) !== "true") await grid.click();
  await page.getByTestId("candidate-grid").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
}

function measureCards(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="candidate-row"][data-layout="grid"]')];
    const rects = cards.map((c) => c.getBoundingClientRect());
    const firstTop = rects[0]?.top;
    const firstRow = rects.filter((r) => Math.abs(r.top - firstTop) < 2);
    const clipped = cards.filter((c) => [...c.querySelectorAll("*")].some((el) => {
      const r = el.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      return r.width > 0 && (r.right > cr.right + 1 || r.left < cr.left - 1);
    })).length;
    const gaps = cards.map((c) => {
      const review = c.querySelector("button[data-review-id]")?.getBoundingClientRect();
      const dismiss = c.querySelector('[data-testid="candidate-dismiss"]')?.getBoundingClientRect();
      return review && dismiss ? dismiss.left - review.right : null;
    });
    const cs = cards[0] ? getComputedStyle(cards[0]) : null;
    return {
      count: cards.length,
      columns: firstRow.length,
      width: Math.round(rects[0]?.width ?? 0),
      heights: [...new Set(rects.map((r) => Math.round(r.height)))].sort((a, b) => a - b),
      firstRowHeights: [...new Set(firstRow.map((r) => Math.round(r.height)))],
      radius: cs?.borderTopLeftRadius,
      clipped,
      minGap: Math.min(...gaps.filter((g) => g != null)),
      dismissLabels: [...new Set(cards.map((c) => c.querySelector('[data-testid="candidate-dismiss"]')?.textContent?.trim().split(/\s+/)[0]))],
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

const VPS = { l1366: { width: 1366, height: 768 }, d1920: { width: 1920, height: 1080 } };

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    scenario(
      `igrid-layout-${vpName}-${scheme}`,
      `Inbox grid cards are compact, aligned and readable (${vp.width}x${vp.height}, ${scheme})`,
      async ({ page }, chk, notes) => {
        const uid = await h.authUid();
        await seed(uid, `ig-${vpName}-${scheme}`);
        await openGrid(page);
        const m = await measureCards(page);
        notes.push(JSON.stringify(m));
        await h.shot(page, `igrid-${vpName}-${scheme}`);
        chk("a full day of cards rendered in Grid", m.count >= 8, `${m.count}`);
        chk("several cards per row", m.columns >= (vp.width >= 1900 ? 6 : 4), `${m.columns} columns, ${m.width}px wide`);
        chk("cards in the first row share one height (notices don't grow a card)", m.firstRowHeights.length === 1, m.firstRowHeights.join(","));
        chk("cards are compact (≤ 180px, the old card was ~236px)", m.heights.every((x) => x <= 180), m.heights.join(","));
        chk("10px corners", m.radius === "10px", m.radius);
        chk("nothing overflows a card", m.clipped === 0, `${m.clipped} cards`);
        chk("Review and Dismiss are well apart (≥ 24px)", m.minGap >= 24, `${m.minGap}px`);
        chk("Dismiss is labelled on every card", m.dismissLabels.length === 1 && m.dismissLabels[0] === "Dismiss", m.dismissLabels.join("|"));
        chk("no horizontal page scroll", !m.pageOverflowX);
      },
      { viewport: vp, scheme },
    );
  }
}

scenario(
  "igrid-dismiss-safety",
  "Grid: card click opens Review (never dismisses); tooltip; reflow guard; Undo after hovering restores; no Undo commits",
  async ({ page }, chk, notes) => {
    const uid = await h.authUid();
    await seed(uid, "igd");
    await openGrid(page);
    const cards = page.locator('[data-testid="candidate-row"][data-layout="grid"]');
    const before = await cards.count();

    // 1. Empty-space click (on the amount) opens Review; nothing is dismissed.
    const first = cards.first();
    const firstId = await first.getAttribute("data-candidate-id");
    await first.locator("span.font-heading").click();
    const dialog = page.getByRole("dialog").first();
    await dialog.waitFor({ timeout: 8000 });
    chk("an empty-space card click opens the review sheet", await dialog.isVisible());
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 8000 });
    chk("…and dismisses nothing", (await cards.count()) === before, `${await cards.count()} vs ${before}`);

    // 2. Review button still opens the same sheet.
    await first.getByRole("button", { name: /^Review/ }).click();
    await page.getByRole("dialog").first().waitFor({ timeout: 8000 });
    chk("Review opens the review sheet", await page.getByRole("dialog").first().isVisible());
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: 8000 });

    // 3. Tooltip explains Dismiss.
    const dismiss = first.getByTestId("candidate-dismiss");
    await dismiss.hover();
    const tip = page.getByRole("tooltip").first();
    await tip.waitFor({ timeout: 4000 }).catch(() => {});
    const tipText = (await tip.textContent().catch(() => "")) ?? "";
    chk("Dismiss has a tooltip saying what it does and that it can be undone", /without importing/i.test(tipText) && /undo/i.test(tipText), tipText);
    await h.shot(page, "igrid-dismiss-tooltip");

    // 4. Dismiss, then an impatient second click at the same spot: only ONE card goes.
    const box = await dismiss.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.evaluate(() => {
      window.__clicks = [];
      document.addEventListener("click", (e) => {
        const t = e.target;
        window.__clicks.push({ tag: t.tagName, testid: t.closest("[data-testid]")?.getAttribute("data-testid"), cand: t.closest("[data-candidate-id]")?.getAttribute("data-candidate-id"), detail: e.detail, dialog: !!document.querySelector("[role=dialog]") });
      }, true);
    });
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(120);
    const dialogAfterFirst = await page.getByRole("dialog").count();
    const slidIn = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="candidate-row"]')?.getAttribute("data-candidate-id") ?? null, { x: cx, y: cy });
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(300);
    notes.push(`dialogs after first click: ${dialogAfterFirst}; after second: ${await page.getByRole("dialog").count()}; clicks: ${JSON.stringify(await page.evaluate(() => window.__clicks))}`);
    chk("the guarded second click opens nothing either", (await page.getByRole("dialog").count()) === 0);
    notes.push(`dismissed ${firstId}; card under pointer after reflow: ${slidIn}`);
    chk("the dismissed card leaves the grid", (await page.locator(`[data-candidate-id="${firstId}"]`).count()) === 0);
    chk("a second click on the reflowed card's Dismiss is ignored", (await cards.count()) === before - 1, `${await cards.count()} vs ${before - 1}`);
    const toastEl = page.locator('[data-toast-tone="success"]').filter({ hasText: "Candidate dismissed" }).first();
    await toastEl.waitFor({ timeout: 4000 });
    chk("one Undo toast", (await page.locator('[data-toast-tone="success"]').filter({ hasText: "Candidate dismissed" }).count()) === 1);

    // 5. Hover the toast for a while (the old countdown paused here while the delete didn't), then Undo — restored.
    await toastEl.hover();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "tests/e2e-qa/.results/shots/igrid-dismiss-toast.png" });
    await toastEl.getByRole("button", { name: "Undo" }).click();
    await page.locator(`[data-candidate-id="${firstId}"]`).waitFor({ timeout: 4000 });
    chk("Undo (after hovering the toast) restores the card", (await page.locator(`[data-candidate-id="${firstId}"]`).count()) === 1);
    await page.waitForTimeout(9000);
    chk("…and the delete never ran (candidate still in Firestore)", await candidateExists(uid, firstId));
    chk("…and it's still in the grid", (await page.locator(`[data-candidate-id="${firstId}"]`).count()) === 1);
    chk("no 'Too late to undo' message", (await page.getByText("Too late to undo").count()) === 0);

    // 6. Without Undo the dismissal commits after the window.
    const victim = cards.nth(2);
    const victimId = await victim.getAttribute("data-candidate-id");
    await victim.getByTestId("candidate-dismiss").click();
    await page.waitForTimeout(9500);
    chk("without Undo, the dismissal commits (candidate removed from Firestore)", !(await candidateExists(uid, victimId)));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Chai Point", { exact: true }).first().waitFor({ timeout: 40000 });
    chk("…and stays gone after reload", (await page.locator(`[data-candidate-id="${victimId}"]`).count()) === 0);
  },
  { viewport: VPS.l1366, scheme: "light" },
);
