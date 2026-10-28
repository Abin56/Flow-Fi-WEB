/**
 * Browser QA — Balance Control P0 (read-only variance calculator + Financial Audit definition checks).
 * Local emulator only. Every scenario is READ-ONLY with respect to the app: the suite asserts that typing bank figures,
 * switching products and reloading write nothing (no Firestore write request, and every collection identical before/after).
 * The only writes are the TEST SETUP ones made straight to the emulator (shared-limit facility, a large synthetic history).
 */
import { scenario } from "../lib/core.mjs";
import { BASE_URL, FIRESTORE_DOCS, HOST, PORTS, PROJECT_ID } from "../lib/env.mjs";
import * as h from "../lib/harness.mjs";

const VPS = {
  desktop1920: { width: 1920, height: 1080 },
  laptop1366: { width: 1366, height: 768 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const money = (t) => Number(String(t).replace(/[^0-9.\-−]/g, "").replace("−", "-"));
const close = (a, b, eps = 0.005) => Math.abs(a - b) < eps;

const goTo = async (page, href) => {
  await page.evaluate((x) => window.next.router.push(x), href);
  for (let i = 0; i < 120; i++) {
    if ((await page.evaluate(() => location.pathname)).replace(/[/]$/, "") === href) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`navigation to ${href} did not land`);
};
const overflow = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main")?.scrollWidth - document.querySelector("main")?.clientWidth }));
const waitTable = async (page) => {
  await page.getByRole("heading", { level: 1, name: "Balance Control" }).waitFor();
  await page.locator('[data-testid="variance-table"]').waitFor({ timeout: 60000 });
  // standings load in stages; wait until the first row has a FlowFi number
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="flowfi-value"]')?.textContent ?? ""), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
};
const productNames = (page) => page.locator('[data-testid="product-select"] option').allInnerTexts();
const select = async (page, label) => {
  await page.locator('[data-testid="product-select"]').selectOption({ label });
  await page.waitForTimeout(400);
};
const row = (page, metric) => page.locator(`[data-testid="variance-row-${metric}"]`);
const flowfi = async (page, metric) => money(await row(page, metric).locator('[data-testid="flowfi-value"]').innerText());
const type = async (page, metric, v) => { const i = row(page, metric).locator('[data-testid="bank-input"]'); await i.fill(""); await i.fill(String(v)); };

/** Every document in the collections that hold financial state, serialised — equal before/after proves "no writes". */
const COLLECTIONS = ["accounts", "transactions", "loans", "emis", "creditCards", "sharedCreditLimits", "people", "paymentSchedules", "expenses", "bills", "budgets"];
async function snapshot() {
  const out = {};
  for (const c of COLLECTIONS) out[c] = JSON.stringify((await h.list(c)).sort((a, b) => a.id.localeCompare(b.id)));
  for (const kind of ["loans", "emis"]) {
    for (const d of await h.list(kind)) if (d.scheduleId) out[`${kind}/${d.id}/inst`] = JSON.stringify((await h.list(`paymentSchedules/${d.scheduleId}/installments`)).sort((a, b) => a.id.localeCompare(b.id)));
  }
  for (const p of await h.list("people")) out[`people/${p.id}/ledger`] = JSON.stringify((await h.list(`people/${p.id}/ledger`)).sort((a, b) => a.id.localeCompare(b.id)));
  return out;
}
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

/** Counts Firestore WRITE traffic from the page (Write stream channel / commit / batchWrite). */
function watchWrites(page) {
  const hits = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/Write\/channel|:commit|:batchWrite/.test(u) && r.method() === "POST") {
      const body = decodeURIComponent(r.postData() ?? "");
      const docs = [...new Set((body.match(/documents\/[A-Za-z0-9_/-]+/g) ?? []).map((d) => d.replace(/users\/[^/]+\//, "users/·/")))];
      hits.push(`on ${new URL(page.url()).pathname} docs=[${docs.slice(0, 4).join(",")}] body=${body.slice(0, 160).replace(/\s+/g, " ")}`);
    }
  });
  return hits;
}

const ts = (d) => ({ timestampValue: new Date(d).toISOString() });
async function rest(method, path, body) {
  const r = await fetch(`${FIRESTORE_DOCS}/${path}`, { method, headers: OWNER, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 120)}`);
}
/** TEST SETUP (emulator only): a shared-limit facility and both seeded cards joined to it. */
async function makeSharedFacility(limit) {
  const uid = await h.authUid();
  await rest("PATCH", `users/${uid}/sharedCreditLimits/qa-facility`, {
    fields: { name: { stringValue: "QA Facility" }, creditLimit: { doubleValue: limit }, createdAt: ts(Date.now()), deletedAt: { nullValue: null }, lastEditedAt: { nullValue: null }, editHistory: { arrayValue: { values: [] } } },
  });
  for (const c of await h.list("creditCards")) {
    await rest("PATCH", `users/${uid}/creditCards/${c.id}?updateMask.fieldPaths=sharedLimitId&updateMask.fieldPaths=creditLimit`, {
      fields: { sharedLimitId: { stringValue: "qa-facility" }, creditLimit: { doubleValue: 0 } },
    });
  }
}

/** Expected card figures straight from stored documents (independent of the app's engines). */
async function storedCard(lastFour) {
  const cards = await h.list("creditCards");
  const card = cards.find((c) => c.lastFourDigits === lastFour);
  const txns = (await h.list("transactions")).filter((t) => t.accountId === card.accountId && !t.deletedAt && !t.excludeFromCalculations);
  const charges = txns.filter((t) => !(t.transferId && t.type === "income")).reduce((s, t) => s + (t.type === "income" ? -t.amount : t.amount), 0);
  const payments = txns.filter((t) => t.transferId && t.type === "income").reduce((s, t) => s + t.amount, 0);
  return { card, outstanding: Math.max(charges - payments, 0), ledger: charges - payments };
}

/* ───────────────────────────── 1. entry points ───────────────────────────── */
scenario("bc-entry", "Balance Control: reachable from the sidebar and from Financial Audit; both directions work", async ({ page }, chk) => {
  await goTo(page, "/dashboard");
  const link = page.getByRole("link", { name: "Balance Control" }).first();
  chk("sidebar has a Balance Control link", await link.count() > 0);
  await link.click();
  await waitTable(page);
  chk("sidebar link lands on /balance-control", (await page.evaluate(() => location.pathname)).startsWith("/balance-control"));
  chk("page states it is read-only / not saved", /not saved/i.test(await page.locator("main").innerText()));
  await page.getByRole("link", { name: "Financial Audit" }).first().click();
  await page.getByRole("heading", { name: "Financial Audit" }).waitFor();
  chk("Balance Control → Financial Audit link works", (await page.evaluate(() => location.pathname)).startsWith("/financial-audit"));
  await page.locator('[data-testid="balance-checks"]').waitFor();
  chk("Financial Audit shows the definition checks section", await page.locator('[data-testid="balance-checks"]').isVisible());
  await page.getByRole("link", { name: "Balance Control" }).first().click();
  await waitTable(page);
  chk("sidebar from Financial Audit → Balance Control works", (await page.evaluate(() => location.pathname)).startsWith("/balance-control"));
});

/* ───────────────────────────── 2. viewports + interactions ───────────────────────────── */
for (const [name, vp] of Object.entries(VPS)) {
  for (const scheme of name === "laptop1366" || name === "tablet" ? ["light"] : ["light", "dark"]) {
    scenario(`bc-view-${name}-${scheme}`, `Balance Control layout and interactions: ${name} ${vp.width}x${vp.height}, ${scheme}`, async ({ page }, chk) => {
      await h.addFixture(page, "card-emi").catch(() => {});
      await page.setViewportSize(vp);
      await goTo(page, "/balance-control");
      await waitTable(page);
      const names = await productNames(page);
      chk("selector lists cards, loans and EMIs", names.length >= 5, names.join(" | "));
      const o0 = await overflow(page);
      chk("no page-level horizontal overflow", o0.doc <= 1 && (o0.main ?? 0) <= 1, JSON.stringify(o0));

      // Card: type into every row
      const cardName = names.find((n) => /4242|QA Credit Card/.test(n));
      await select(page, cardName);
      const ff = { creditLimit: await flowfi(page, "creditLimit"), out: await flowfi(page, "totalOutstanding"), avail: await flowfi(page, "availableCredit") };
      chk("card rows carry numbers (limit, outstanding, available)", ff.creditLimit > 0 && ff.out >= 0 && ff.avail >= 0, JSON.stringify(ff));
      await type(page, "totalOutstanding", ff.out + 18);
      const dText = await row(page, "totalOutstanding").locator('[data-testid="difference"]').innerText();
      const cls = await row(page, "totalOutstanding").locator('[data-testid="variance-class"]').innerText();
      chk("difference is bank − FlowFi (+₹18.00)", close(money(dText.replace("+", "")), 18), dText);
      chk("classification 'Bank higher'", /Bank higher/.test(cls), cls);
      await type(page, "creditLimit", ff.creditLimit + 10000);
      chk("limit difference classified 'Limit differs'", /Limit differs/.test(await row(page, "creditLimit").locator('[data-testid="variance-class"]').innerText()));
      await type(page, "availableCredit", ff.avail + 0.4);
      chk("₹0.40 gap classified 'Rounding'", /Rounding/.test(await row(page, "availableCredit").locator('[data-testid="variance-class"]').innerText()));
      await type(page, "creditLimit", "abc");
      chk("non-numeric input shows 'Enter a number' and no difference", /Enter a number/.test(await row(page, "creditLimit").innerText()) && (await row(page, "creditLimit").locator('[data-testid="difference"]').innerText()) === "—");
      await type(page, "creditLimit", ff.creditLimit + 10000);
      const preview = page.locator('[data-testid="impact-preview"]');
      chk("impact preview appears for a real gap", await preview.isVisible());
      const pv = await preview.innerText();
      chk("preview says nothing is changed", /Nothing is changed/.test(pv));
      chk("limit/outstanding preview lists areas", /Available credit/.test(pv) && /Left untouched/.test(pv));

      // Overflow of cells (clipped figures)
      const clipped = await page.evaluate(() => [...document.querySelectorAll('[data-testid="variance-table"] [role="cell"]')].filter((td) => td.scrollWidth > td.clientWidth + 1).length);
      chk("no clipped cells", clipped === 0, clipped);
      const o1 = await overflow(page);
      chk("no page-level overflow after typing", o1.doc <= 1 && (o1.main ?? 0) <= 1, JSON.stringify(o1));
      const wrapper = await page.locator('[data-testid="variance-table"]').evaluate((t) => { const w = t.parentElement; return { scroll: w.scrollWidth - w.clientWidth, table: t.getBoundingClientRect().width, view: window.innerWidth }; });
      chk.finding("BC-UI-1", `${name}: the table fits without an inner horizontal scroll`, wrapper.scroll <= 1, JSON.stringify(wrapper));
      await page.evaluate(() => { document.querySelector("main").scrollTop = 0; window.scrollTo(0, 0); (document.activeElement)?.blur?.(); });
      await page.waitForTimeout(300);
      await h.shot(page, `bc-${name}-${scheme}-card`);

      // loan + EMI + lender payoff
      const loanName = names.find((n) => /QA Loan 12/.test(n));
      await select(page, loanName);
      const lp = await flowfi(page, "loanPrincipal");
      const pf = await flowfi(page, "lenderPayoff");
      chk("loan payoff floor equals remaining principal", close(lp, pf), `${lp} vs ${pf}`);
      await type(page, "lenderPayoff", pf + 1250);
      chk("payoff above principal → 'Interest & charges'", /Interest & charges/.test(await row(page, "lenderPayoff").locator('[data-testid="variance-class"]').innerText()));
      await type(page, "lenderPayoff", pf - 1000);
      chk("payoff below principal → 'Below principal'", /Below principal/.test(await row(page, "lenderPayoff").locator('[data-testid="variance-class"]').innerText()));
      await type(page, "loanPrincipal", lp + 500);
      chk("principal gap → 'Bank higher'", /Bank higher/.test(await row(page, "loanPrincipal").locator('[data-testid="variance-class"]').innerText()));
      await h.shot(page, `bc-${name}-${scheme}-loan`);
      const emiName = names.find((n) => /QA Phone EMI/.test(n));
      await select(page, emiName);
      chk("EMI product offers remaining principal + payoff", (await row(page, "emiPrincipal").count()) === 1 && (await row(page, "lenderPayoff").count()) === 1);
      chk("switching product clears neither stored value nor shows stale numbers", (await row(page, "emiPrincipal").locator('[data-testid="bank-input"]').inputValue()) === "");
      // typed value persists per product while switching back (component state)
      await select(page, loanName);
      chk("typed value for a product is kept while switching within the page", (await row(page, "loanPrincipal").locator('[data-testid="bank-input"]').inputValue()) === String(lp + 500));
    }, { viewport: vp, scheme });
  }
}

/* ───────────────────────────── 3. financial definitions vs stored documents ───────────────────────────── */
scenario("bc-definitions", "Balance Control values come from the canonical sources (stored docs, Credit Cards page, loan/EMI schedules)", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  await goTo(page, "/balance-control");
  await waitTable(page);
  const names = await productNames(page);

  // Plain card: ₹12,000 purchase, limit ₹50,000
  const plain = await storedCard("4242");
  await select(page, names.find((n) => /4242|QA Credit Card/.test(n)));
  chk("limit = stored card limit", close(await flowfi(page, "creditLimit"), plain.card.creditLimit), `${await flowfi(page, "creditLimit")} vs ${plain.card.creditLimit}`);
  chk("total outstanding = charges − credits − payments from stored transactions", close(await flowfi(page, "totalOutstanding"), plain.outstanding), `${await flowfi(page, "totalOutstanding")} vs ${plain.outstanding}`);
  chk("available = limit − outstanding", close(await flowfi(page, "availableCredit"), plain.card.creditLimit - plain.outstanding), String(await flowfi(page, "availableCredit")));
  const sbText = await row(page, "statementBalance").locator('[data-testid="flowfi-value"]').innerText();
  const sbNote = await row(page, "statementBalance").innerText();
  chk("statement balance is a separate figure with its own scope note", /Statement ending|No closed statement/.test(sbNote), `${sbText} | ${sbNote.replace(/\n/g, " ")}`);

  // Card-linked EMI (Case B): locks its principal
  const emiCard = await storedCard("9090");
  const emi = (await h.list("emis")).find((e) => e.name === "QA Card EMI");
  await select(page, names.find((n) => /9090|QA EMI Card/.test(n)));
  const out = await flowfi(page, "totalOutstanding");
  const avail = await flowfi(page, "availableCredit");
  chk("card with linked EMI: total outstanding includes the locked ₹12,000 EMI principal", close(out, emiCard.outstanding + emi.principalAmount), `${out} vs ${emiCard.outstanding}+${emi.principalAmount}`);
  chk("…and available credit subtracts it (50,000 − 12,000)", close(avail, emiCard.card.creditLimit - emiCard.outstanding - emi.principalAmount), String(avail));
  await type(page, "availableCredit", avail + 12000);
  chk("a bank that does not lock EMI principal is explained as 'Card-EMI lock', not as an error", /Card-EMI lock/.test(await row(page, "availableCredit").locator('[data-testid="variance-class"]').innerText()));
  await type(page, "totalOutstanding", out - 12000);
  chk("same for total outstanding", /Card-EMI lock/.test(await row(page, "totalOutstanding").locator('[data-testid="variance-class"]').innerText()));

  // Loan + EMI principal against schedules
  const loan = (await h.list("loans")).find((l) => l.name === "QA Loan 12");
  const inst = await h.list(`paymentSchedules/${loan.scheduleId}/installments`);
  const live = inst.filter((i) => !i.deletedAt);
  const paidPrincipal = live.reduce((s, i) => (i.amountPaid > 0 ? s + (i.principalPortion ?? i.amountDue) * Math.min(i.amountPaid / i.amountDue, 1) : s), 0);
  await select(page, names.find((n) => /QA Loan 12/.test(n)));
  chk("loan remaining principal = loan amount − principal paid (schedule)", close(await flowfi(page, "loanPrincipal"), loan.loanAmount - paidPrincipal, 0.01), `${await flowfi(page, "loanPrincipal")} vs ${loan.loanAmount - paidPrincipal}`);
  chk("lender payoff row labels FlowFi as a principal floor", /principal floor/i.test(await row(page, "lenderPayoff").innerText()));
  const phone = (await h.list("emis")).find((e) => e.name === "QA Phone EMI");
  const pinst = (await h.list(`paymentSchedules/${phone.scheduleId}/installments`)).filter((i) => !i.deletedAt);
  const ppaid = pinst.reduce((s, i) => (i.amountPaid > 0 ? s + (i.principalPortion ?? i.amountDue) * Math.min(i.amountPaid / i.amountDue, 1) : s), 0);
  await select(page, names.find((n) => /QA Phone EMI/.test(n)));
  chk("EMI remaining principal = principal − principal paid", close(await flowfi(page, "emiPrincipal"), phone.principalAmount - ppaid, 0.01), `${await flowfi(page, "emiPrincipal")} vs ${phone.principalAmount - ppaid}`);

  // Cross-check against the Credit Cards page's own figures (same canonical source, different screen)
  await goTo(page, "/credit-cards");
  await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
  await page.waitForTimeout(3000);
  const ccText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  chk("Credit Cards page shows the same ₹12,000 outstanding for the plain card", /12,000/.test(ccText), ccText.slice(0, 160));
});

/* ───────────────────────────── 4. shared limit ───────────────────────────── */
scenario("bc-shared-limit", "Shared limit: pooled facility limit and outstanding, one facility not double-counted", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  await makeSharedFacility(200000);
  await goTo(page, "/balance-control");
  await waitTable(page);
  const names = await productNames(page);
  const a = await storedCard("4242");
  const b = await storedCard("9090");
  const emi = (await h.list("emis")).find((e) => e.name === "QA Card EMI");
  for (const n of [names.find((x) => /4242|QA Credit Card/.test(x)), names.find((x) => /9090|QA EMI Card/.test(x))]) {
    await select(page, n);
    const note = await row(page, "creditLimit").innerText();
    chk(`${n}: limit is the pooled facility limit ₹2,00,000 (not the card's own ₹0/₹50,000)`, close(await flowfi(page, "creditLimit"), 200000) && /Pooled facility/.test(note), note.replace(/\n/g, " "));
    chk(`${n}: outstanding pooled across both cards (+ locked EMI principal)`, close(await flowfi(page, "totalOutstanding"), a.outstanding + b.outstanding + emi.principalAmount), String(await flowfi(page, "totalOutstanding")));
    chk(`${n}: available = pooled limit − pooled outstanding − locked`, close(await flowfi(page, "availableCredit"), 200000 - a.outstanding - b.outstanding - emi.principalAmount), String(await flowfi(page, "availableCredit")));
  }
  await h.shot(page, "bc-shared-limit");
  await goTo(page, "/financial-audit");
  await page.locator('[data-testid="balance-checks"]').waitFor();
  await page.waitForTimeout(3000);
  const text = await page.locator('[data-testid="balance-checks"]').innerText();
  chk("audit: no 'confirmed' limit/EMI/lock inconsistency for a healthy shared facility", !/Confirmed[\s\S]{0,120}(Available credit is not|Cards on one shared limit|Locked card-EMI)/.test(text), text.slice(0, 300).replace(/\n/g, " "));
  chk("audit explains the ignored own limit rather than flagging it", /ignored while it shares a facility|Explained/.test(text) || !/Confirmed/.test(text));
  await h.shot(page, "bc-audit-shared");
});

/* ───────────────────────────── 4b. credit-limit correction (the one live write) ───────────────────────────── */
scenario("bc-limit-correction", "Credit-limit correction: sheet pre-fill, apply, history, reversal — on a standalone card and a shared facility", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  await makeSharedFacility(200000);
  await goTo(page, "/balance-control");
  await waitTable(page);
  const names = await productNames(page);

  // Standalone card.
  const plainName = names.find((n) => /4242|QA Credit Card/.test(n));
  await select(page, plainName);
  const originalLimit = await flowfi(page, "creditLimit");
  await type(page, "creditLimit", originalLimit + 10000);
  const correctBtn = row(page, "creditLimit").locator('[data-testid="correct-limit-button"]');
  chk("Correct button appears once a real limit gap is typed", await correctBtn.isVisible());
  await correctBtn.click();
  const sheet = page.locator('[data-testid="limit-correction-sheet"]');
  await sheet.waitFor();
  chk("sheet pre-fills the bank figure already typed in the row", await sheet.locator('[data-testid="correction-new-value"]').inputValue(), String(originalLimit + 10000));
  chk("Apply is disabled before a reason is chosen", await sheet.locator('[data-testid="correction-apply"]').isDisabled());
  await sheet.locator('[data-testid="correction-reason-bankIncreased"]').click();
  await sheet.locator('[data-testid="correction-note"]').fill("SMS from bank, 12 Oct");
  chk("Apply enables once the form validates", !(await sheet.locator('[data-testid="correction-apply"]').isDisabled()));
  const previewText = (await sheet.locator('[data-testid="correction-preview"]').innerText()).replace(/,/g, "");
  chk("before/after preview shows old and new limit", previewText.includes(String(originalLimit)) && previewText.includes(String(originalLimit + 10000)), previewText.replace(/\n/g, " "));
  await sheet.locator('[data-testid="correction-apply"]').click();
  await sheet.waitFor({ state: "hidden" });
  await page.waitForTimeout(500);
  chk("toast confirms the correction", /Credit limit corrected/.test(await page.evaluate(() => document.body.innerText)));
  chk("FlowFi's own figure now reflects the bank's limit", close(await flowfi(page, "creditLimit"), originalLimit + 10000), String(await flowfi(page, "creditLimit")));
  chk("bank input is cleared after a successful correction (nothing left to compare)", (await row(page, "creditLimit").locator('[data-testid="bank-input"]').inputValue()) === "");
  await h.shot(page, "bc-correction-applied");

  // History + reversal.
  await row(page, "creditLimit").locator('[data-testid="limit-history-button"]').click();
  const history = page.locator('[data-testid="limit-correction-history-sheet"]');
  await history.waitFor();
  const entry = history.locator('[data-testid="history-entry"]').first();
  await entry.waitFor();
  chk("one correction entry recorded, with its reason and note", /Bank increased/.test(await entry.innerText()) && /SMS from bank/.test(await entry.innerText()));
  await h.shot(page, "bc-correction-history");
  await entry.locator('[data-testid="reverse-correction-button"]').click();
  await page.waitForFunction(() => /Reversed/.test(document.querySelector('[data-testid="history-entry"]')?.textContent ?? ""), null, { timeout: 15000 });
  chk("reversed entry is marked and loses its Reverse button", (await entry.locator('[data-testid="reverse-correction-button"]').count()) === 0);
  await page.keyboard.press("Escape");
  await history.waitFor({ state: "hidden" });
  await page.waitForTimeout(500);
  chk("reversing restores FlowFi's original limit", close(await flowfi(page, "creditLimit"), originalLimit), String(await flowfi(page, "creditLimit")));

  // Shared facility: one correction moves every member card's pooled limit.
  const facilityCardA = names.find((n) => /4242|QA Credit Card/.test(n));
  const facilityCardB = names.find((n) => /9090|QA EMI Card/.test(n));
  await select(page, facilityCardA);
  const pooled = await flowfi(page, "creditLimit");
  chk("facility card shows the pooled ₹2,00,000 limit before correction", close(pooled, 200000), String(pooled));
  await type(page, "creditLimit", pooled + 25000);
  await row(page, "creditLimit").locator('[data-testid="correct-limit-button"]').click();
  await sheet.waitFor();
  await sheet.locator('[data-testid="correction-reason-bankIncreased"]').click();
  await sheet.locator('[data-testid="correction-apply"]').click();
  await sheet.waitFor({ state: "hidden" });
  await page.waitForTimeout(500);
  chk("facility card A reflects the corrected pooled limit", close(await flowfi(page, "creditLimit"), pooled + 25000), String(await flowfi(page, "creditLimit")));
  await select(page, facilityCardB);
  chk("facility card B (the OTHER member) reflects the same corrected pooled limit — one write, both cards updated", close(await flowfi(page, "creditLimit"), pooled + 25000), String(await flowfi(page, "creditLimit")));

  // Idempotency / safety: Correct never appears when there's nothing to correct.
  await type(page, "creditLimit", pooled + 25000);
  chk("no Correct button once the typed figure matches FlowFi's (nothing to fix)", (await row(page, "creditLimit").locator('[data-testid="correct-limit-button"]').count()) === 0);
});

