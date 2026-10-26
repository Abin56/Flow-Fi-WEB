/**
 * Smart Capture adaptive column layout — real-browser QA (geometry, not just markup), synthetic text only.
 *
 *   npm run test:e2e-qa -- scapcol- --copy
 *
 * Measures actual bounding boxes: header ↔ cell alignment, reading order, overlap, truncation, horizontal overflow,
 * sticky header, expand/collapse, Customize / Reset, the panel's fit on phones — and that none of it changes a
 * transaction value (compared before/after every layout operation and across viewport changes). Nothing is imported;
 * the emulator is checked for zero writes.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const PREF_KEY = "flowfi.smartCapture.columns.v1";

const TX = [
  { d: "05/09/2026", m: "AMAZON PAY INDIA", a: "1,24,999.00", dir: "Dr" },
  { d: "07/09/2026", m: "REFUND MYNTRA DESIGNS", a: "1,299.00", dir: "Cr" },
  { d: "10/09/2026", m: "SWIGGY", a: "452.00", dir: "Dr" },
  { d: "12/09/2026", m: "A VERY LONG MERCHANT NAME THAT KEEPS GOING AND GOING PRIVATE LIMITED BANGALORE KARNATAKA INDIA", a: "2,812.75", dir: "Dr" },
];
const word = (t) => (t.dir === "Cr" ? "Credit" : "Debit");
const letter = (t) => (t.dir === "Cr" ? "C" : "D");

/** id → { text, headers (what Auto must show), standard (no confirmed order) } */
const DATASETS = {
  "date-merchant-amount": { text: TX.map((t) => [t.d, t.m, `${t.a} ${t.dir}`].join("\t")), headers: ["Date", "Merchant", "Amount"] },
  "amount-date-merchant": { text: TX.map((t) => [`${t.a} ${t.dir}`, t.d, t.m].join("\t")), headers: ["Amount", "Date", "Merchant"] },
  "merchant-amount-date": { text: TX.map((t) => [t.m, `${t.a} ${t.dir}`, t.d].join("\t")), headers: ["Merchant", "Amount", "Date"] },
  "marker-before-amount": { text: TX.map((t) => [t.m, t.d, word(t), t.a].join("\t")), headers: ["Merchant", "Date", "Charge/Credit", "Amount"] },
  "marker-after-amount": { text: TX.map((t) => [t.d, t.m, t.a, letter(t)].join("\t")), headers: ["Date", "Merchant", "Amount", "Charge/Credit"] },
  "debit-credit": {
    text: ["Date\tNarration\tDebit\tCredit", ...TX.map((t) => (t.dir === "Cr" ? [t.d, t.m, "", t.a] : [t.d, t.m, t.a, ""]).join("\t"))],
    headers: ["Date", "Merchant", "Debit", "Credit"],
  },
  "ambiguous-columns": { text: TX.map((t) => `${t.m} ${t.d} ${t.a} ${t.dir}`), headers: null },
};
const ORDER = { Date: "date", Merchant: "merchant", Amount: "amount", "Charge/Credit": "direction", Debit: "debit", Credit: "credit" };

async function openCapture(page) {
  await page.evaluate(() => window.next.router.push("/smart-capture"));
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
}

async function paste(page, lines) {
  await page.evaluate((k) => sessionStorage.removeItem(k), PREF_KEY);
  if (await page.getByTestId("progress-ready").count()) await page.getByRole("button", { name: /^Back/ }).click();
  await page.getByLabel("Pasted statement text").fill(lines.join("\n"));
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByTestId("progress-ready").waitFor();
}

const reviewState = (page) =>
  page.getByTestId("review-row").evaluateAll((lis) =>
    lis.map((li) => ({
      id: li.dataset.rowId,
      date: li.dataset.date,
      amount: li.dataset.amount,
      paise: Math.round(Number(li.dataset.amount) * 100),
      dir: li.dataset.direction,
      status: li.dataset.status,
      included: li.querySelector('[role="checkbox"]')?.getAttribute("aria-checked"),
    })),
  );