/* ───────────────────────────── 5. read-only safety ───────────────────────────── */
scenario("bc-readonly", "Typing bank figures, switching products, opening the audit and reloading write nothing and persist nothing", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  await makeSharedFacility(200000);
  const before = await snapshot();
  const writes = watchWrites(page);
  await goTo(page, "/balance-control");
  await waitTable(page);
  const names = await productNames(page);
  for (const n of names) {
    await select(page, n);
    for (const metric of ["creditLimit", "totalOutstanding", "statementBalance", "availableCredit", "loanPrincipal", "emiPrincipal", "lenderPayoff"]) {
      if ((await row(page, metric).count()) > 0) await type(page, metric, 12345.67);
    }
  }
  await goTo(page, "/financial-audit");
  await page.locator('[data-testid="balance-checks"]').waitFor();
  await page.waitForTimeout(2500);
  await goTo(page, "/balance-control");
  await waitTable(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitTable(page);
  const values = await page.locator('[data-testid="bank-input"]').evaluateAll((els) => els.map((e) => e.value));
  chk("after reload every bank input is empty (nothing persisted)", values.every((v) => v === ""), values.join(","));
  const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  chk("no typed figure sits in local/session storage", !/12345/.test(ls));
  await page.waitForTimeout(2500);
  const after = await snapshot();
  const changed = diff(before, after);
  chk("every financial collection is byte-identical before/after (accounts, transactions, loans, EMIs, cards, facilities, People, installments, ledgers)", changed.length === 0, changed.join(", "));
  chk("no Firestore write request was issued by the page", writes.length === 0, writes.join(" ; "));
});

/* ───────────────────────────── 6. performance on a large history ───────────────────────────── */
scenario("bc-performance", "Large synthetic history (2,000 card transactions): load time, typing latency, long tasks, no write", async ({ page }, chk) => {
  const cards = await h.list("creditCards");
  const card = cards.find((c) => c.lastFourDigits === "4242");
  const uid = await h.authUid();
  const cat = (await h.list("transactions"))[0].categoryId;
  const N = 2000;
  let total = 0;
  const jobs = [];
  for (let i = 0; i < N; i++) {
    const amt = 100 + (i % 37);
    total += amt;
    const when = new Date(Date.now() - (i % 400) * 86400000);
    jobs.push({ id: `perf-${i}`, fields: { type: { stringValue: "expense" }, amount: { doubleValue: amt }, dateTime: ts(when), accountId: { stringValue: card.accountId }, categoryId: { stringValue: cat }, description: { stringValue: `perf ${i}` }, notes: { stringValue: "" }, createdAt: ts(when), deletedAt: { nullValue: null }, excludeFromCalculations: { booleanValue: false }, isPersonLedgerMovement: { booleanValue: false } } });
  }
  for (let i = 0; i < jobs.length; i += 25) await Promise.all(jobs.slice(i, i + 25).map((j) => rest("PATCH", `users/${uid}/transactions/${j.id}`, { fields: j.fields })));
  const acct = (await h.list("accounts")).find((a) => a.id === card.accountId);
  await h.patchNumber(`accounts/${acct.id}`, "currentBalance", acct.currentBalance - total);

  const before = await snapshot();
  const writes = watchWrites(page);
  await page.evaluate(() => { window.__long = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ entryTypes: ["longtask"] }); } catch {} });
  const lt = async () => { const v = await page.evaluate(() => window.__long.slice()); await page.evaluate(() => { window.__long = []; }); return v; };
  // Cold visit (dev server compiles the route + data loads), then away, then a WARM visit — the fair comparison with pages the warm-up already compiled.
  const t0 = Date.now();
  await goTo(page, "/balance-control");
  await waitTable(page);
  const names = await productNames(page);
  await select(page, names.find((n) => /4242|QA Credit Card/.test(n)));
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(3000);
  const coldLong = await lt();
  await goTo(page, "/accounts");
  await page.waitForTimeout(3000);
  await lt();
  await goTo(page, "/balance-control");
  await waitTable(page);
  await page.waitForTimeout(4000);
  const long = await lt();
  const stored = await storedCard("4242");
  chk("outstanding is correct on a 2,001-transaction card", close(await flowfi(page, "totalOutstanding"), stored.outstanding), `${await flowfi(page, "totalOutstanding")} vs ${stored.outstanding}`);
  chk(`page usable in a reasonable time (${loadMs} ms cold, including route compile + data)`, loadMs < 45000);
  const probe = (sel) => page.evaluate(async (selector) => {
    const el = document.querySelector(selector);
    el.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const lat = [];
    for (const v of "123456789012".split("")) {
      const s0 = performance.now();
      set.call(el, (el.value ?? "") + v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      lat.push(performance.now() - s0);
    }
    return { max: Math.round(Math.max(...lat)), avg: Math.round(lat.reduce((x, y) => x + y, 0) / lat.length) };
  }, sel);
  const typeMs = await probe('[data-testid="variance-row-totalOutstanding"] [data-testid="bank-input"]');
  const typeLong = await lt();
  chk(`typing: bank input avg ${typeMs.avg} ms / max ${typeMs.max} ms per keystroke (incl. 2 frames); long tasks while typing ${JSON.stringify(typeLong)}`, typeMs.avg < 150 && typeLong.every((d) => d < 200), JSON.stringify({ typeMs, typeLong }));
  chk.finding("BC-PERF-1", `no main-thread long task above 500 ms on a WARM load (warm ${JSON.stringify(long)}; cold ${JSON.stringify(coldLong)})`, long.every((d) => d < 500), JSON.stringify({ long, coldLong }));
  await goTo(page, "/financial-audit");
  await page.locator('[data-testid="balance-checks"]').waitFor();
  await page.waitForTimeout(4000);
  const text = await page.locator('[data-testid="balance-checks"]').innerText();
  chk("audit on the large history: no confirmed engine/ledger disagreement", !/Derived outstanding disagrees|Stored card balance disagrees/.test(text), text.slice(0, 200).replace(/\n/g, " "));
  // P0 pages only: writes + stored data checked HERE, before any pre-existing page is visited.
  const writesP0 = writes.slice();
  const changedP0 = diff(before, await snapshot());
  chk("Balance Control + Financial Audit on the large history write nothing", changedP0.length === 0 && writesP0.length === 0, `${changedP0.join(",")} writes=${writesP0.length} ${writesP0.join(";")}`);
  await h.shot(page, "bc-perf-audit");
  // Baselines on the SAME data: pre-existing pages (their own behaviour, reported for attribution only).
  await lt();
  await goTo(page, "/credit-cards");
  await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
  await page.waitForTimeout(5000);
  const baseline = await lt();
  await goTo(page, "/dashboard");
  await page.waitForTimeout(6000);
  const dashLong = await lt();
  chk(`long tasks on the same data — Balance Control warm: ${JSON.stringify(long)}; Credit Cards: ${JSON.stringify(baseline)}; Dashboard: ${JSON.stringify(dashLong)}`, true);
  chk(`pre-existing pages issued ${writes.length - writesP0.length} write request(s) while browsed (informational; not Balance Control): ${writes.slice(writesP0.length).join(";")}`, true);
});