const headerLabels = (page) => page.evaluate(() => [...document.querySelectorAll("[data-col-header]")].map((e) => e.textContent));

/** All geometry checks for the list as currently rendered. Returns problems (empty = clean) and metrics. */
function measure({ order, expectHeader }) {
  const R = (e) => e.getBoundingClientRect();
  const problems = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw) problems.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${vw})`);
  const list = document.querySelector('[data-testid="review-list"]');
  if (list.scrollWidth > list.clientWidth + 1) problems.push(`review-list overflows (${list.scrollWidth} > ${list.clientWidth})`);

  const header = document.querySelector('[data-testid="review-columns-header"]');
  const headerShown = !!header && getComputedStyle(header).display !== "none";
  if (headerShown !== expectHeader) problems.push(`header shown=${headerShown}, expected ${expectHeader}`);
  const hdr = {};
  if (headerShown) for (const e of header.querySelectorAll("[data-col-header]")) hdr[e.dataset.colHeader] = R(e);

  const metrics = { rows: 0, truncated: 0, header: Object.fromEntries(Object.entries(hdr).map(([k, r]) => [k, [Math.round(r.left), Math.round(r.width)]])) };
  for (const li of document.querySelectorAll('[data-testid="review-row"]')) {
    metrics.rows++;
    const id = li.dataset.rowId;
    if (li.scrollWidth > li.clientWidth + 1) problems.push(`row ${id}: li overflows (${li.scrollWidth} > ${li.clientWidth})`);
    const btn = li.querySelector("button[aria-expanded]");
    const b = R(btn);
    if (btn.scrollWidth > btn.clientWidth + 1) problems.push(`row ${id}: button content overflows (${btn.scrollWidth} > ${btn.clientWidth})`);
    const cells = [...btn.querySelectorAll("[data-col]")].map((e) => ({ c: e.dataset.col, r: R(e), e })).filter((x) => x.r.width > 0 && x.r.height > 0);
    for (const x of cells) {
      if (x.r.right > b.right + 1 || x.r.left < b.left - 1) problems.push(`row ${id}: ${x.c} cell outside its row (${Math.round(x.r.left)}–${Math.round(x.r.right)} vs ${Math.round(b.left)}–${Math.round(b.right)})`);
      if (x.r.right > vw + 1) problems.push(`row ${id}: ${x.c} cell beyond the viewport`);
    }
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const [p, q] = [cells[i].r, cells[j].r];
        if (Math.min(p.right, q.right) - Math.max(p.left, q.left) > 1 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 1) problems.push(`row ${id}: ${cells[i].c} overlaps ${cells[j].c}`);
      }
    // Reading order: each cell comes after the previous one (same line to its right, or on a later line).
    const byCol = Object.fromEntries(cells.map((x) => [x.c, x.r]));
    const present = order.filter((c) => byCol[c]);
    for (let i = 1; i < present.length; i++) {
      const [a, c] = [byCol[present[i - 1]], byCol[present[i]]];
      if (!(c.left >= a.right - 1 || c.top >= a.bottom - 1)) problems.push(`row ${id}: ${present[i]} is not after ${present[i - 1]}`);
    }
    if (headerShown) {
      for (const x of cells) {
        const hh = hdr[x.c];
        if (!hh) problems.push(`row ${id}: no header for ${x.c}`);
        else if (Math.abs(x.r.left - hh.left) > 1.5 || Math.abs(x.r.right - hh.right) > 1.5) problems.push(`row ${id}: ${x.c} misaligned with its header (cell ${Math.round(x.r.left)}–${Math.round(x.r.right)}, header ${Math.round(hh.left)}–${Math.round(hh.right)})`);
      }
    }
    const merchant = li.querySelector('[data-col="merchant"] .truncate');
    if (merchant && merchant.scrollWidth > merchant.clientWidth + 1) metrics.truncated++;
    const status = li.querySelector('[data-testid="row-status"]');
    if (status && R(status).right > R(li).right + 1) problems.push(`row ${id}: status outside row`);
  }
  return { problems, metrics };
}

const geometry = (page, order, expectHeader) => page.evaluate(measure, { order, expectHeader });

async function readCols(page, headers) {
  return headers ? headers.map((x) => ORDER[x]) : ["date", "merchant", "amount"];
}

/** `gridFor(columnCount)`: whether the list is expected to be wide enough for an aligned grid at this viewport. */
async function runDatasets(page, chk, notes, tag, { gridFor }) {
  for (const [id, ds] of Object.entries(DATASETS)) {
    await paste(page, ds.text);
    await page.waitForTimeout(250);
    const order = await readCols(page, ds.headers);
    if (ds.headers) {
      const grid = gridFor(order.length);
      const mode = await page.evaluate(() => document.querySelector('[data-testid="review-row"] button[aria-expanded]').dataset.layout);
      chk(`${tag} ${id}: ${grid ? "aligned grid" : "ordered flow (too narrow for a grid)"}`, mode === (grid ? "grid" : "flow"), mode);
      const cellOrder = await page.evaluate(() => [...document.querySelector('[data-testid="review-row"]').querySelectorAll("[data-col]")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.dataset.col));
      chk(`${tag} ${id}: Auto draws the source order (${ds.headers.join(" | ")})`, JSON.stringify(cellOrder) === JSON.stringify(order.filter((c) => cellOrder.includes(c))) && order.filter((c) => !cellOrder.includes(c)).every((c) => ["debit", "credit"].includes(c)), cellOrder.join(" | "));
      if (grid) {
        const labels = await headerLabels(page);
        chk(`${tag} ${id}: header strip reads ${ds.headers.join(" | ")}`, JSON.stringify(labels) === JSON.stringify(ds.headers), labels.join(" | "));
      }
      const { problems, metrics } = await geometry(page, order, grid);
      chk(`${tag} ${id}: alignment / order / overlap / overflow clean`, problems.length === 0, problems.slice(0, 4).join(" ; "));
      chk(`${tag} ${id}: the long merchant is truncated inside its cell, not pushed out`, metrics.truncated >= 1, `${metrics.truncated} truncated`);
      if (grid) notes.push(`${tag} ${id}: header cols [left,width] ${JSON.stringify(metrics.header)}`);
    } else {
      chk(`${tag} ${id}: ambiguous source keeps the standard layout (no header strip, rows marked standard)`, (await page.evaluate(() => !document.querySelector('[data-testid="review-columns-header"]') && [...document.querySelectorAll('[data-testid="review-row"] button[aria-expanded]')].every((b) => b.dataset.layout === "standard"))) === true);
      chk(`${tag} ${id}: the control says it is the standard layout`, (await page.getByTestId("column-layout-trigger").getAttribute("aria-label")) === "Column layout: Auto (Standard)");
      const overflow = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="review-list"]');
        return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, list: list.scrollWidth - list.clientWidth };
      });
      chk(`${tag} ${id}: no overflow`, overflow.page <= 0 && overflow.list <= 1, JSON.stringify(overflow));
    }
    await h.shot(page, `scapcol-${id}-${tag}`);
  }
}

scenario("scapcol-desktop", "Smart Capture columns: desktop 1280 + 1600 — every source order, sticky header, expand/collapse, Customize/Reset", async ({ page }, chk, notes) => {
  await openCapture(page);
  for (const [w, hgt] of [[1280, 800], [1600, 900]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.waitForTimeout(300);
    await runDatasets(page, chk, notes, `${w}`, { gridFor: (n) => w >= 1600 || n <= 3 });

    // --- sticky header: 45 rows, the list scrolls, the header stays on top and aligned ---
    const many = Array.from({ length: 45 }, (_, i) => `${String((i % 27) + 1).padStart(2, "0")}/09/2026\tSHOP NUMBER ${i + 1}\t${(i + 1) * 10}.50 Dr`);
    await paste(page, many);
    const scrolled = await page.evaluate(async () => {
      const list = document.querySelector('[data-testid="review-list"]');
      const header = document.querySelector('[data-testid="review-columns-header"]');
      const canScroll = list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === "auto";
      list.scrollTop = list.scrollHeight;
      await new Promise((r) => setTimeout(r, 250));
      const [l, hd] = [list.getBoundingClientRect(), header.getBoundingClientRect()];
      const visibleRows = [...document.querySelectorAll('[data-testid="review-row"]')].filter((li) => li.getBoundingClientRect().bottom > hd.bottom && li.getBoundingClientRect().top < l.bottom);
      return { canScroll, scrollTop: list.scrollTop, headerTopDelta: Math.abs(hd.top - l.top), headerInside: hd.top >= l.top - 1 && hd.bottom <= l.bottom, firstVisible: visibleRows[0]?.dataset.rowId };
    });
    chk(`${w}: the 45-row list scrolls inside its own region`, scrolled.canScroll && scrolled.scrollTop > 0, JSON.stringify(scrolled));
    chk(`${w}: sticky header stays pinned to the top of the scrolled list`, scrolled.headerTopDelta <= 1 && scrolled.headerInside, `delta ${scrolled.headerTopDelta}`);
    const afterScroll = await geometry(page, ["date", "merchant", "amount"], true);
    chk(`${w}: rows far down the list are still aligned under the pinned header`, afterScroll.problems.length === 0, afterScroll.problems.slice(0, 3).join(" ; "));
    await h.shot(page, `scapcol-sticky-${w}`);
    await page.evaluate(() => (document.querySelector('[data-testid="review-list"]').scrollTop = 0));

    // --- expand / collapse (header and sibling rows stay aligned) ---
    await paste(page, DATASETS["amount-date-merchant"].text);
    const first = page.getByRole("button", { name: /^Expand AMAZON/ });
    await first.click();
    await page.getByLabel("Amount").first().waitFor();
    chk(`${w}: expanded row shows its editor`, (await page.getByLabel("Amount").count()) === 1);
    const expanded = await geometry(page, ["amount", "date", "merchant"], true);
    chk(`${w}: expanded: columns still aligned, nothing overflows`, expanded.problems.length === 0, expanded.problems.slice(0, 3).join(" ; "));
    const detailsOverflow = await page.evaluate(() => {
      const li = document.querySelector('[data-testid="review-row"][data-row-id="r1"]');
      return li.scrollWidth - li.clientWidth;
    });
    chk(`${w}: expanded details fit their row`, detailsOverflow <= 1, detailsOverflow);
    await h.shot(page, `scapcol-expanded-${w}`);
    await page.getByRole("button", { name: /^Collapse AMAZON/ }).click();
    chk(`${w}: collapses again`, (await page.getByLabel("Amount").count()) === 0);

    // --- Customize / Reset to source ---
    const before = await reviewState(page);
    await page.getByTestId("column-layout-trigger").click();
    await page.getByRole("button", { name: /Customize columns/ }).click();
    await page.getByRole("button", { name: "Move Merchant left" }).click();
    await page.getByRole("button", { name: "Move Merchant left" }).click();
    await page.keyboard.press("Escape");
    const custom = await headerLabels(page);
    chk(`${w}: Customize reorders the header (Merchant | Amount | Date expected)`, custom.join(",") === "Merchant,Amount,Date", custom.join(" | "));
    const custGeo = await geometry(page, ["merchant", "amount", "date"], true);
    chk(`${w}: customized grid is aligned`, custGeo.problems.length === 0, custGeo.problems.slice(0, 3).join(" ; "));
    chk(`${w}: control reads "Custom"`, (await page.getByTestId("column-layout-trigger").getAttribute("aria-label")) === "Column layout: Custom");
    await h.shot(page, `scapcol-custom-${w}`);
    chk(`${w}: Customize changed no value`, JSON.stringify(await reviewState(page)) === JSON.stringify(before));
    await page.getByTestId("column-layout-trigger").click();
    await page.getByRole("button", { name: /Reset to source/ }).click();
    await page.keyboard.press("Escape");
    chk(`${w}: Reset to source restores Amount | Date | Merchant`, (await headerLabels(page)).join(",") === "Amount,Date,Merchant");
    chk(`${w}: …and still no value changed`, JSON.stringify(await reviewState(page)) === JSON.stringify(before));
  }
});

scenario("scapcol-mobile", "Smart Capture columns: phones 360 + 390 — flow/wrap, no overflow, truncation, panel fit, expand", async ({ page }, chk, notes) => {
  await openCapture(page);
  for (const [w, hgt] of [[360, 740], [390, 844]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.waitForTimeout(300);
    await runDatasets(page, chk, notes, `${w}`, { gridFor: () => false });

    await paste(page, DATASETS["merchant-amount-date"].text);
    const metrics = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="review-row"]')];
      return { heights: rows.map((li) => Math.round(li.querySelector("button[aria-expanded]").getBoundingClientRect().height)), listOverflowY: getComputedStyle(document.querySelector('[data-testid="review-list"]')).overflowY };
    });
    notes.push(`${w} merchant-amount-date collapsed row heights ${metrics.heights.join("/")}px`);
    chk(`${w}: rows stay compact (≤ 3 text lines each)`, metrics.heights.every((v) => v <= 90), metrics.heights.join("/"));
    chk(`${w}: one page scroll (the list is not its own scroller)`, metrics.listOverflowY !== "auto", metrics.listOverflowY);

    // expand on a phone
    await page.getByRole("button", { name: /^Expand SWIGGY/ }).click();
    await page.getByLabel("Amount").first().waitFor();
    const exp = await geometry(page, ["merchant", "amount", "date"], false);
    chk(`${w}: expanded row: nothing overflows horizontally`, exp.problems.length === 0, exp.problems.slice(0, 3).join(" ; "));
    await h.shot(page, `scapcol-expanded-${w}`);
    await page.getByRole("button", { name: /^Collapse SWIGGY/ }).click();

    // customize panel must fit the phone
    await page.getByTestId("column-layout-trigger").click();
    await page.getByRole("button", { name: /Customize columns/ }).click();
    const box = await page.getByTestId("column-layout-panel").boundingBox();
    chk(`${w}: the Customize panel fits inside the screen`, box && box.x >= 0 && box.x + box.width <= w + 0.5, JSON.stringify(box));
    await page.getByRole("button", { name: "Move Date left" }).click();
    await page.getByRole("button", { name: "Move Date left" }).click();
    await h.shot(page, `scapcol-panel-${w}`);
    await page.keyboard.press("Escape");
    const cust = await geometry(page, ["date", "merchant", "amount"], false);
    chk(`${w}: customized order (Date | Merchant | Amount) reads in that order, no overflow`, cust.problems.length === 0, cust.problems.slice(0, 3).join(" ; "));
    await h.shot(page, `scapcol-custom-${w}`);
    await page.getByTestId("column-layout-trigger").click();
    await page.getByRole("button", { name: /Reset to source/ }).click();
    await page.keyboard.press("Escape");
    const reset = await geometry(page, ["merchant", "amount", "date"], false);
    chk(`${w}: Reset to source restores Merchant | Amount | Date, no overflow`, reset.problems.length === 0, reset.problems.slice(0, 3).join(" ; "));
  }
});

scenario("scapcol-invariants", "Smart Capture columns: no value, id, include or status changes through any layout operation or viewport; Continue hands the same rows over; zero writes", async ({ page }, chk) => {
  const snapshotWrites = async () => {
    const [txns, accounts, imports] = await Promise.all([h.list("transactions"), h.list("accounts"), h.list("documentImports")]);
    return JSON.stringify({ txns: txns.length, balances: accounts.map((a) => `${a.name}:${a.currentBalance}`).sort(), imports: imports.length });
  };
  const writesBefore = await snapshotWrites();
  await openCapture(page);
  const text = ["1,299.00 Dr\t05/09/2026\tAMAZON", "452.00 Dr\t10/09/2026\tSWIGGY", "452.00 Dr\t10/09/2026\tSWIGGY", "999.00 Cr\t07/09/2026\tREFUND MYNTRA", "101.00 Dr\t03/10/2026\tRETAIL STORE", "101.00 Cr\t03/10/2026\tRETAIL STORE"];
  await paste(page, text);
  await page.getByRole("checkbox", { name: "Include AMAZON" }).click(); // the user excludes one row
  const base = JSON.stringify(await reviewState(page));
  const same = async (what) => chk(`unchanged after ${what}`, JSON.stringify(await reviewState(page)) === base);
  const state0 = JSON.parse(base);
  chk("integer paise for every row", state0.every((r) => Number.isInteger(r.paise)), state0.map((r) => r.paise).join(","));
  chk("the excluded row is excluded; the repeat rows are two separate rows", state0[0].included === "false" && state0.filter((r) => r.amount === "452").length === 2);

  for (const [w, hgt] of [[1600, 900], [1280, 800], [768, 900], [390, 844], [360, 740], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.waitForTimeout(250);
    await same(`resizing to ${w}px`);
  }
  await page.getByTestId("column-layout-trigger").click();
  await page.getByRole("button", { name: /Customize columns/ }).click();
  for (const name of ["Move Merchant left", "Move Merchant left", "Move Amount left"]) {
    await page.getByRole("button", { name }).click();
    await same(name);
  }
  await page.getByRole("button", { name: /Reset to source/ }).click();
  await same("Reset to source");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Expand all/ }).click();
  await same("Expand all");
  await page.getByRole("button", { name: /Collapse all/ }).click();
  await same("Collapse all");
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("button", { name: /^Sort/ }).click();
  await same("cycling the sort");
  await page.getByRole("button", { name: /^To check/ }).click();
  await page.getByRole("button", { name: /^All/ }).click();
  await same("filtering");

  // duplicate warnings still read the same (open row 2 and row 5)
  await page.getByRole("button", { name: /^Expand SWIGGY/ }).first().click();
  const dup = await page.locator('[data-testid="review-row"][data-row-id="r2"]').innerText();
  chk("the duplicate warning still names the twin row", /Same date, merchant and amount as row 3/.test(dup));
  await page.getByRole("button", { name: /^Collapse SWIGGY/ }).first().click();
  await page.getByRole("button", { name: /^Expand RETAIL STORE/ }).first().click();
  chk("the opposite-direction pair is still called out", /opposite Charge\/Credit/.test(await page.locator('[data-testid="review-row"][data-row-id="r5"]').innerText()));
  await page.getByRole("button", { name: /^Collapse RETAIL STORE/ }).first().click();

  // Continue with a customized layout hands over the same rows.
  await page.getByTestId("column-layout-trigger").click();
  await page.getByRole("button", { name: /Customize columns/ }).click();
  await page.getByRole("button", { name: "Move Date left" }).click();
  await page.keyboard.press("Escape");
  const cont = page.getByRole("button", { name: /Next: Check duplicates/ });
  chk("Continue is enabled (every included row resolved)", await cont.isEnabled());
  await cont.click();
  await page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout: 240000 });
  await page.getByTestId("handoff-notice").waitFor({ timeout: 240000 });
  await page.getByTestId("recon-row").first().waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  const recon = await page.getByTestId("recon-row").evaluateAll((els) => els.map((e) => ({ text: e.innerText, state: e.getAttribute("data-state") })));
  const want = [["SWIGGY", "452.00"], ["SWIGGY", "452.00"], ["REFUND MYNTRA", "999.00"], ["RETAIL STORE", "101.00"], ["RETAIL STORE", "101.00"]];
  const used = new Set();
  const got = want.map(([m, a]) => {
    const i = recon.findIndex((r, k) => !used.has(k) && r.text.includes(m) && r.text.includes(a));
    if (i >= 0) used.add(i);
    return i >= 0;
  });
  chk("Reconciliation shows every included row (each twin separately) with its own amount", got.every(Boolean), JSON.stringify(recon.map((r) => r.text.replace(/\s+/g, " ").slice(0, 40))));
  chk("the row excluded in Smart Capture arrives still excluded", recon.some((r) => /AMAZON/.test(r.text) && r.state === "excluded"), recon.map((r) => r.state).join(","));
  await h.shot(page, "scapcol-handoff-reconciliation");
  chk("NOTHING was written (no transactions, balances or imports changed)", (await snapshotWrites()) === writesBefore);
});