/* ───────────────────────────── 7. empty / error / loading ───────────────────────────── */
scenario("bc-empty-wipe", "All cards, loans and EMIs removed (emulator): empty message, audit section still renders", async ({ page }, chk) => {
  const uid = await h.authUid();
  for (const coll of ["creditCards", "loans", "emis"]) for (const d of await h.list(coll)) await fetch(`${FIRESTORE_DOCS}/users/${uid}/${coll}/${d.id}`, { method: "DELETE", headers: OWNER });
  await goTo(page, "/balance-control");
  await page.getByRole("heading", { level: 1, name: "Balance Control" }).waitFor();
  await page.locator('[data-testid="balance-control-empty"]').waitFor({ timeout: 30000 });
  chk("empty-state message shown (server reachable, nothing returned)", await page.locator('[data-testid="balance-control-empty"]').isVisible());
  chk("neither the unreachable nor the error banner is shown for a genuinely empty account", (await page.locator('[data-testid="balance-control-unreachable"]').count()) === 0 && (await page.locator('[data-testid="balance-control-error"]').count()) === 0);
  chk("no comparison table rendered", (await page.locator('[data-testid="variance-table"]').count()) === 0);
  await h.shot(page, "bc-empty");
  await goTo(page, "/financial-audit");
  await page.locator('[data-testid="balance-checks"]').waitFor();
  chk("audit definition section renders without cards", /No findings|Reading/.test(await page.locator('[data-testid="balance-checks"]').innerText()));
});

const stateOf = (page) => page.evaluate(() => ({
  table: !!document.querySelector('[data-testid="variance-table"]'),
  loading: !!document.querySelector('[data-testid="balance-control-loading"]'),
  empty: !!document.querySelector('[data-testid="balance-control-empty"]'),
  error: !!document.querySelector('[data-testid="balance-control-error"]'),
  unreachable: !!document.querySelector('[data-testid="balance-control-unreachable"]'),
}));

scenario("bc-offline", "Firestore unreachable: a 'could not reach the server' warning, never the empty-account message", async ({ page, ctx }, chk) => {
  // Only the Firestore emulator is cut off; the app server stays reachable, so this is a data-unreachable (not app-unreachable) test.
  await ctx.route((url) => url.hostname === "127.0.0.1" && String(url.port) === process.env.QA_FIRESTORE_PORT, (r) => r.abort());
  await page.goto(`${BASE_URL}/balance-control`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Balance Control" }).waitFor({ timeout: 60000 });
  const early = await stateOf(page);
  chk("while the server has not answered, the empty-account message is never shown", !early.empty, JSON.stringify(early));
  await page.locator('[data-testid="balance-control-unreachable"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(5000);
  const txt = await page.locator("main").innerText();
  chk("header and read-only notice stay visible", /Balance Control/.test(txt) && /not saved/i.test(txt));
  const st = await stateOf(page);
  chk("unreachable warning shown and says this does not mean the account is empty", st.unreachable && /does not mean your account is empty/i.test(txt), JSON.stringify(st));
  chk("empty-account message NOT shown while unreachable", !st.empty && !st.table, JSON.stringify(st));
  chk.finding("BC-STATE-1", "a permanently unreachable backend is distinguishable from an empty account", st.unreachable && !st.empty, JSON.stringify(st));
  await h.shot(page, "bc-offline");
});

/* Controlled permission-denied: the EMULATOR's rules are swapped (never production's) so every read is refused, then restored. */
async function setRules(content) {
  const r = await fetch(`http://${HOST}:${PORTS.firestore}/emulator/v1/projects/${PROJECT_ID}:securityRules`, { method: "PUT", body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }) });
  if (!r.ok) throw new Error(`setRules: ${r.status} ${await r.text()}`);
}
const DENY_READS = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }`;
const ALLOW_ALL = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if request.auth != null; } } }`;

scenario("bc-denied", "Permission-denied reads (emulator rules): the error banner shows, not the empty-account message; nothing is written", async ({ page }, chk) => {
  const writes = watchWrites(page);
  const before = await snapshot();
  try {
    await setRules(DENY_READS);
    await page.goto(`${BASE_URL}/balance-control`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: "Balance Control" }).waitFor({ timeout: 60000 });
    await page.locator('[data-testid="balance-control-error"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(5000);
    const st = await stateOf(page);
    chk("error banner is visible", st.error, JSON.stringify(st));
    chk("error banner tells the user the figures may be incomplete", /may be incomplete/i.test(await page.locator('[data-testid="balance-control-error"]').innerText()));
    chk("empty-account message NOT shown", !st.empty && !st.table, JSON.stringify(st));
    chk("a refused read is not reported as an unreachable server", !st.unreachable, JSON.stringify(st));
    await h.shot(page, "bc-denied");
  } finally {
    await setRules(ALLOW_ALL);
  }
  const changed = diff(before, await snapshot());
  chk("nothing was written (stored data identical, no write requests)", changed.length === 0 && writes.length === 0, `${changed.join(",")} writes=${writes.length}`);
});

/* ───────────────────────────── 8. closed statement vs total outstanding vs locked card-EMI principal ───────────────────────────── */
scenario("bc-statement", "A persisted closed statement: statement balance stays separate from total outstanding and from locked card-EMI principal", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi").catch(() => {});
  const DAY = 86400000;
  const uid = await h.authUid();
  const card = (await h.list("creditCards")).find((c) => c.lastFourDigits === "9090");
  const acct = (await h.list("accounts")).find((a) => a.id === card.accountId);
  const start = new Date(Date.now() - 70 * DAY), end = new Date(Date.now() - 40 * DAY), due = new Date(Date.now() - 30 * DAY);
  const cat = (await h.list("transactions"))[0].categoryId;
  const when = new Date(Date.now() - 55 * DAY);
  // TEST SETUP (emulator only): one known purchase inside the statement window, and the closed statement that covers it.
  await rest("PATCH", `users/${uid}/transactions/stmt-spend-1`, { fields: { type: { stringValue: "expense" }, amount: { doubleValue: 4321 }, dateTime: ts(when), accountId: { stringValue: card.accountId }, categoryId: { stringValue: cat }, description: { stringValue: "statement spend" }, notes: { stringValue: "" }, createdAt: ts(when), deletedAt: { nullValue: null }, excludeFromCalculations: { booleanValue: false }, isPersonLedgerMovement: { booleanValue: false } } });
  await h.patchNumber(`accounts/${acct.id}`, "currentBalance", acct.currentBalance - 4321);
  await rest("PATCH", `users/${uid}/creditCards/${card.id}/statements/qa-stmt-1`, { fields: { cardId: { stringValue: card.id }, periodStart: ts(start), periodEnd: ts(end), generatedDate: ts(end), dueDate: ts(due), totalAmount: { doubleValue: 4321 }, minimumDue: { nullValue: null }, amountPaid: { doubleValue: 0 }, interestCharged: { nullValue: null }, lateFee: { nullValue: null }, createdAt: ts(end), deletedAt: { nullValue: null }, lastEditedAt: { nullValue: null }, editHistory: { arrayValue: { values: [] } } } });

  // Independent expectation straight from stored documents.
  const inWindow = (t) => { const d = new Date(t.dateTime).getTime(); return d >= start.getTime() && d <= end.getTime() + DAY - 1; };
  const txns = (await h.list("transactions")).filter((t) => t.accountId === card.accountId && !t.deletedAt && !t.excludeFromCalculations && !t.transferId);
  const expectedStatement = txns.filter(inWindow).reduce((s, t) => s + (t.type === "income" ? -t.amount : t.amount), 0);
  const stored = await storedCard("9090");
  const stmtsBefore = JSON.stringify(await h.list(`creditCards/${card.id}/statements`));
  const before = await snapshot();
  const writes = watchWrites(page);

  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, (await productNames(page)).find((n) => /9090|QA EMI Card/.test(n)));
  const stmt = await flowfi(page, "statementBalance");
  const total = await flowfi(page, "totalOutstanding");
  const limit = await flowfi(page, "creditLimit");
  const avail = await flowfi(page, "availableCredit");
  const lock = total - stored.outstanding;
  chk(`statement balance is the closed statement's live total (${stmt} vs stored ${expectedStatement})`, close(stmt, expectedStatement) && stmt >= 4321, `${stmt} vs ${expectedStatement}`);
  chk("statement note says which statement it is", /Statement ending/.test(await row(page, "statementBalance").innerText()));
  chk(`statement balance (${stmt}) differs from total outstanding (${total}) — they are separate figures`, !close(stmt, total));
  chk(`card-EMI locked principal (${lock}) is inside total outstanding, not inside the statement balance`, lock > 0.005 && close(limit - avail, total), `limit ${limit} avail ${avail} total ${total} stored ${stored.outstanding}`);
  chk("total outstanding note names the card-EMI principal", /card-EMI principal/.test(await row(page, "totalOutstanding").innerText()));
  // Typing the statement figure into each row: it matches only its own row.
  await type(page, "statementBalance", stmt);
  await type(page, "totalOutstanding", stmt);
  chk("a bank statement figure equal to FlowFi's statement balance matches there", /Matches/.test(await row(page, "statementBalance").locator('[data-testid="variance-class"]').innerText()));
  chk("the same figure typed as total outstanding is NOT a match (statement ≠ outstanding)", !/Matches/.test(await row(page, "totalOutstanding").locator('[data-testid="variance-class"]').innerText()));
  await type(page, "totalOutstanding", stored.outstanding);
  chk(`a bank total without the EMI lock (${stored.outstanding}) is explained as the card-EMI lock, not an error`, /Card-EMI lock/.test(await row(page, "totalOutstanding").locator('[data-testid="variance-class"]').innerText()));
  await h.shot(page, "bc-statement");
  await page.waitForTimeout(1500);
  chk("nothing was written (collections and the statement identical, no write requests)", diff(before, await snapshot()).length === 0 && JSON.stringify(await h.list(`creditCards/${card.id}/statements`)) === stmtsBefore && writes.length === 0, writes.join(";"));
});

/* ───────────────────────────── 9. mobile header ───────────────────────────── */
scenario("bc-header-390", "At 390px the shield icon stays beside the first line of the read-only notice and nothing overflows", async ({ page }, chk) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goTo(page, "/balance-control");
  await page.getByRole("heading", { level: 1, name: "Balance Control" }).waitFor();
  const g = await page.evaluate(() => {
    const p = [...document.querySelectorAll("main p")].find((n) => /not saved/i.test(n.textContent ?? ""));
    const icon = p.querySelector("svg").getBoundingClientRect();
    const text = p.querySelector("span");
    const r = document.createRange(); r.selectNodeContents(text);
    const rects = [...r.getClientRects()];
    const lh = parseFloat(getComputedStyle(text).lineHeight);
    return { iconTop: icon.top, iconBottom: icon.bottom, iconRight: icon.right, iconW: icon.width, textLeft: Math.min(...rects.map((x) => x.left)), firstTop: Math.min(...rects.map((x) => x.top)), lines: new Set(rects.map((x) => Math.round(x.top))).size, lh };
  });
  chk("icon keeps its size (not squeezed)", g.iconW >= 15, JSON.stringify(g));
  chk("icon sits at the first line, not centred on a multi-line block", g.iconTop >= g.firstTop - 2 && g.iconBottom <= g.firstTop + g.lh + 2, JSON.stringify(g));
  chk("text starts to the right of the icon on every line", g.textLeft >= g.iconRight - 1, JSON.stringify(g));
  const o = await overflow(page);
  chk("no horizontal overflow", o.doc <= 1 && (o.main ?? 0) <= 1, JSON.stringify(o));
  await h.shot(page, "bc-header-390");
});

/* ───────────────────────────── 10. outstanding / available-credit reconciliation guide ───────────────────────────── */
scenario("bc-reconcile", "Outstanding reconciliation: cause list, existing-transaction display, correct resolution per cause, never a write", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  await makeSharedFacility(200000);
  const before = await snapshot();
  const writes = watchWrites(page);
  await goTo(page, "/balance-control");
  await waitTable(page);
  const names = await productNames(page);

  // Plain card, bank reports MORE outstanding (missing charge direction).
  const plainName = names.find((n) => /4242|QA Credit Card/.test(n));
  await select(page, plainName);
  const out = await flowfi(page, "totalOutstanding");
  await type(page, "totalOutstanding", out + 700);
  const reconcileBtn = row(page, "totalOutstanding").locator('[data-testid="reconcile-button"]');
  chk("Reconcile button appears for a real outstanding gap", await reconcileBtn.isVisible());
  await reconcileBtn.click();
  const sheet = page.locator('[data-testid="outstanding-reconciliation-sheet"]');
  await sheet.waitFor();
  chk("shows FlowFi, bank and the difference", /700/.test(await sheet.locator('[data-testid="reconcile-difference"]').innerText()));
  const causes = await sheet.locator('[data-testid="cause-list"] button').allInnerTexts();
  chk("bank-higher gap offers charge-side causes (missing purchase, interest, GST, late fee)", causes.some((c) => /Missing purchase/.test(c)) && causes.some((c) => /Interest charge/.test(c)) && causes.some((c) => /GST/.test(c)) && causes.some((c) => /Late fee/.test(c)));
  chk("bank-higher gap does NOT offer missing-payment or refund causes", !causes.some((c) => /Missing payment/.test(c)) && !causes.some((c) => /Refund or credit/.test(c)));

  await sheet.locator('[data-testid="cause-missingPurchase"]').click();
  const addExpenseLink = sheet.locator('[data-testid="resolution-link-add-expense"]');
  await addExpenseLink.waitFor();
  const href = await addExpenseLink.getAttribute("href");
  chk("missing-purchase links to Transactions filtered to this card's account", href != null && /^\/transactions\/?\?account=/.test(href), href);
  chk("impact preview lists the modules a recorded charge would move", /Total outstanding/.test(await sheet.locator('[data-testid="reconcile-impact-preview"]').innerText()));
  await h.shot(page, "bc-reconcile-missing-purchase");

  // Missing payment direction — bank reports LESS outstanding.
  await sheet.locator('[data-testid="cause-unknown"]').click(); // deselect-ish: switch cause before closing
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await type(page, "totalOutstanding", Math.max(0, out - 500));
  await row(page, "totalOutstanding").locator('[data-testid="reconcile-button"]').click();
  await sheet.waitFor();
  const causes2 = await sheet.locator('[data-testid="cause-list"] button').allInnerTexts();
  chk("bank-lower gap offers missing-payment and refund causes, not charge causes", causes2.some((c) => /Missing payment/.test(c)) && causes2.some((c) => /Refund or credit/.test(c)) && !causes2.some((c) => /Missing purchase/.test(c)));
  await sheet.locator('[data-testid="cause-missingPayment"]').click();
  const payBillLink = sheet.locator('[data-testid="resolution-link-pay-bill"]');
  await payBillLink.waitFor();
  const payHref = await payBillLink.getAttribute("href");
  chk("missing-payment links to Pay bill (?card=&pay=1), never the expense flow", payHref != null && /^\/credit-cards\/?\?card=.+&pay=1/.test(payHref), payHref);
  chk("missing-payment resolution never shows an Add Expense link", (await sheet.locator('[data-testid="resolution-link-add-expense"]').count()) === 0);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });

  // Card-linked EMI card: the card-EMI cause is explained with no action implied. A gap of EXACTLY the locked
  // EMI principal (₹12,000) is already classified "Card-EMI lock" by the existing variance engine (no Reconcile
  // button needed — it's already explained), so use a different-sized gap to reach the reconciliation guide,
  // then pick the card-EMI cause there as the (still correct) explanation for THIS card.
  const emiCardName = names.find((n) => /9090|QA EMI Card/.test(n));
  await select(page, emiCardName);
  const emiAvail = await flowfi(page, "availableCredit");
  await type(page, "availableCredit", emiAvail + 8000);
  await row(page, "availableCredit").locator('[data-testid="reconcile-button"]').click();
  await sheet.waitFor();
  await sheet.locator('[data-testid="cause-cardEmiOrSharedLimit"]').click();
  const panelText = await sheet.locator('[data-testid="resolution-panel"]').innerText();
  chk("card-EMI lock cause is explained with no action for a card that actually has one", /Nothing is changed/.test(panelText));
  chk("explained cause offers no Add Expense / Pay bill link", (await sheet.locator('[data-testid="resolution-link-add-expense"]').count()) === 0 && (await sheet.locator('[data-testid="resolution-link-pay-bill"]').count()) === 0);
  await h.shot(page, "bc-reconcile-card-emi-explained");

  // Unknown/unexplained cause: review notice, nothing implied.
  await sheet.locator('[data-testid="cause-unknown"]').click();
  chk("unknown cause shows the manual-review notice", await sheet.locator('[data-testid="reconcile-review-notice"]').isVisible());
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });

  // No Reconcile button once the bank figure matches FlowFi's (nothing to reconcile).
  await type(page, "availableCredit", emiAvail);
  chk("no Reconcile button once the typed figure matches FlowFi's", (await row(page, "availableCredit").locator('[data-testid="reconcile-button"]').count()) === 0);

  // Still fully read-only: no write anywhere in this whole flow.
  await page.waitForTimeout(1500);
  const after = await snapshot();
  const changed = diff(before, after);
  chk("every financial collection is byte-identical before/after — the reconciliation guide writes nothing", changed.length === 0, changed.join(", "));
  chk("no Firestore write request was issued while using the reconciliation guide", writes.length === 0, writes.join(" ; "));
});

/* ───────────────────────────── 11. discoverability from Credit Cards ───────────────────────────── */
for (const [name, vp] of [["desktop", VPS.desktop1920], ["mobile", VPS.mobile]]) {
  scenario(`bc-cc-entry-${name}`, `Credit Cards → Balance Control: a visible "Manage Limits & Reconcile" entry point, not a hidden URL (${name})`, async ({ page }, chk) => {
    await h.addFixture(page, "card-emi");
    await makeSharedFacility(200000);
    await page.setViewportSize(vp);
    await goTo(page, "/credit-cards");
    await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
    await page.waitForTimeout(800); // cards + compact bar settle

    const link = page.locator('[data-testid="manage-limits-reconcile-link"]');
    chk("the entry point is visible on Credit Cards without opening any menu", await link.isVisible());
    const o = await overflow(page);
    chk("no horizontal overflow at this viewport", o.doc <= 1 && (o.main ?? 0) <= 1, JSON.stringify(o));

    await link.click();
    await waitTable(page);
    chk("clicking it lands on Balance Control", (await page.evaluate(() => location.pathname)).startsWith("/balance-control"));

    // The existing Correct and Reconcile actions are reachable straight from here, no typed URL involved.
    const names = await productNames(page);
    const plainName = names.find((n) => /4242|QA Credit Card/.test(n));
    await select(page, plainName);
    const limit = await flowfi(page, "creditLimit");
    await type(page, "creditLimit", limit + 10000);
    chk("Correct action is discoverable for a real limit gap", await row(page, "creditLimit").locator('[data-testid="correct-limit-button"]').isVisible());
    const out = await flowfi(page, "totalOutstanding");
    await type(page, "totalOutstanding", out + 500);
    chk("Reconcile action is discoverable for a real outstanding gap", await row(page, "totalOutstanding").locator('[data-testid="reconcile-button"]').isVisible());
    await h.shot(page, `bc-cc-entry-${name}`);
  });
}

/** `goTo` only waits on `location.pathname`, so a query string never "lands" by its check — navigate and wait on the full URL instead. */
const goToWithQuery = async (page, href) => {
  await page.evaluate((x) => window.next.router.push(x), href);
  for (let i = 0; i < 120; i++) {
    const url = await page.evaluate(() => location.pathname.replace(/\/+$/, "") + location.search);
    if (url === href) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`navigation to ${href} did not land`);
};

scenario("bc-deep-link", "Balance Control deep-link: ?product=card:<id> pre-selects that card, falling back safely otherwise", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  const cards = await h.list("creditCards");
  const plainCard = cards.find((c) => c.lastFourDigits === "4242");
  chk("fixture has the expected plain card", plainCard != null);

  await goToWithQuery(page, `/balance-control?product=card:${plainCard.id}`);
  await waitTable(page);
  const selected = await page.locator('[data-testid="product-select"]').inputValue();
  chk("deep-link pre-selects the requested card", selected === `card:${plainCard.id}`, selected);

  // An id that doesn't match anything (e.g. a stale link to a deleted card) must fall back, never crash or show nothing.
  await goToWithQuery(page, "/balance-control?product=card:does-not-exist");
  await waitTable(page);
  chk("an unmatched product id falls back to the first product instead of breaking the page", (await page.locator('[data-testid="product-select"]').inputValue()).length > 0);
});
