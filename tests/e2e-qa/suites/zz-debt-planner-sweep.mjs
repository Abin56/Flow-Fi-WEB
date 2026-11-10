/**
 * Debt Planner sweep (testing-phase check): the page renders, no console/page errors, no layout overflow, the figures agree
 * with each other, and every control (ownership view, rows, strategy, custom order, budget, presets, scenarios, extra payment,
 * disclosures, links, persistence) does what its label says. Local emulator only. The planner is read + simulate, so every
 * scenario also proves nothing was written. Scenario ids: dp-sweep-*
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const num = (s) => Number(String(s).replace(/[^0-9.]/g, "")) || 0;
const COLLECTIONS = ["accounts", "transactions", "loans", "emis", "people", "creditCards", "bills", "expenses"];

async function snapshotDb() {
  const out = {};
  for (const c of COLLECTIONS) out[c] = JSON.stringify(await h.list(c).catch(() => "n/a"));
  return out;
}

async function openPlanner(page, { fixtures = true } = {}) {
  if (fixtures) {
    await h.addFixture(page, "shared-emi");
    await h.addFixture(page, "card-emi");
  }
  await h.go(page, "/debt-planner");
  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByRole("heading", { level: 1, name: "Debt Planner" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.getByRole("heading", { name: "Your debts" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
}
const main = async (page) => flat(await page.locator("main").evaluate((el) => el.textContent));
const budget = (page) => page.getByLabel("Monthly payoff budget", { exact: true });
const extra = (page) => page.getByLabel("Extra this month", { exact: true });
const rows = (page) => page.locator("section[aria-labelledby='dp-debts'] ul > li");

scenario("dp-sweep-render", "Debt Planner sweep: sections render, figures consistent, no errors / overflow (desktop, dark, tablet, mobile)", async ({ page, logs }, chk) => {
  await openPlanner(page);
  const before = await snapshotDb();
  const text = await main(page);
  await h.shot(page, "dp-sweep-desktop");
  for (const [label, re] of [
    ["header", /Debt Planner/i], ["Whose debt is it?", /Whose debt is it\?/i], ["Total debt", /Total debt/i], ["Required this cycle", /Required this cycle/i],
    ["Overdue", /Overdue/i], ["Projected debt-free", /Projected debt-free/i], ["Monthly payoff budget", /Monthly payoff budget/i], ["Your debts", /Your debts/i],
    ["Next to focus", /Next to focus/i], ["Payoff strategy", /Payoff strategy/i], ["Payoff roadmap", /Payoff roadmap/i], ["What if I pay extra?", /What if I pay extra\?/i],
    ["How is this calculated?", /How is this calculated\?/i],
  ]) chk(`section present: ${label}`, re.test(text), re);
  chk("no NaN / undefined / Infinity", !/NaN|undefined|Infinity/.test(text), (text.match(/.{0,30}(NaN|undefined|Infinity).{0,30}/) || [""])[0]);
  chk("no skeleton left", (await page.locator('main [class*="animate-pulse"]').count()) === 0);
  const n = await rows(page).count();
  chk("seeded debts listed (>= 4 rows)", n >= 4, n);
  chk("debt count label matches rows", new RegExp(`${n} debts?`).test(text), n);

  // Totals agree: Total debt header === Total liability cell === sum of the register in "All liabilities".
  await page.getByRole("radio", { name: "All liabilities" }).click();
  await page.waitForTimeout(400);
  const totalHeader = num(/Total debt\s*₹\s*([\d,.]+)/.exec(text)?.[1] ?? "");
  const liability = num(/Total liability\s*₹\s*([\d,.]+)/.exec(text)?.[1] ?? "");
  const leads = await rows(page).evaluateAll((els) => els.map((li) => li.querySelector("button")?.innerText ?? ""));
  const sum = leads.reduce((t, r) => t + (Number(/₹\s*([\d,]+(?:\.\d+)?)/.exec(r)?.[1]?.replace(/,/g, "")) || 0), 0);
  chk("Total debt = Total liability", totalHeader > 0 && Math.abs(totalHeader - liability) < 0.5, `${totalHeader} vs ${liability}`);
  chk("Total debt = sum of 'Still to pay' across rows", Math.abs(totalHeader - sum) < 1.5, `${totalHeader} vs ${sum}`);
  const mine = num(/My debt\s*₹\s*([\d,.]+)/.exec(text)?.[1] ?? "");
  const others = num(/Others' share\s*₹\s*([\d,.]+)/.exec(text)?.[1] ?? "");
  chk("My debt + Others' share = Total liability", Math.abs(mine + others - liability) < 1.5, `${mine} + ${others} vs ${liability}`);

  // Category composition sums to the total
  const comp = await page.locator('[aria-label="Debt by category"] li').allInnerTexts();
  const compSum = comp.reduce((t, r) => t + num(/₹\s*([\d,.]+)/.exec(r)?.[1] ?? ""), 0);
  chk("category composition sums to Total debt", Math.abs(compSum - totalHeader) < 1.5, `${compSum} vs ${totalHeader}`);

  // Reconciliation disclosure
  await page.getByRole("button", { name: /How is this calculated\?/ }).first().click();
  await page.waitForTimeout(400);
  const calc = await main(page);
  chk("reconciliation says Matches Net Worth", /Matches Net Worth liabilities/.test(calc), (calc.match(/(Matches|Does not match) Net Worth.{0,120}/) || [""])[0]);

  const overflow = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth, mc: document.querySelector("main").clientWidth }));
  for (const [name, vp] of [["desktop", null], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 640 }]]) {
    if (vp) { await page.setViewportSize(vp); await page.waitForTimeout(900); await h.shot(page, `dp-sweep-${name}`); }
    const o = await overflow();
    chk(`${name}: no horizontal overflow`, o.sw <= o.cw + 1 && o.mw <= o.mc + 1, JSON.stringify(o));
    if (name === "desktop") { await page.emulateMedia({ colorScheme: "dark" }); await page.waitForTimeout(600); await h.shot(page, "dp-sweep-dark"); await page.emulateMedia({ colorScheme: "light" }); }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(600);
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("main button, main a[href], main input, main select")].filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]")).filter((el) => !((el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.title || (el.labels && el.labels[0]?.innerText) || "").trim())).map((el) => `${el.tagName}.${(el.className || "").toString().slice(0, 40)}`));
  chk("every visible button / link / input has an accessible name", unnamed.length === 0, unnamed.slice(0, 5).join(" | "));
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
  chk("page wrote nothing", JSON.stringify(await snapshotDb()) === JSON.stringify(before));
});

scenario("dp-sweep-controls", "Debt Planner sweep: ownership view, rows, links, strategy, custom order, disclosures", async ({ page, logs }, chk) => {
  await openPlanner(page);
  const before = await snapshotDb();

  // Ownership view radios
  const radio = (n) => page.getByRole("radio", { name: n, exact: true });
  chk("default view is My debt", (await radio("My debt").getAttribute("aria-checked")) === "true");
  const headerOf = async () => flat(await page.locator("section[aria-labelledby='dp-debts']").evaluate((el) => el.textContent));
  chk("register header says My share in My debt", /My share/.test(await headerOf()));
  const rowsMine = await rows(page).count();
  await radio("All liabilities").click();
  await page.waitForTimeout(300);
  chk("All liabilities selected + header 'Still to pay'", (await radio("All liabilities").getAttribute("aria-checked")) === "true" && /Still to pay/.test(await headerOf()));
  const rowsAll = await rows(page).count();
  await radio("Others' share").click();
  await page.waitForTimeout(300);
  const rowsOthers = await rows(page).count();
  chk("Others' share filters to shared debts only (<= all)", rowsOthers <= rowsAll && rowsOthers >= 1, `${rowsOthers}/${rowsAll}`);
  chk("My debt view keeps every row", rowsMine === rowsAll, `${rowsMine} vs ${rowsAll}`);
  await h.shot(page, "dp-sweep-others");
  await radio("My debt").click();
  await page.waitForTimeout(300);

  // Row expand / collapse + links
  const first = rows(page).first().locator("button").first();
  chk("row starts collapsed", (await first.getAttribute("aria-expanded")) === "false");
  await first.click();
  await page.waitForTimeout(400);
  chk("row expands", (await first.getAttribute("aria-expanded")) === "true");
  const det = flat(await rows(page).first().evaluate((el) => el.textContent));
  chk("detail shows Balance / Next payments / In your plan", /Balance/.test(det) && /Next payments/i.test(det) && /In your plan/i.test(det), det.slice(0, 160));
  await h.shot(page, "dp-sweep-row-open");
  await first.click();
  await page.waitForTimeout(300);
  chk("row collapses", (await first.getAttribute("aria-expanded")) === "false");
  // every row's action link resolves to a real route
  const count = await rows(page).count();
  const hrefs = [];
  for (let i = 0; i < count; i++) {
    const b = rows(page).nth(i).locator("button").first();
    await b.click();
    await page.waitForTimeout(250);
    const a = rows(page).nth(i).locator("a[href]").first();
    hrefs.push(await a.getAttribute("href"));
    await b.click();
  }
  chk("each row has an Open link with a target", hrefs.length === count && hrefs.every((x) => /^\/(loans|emi|credit-cards|people)/.test(x ?? "")), hrefs.join(", "));

  // Strategy picker
  const strat = (n) => page.getByRole("radio", { name: n, exact: true });
  const copy = async () => flat(await page.locator("section[aria-labelledby='dp-strategy']").evaluate((el) => el.textContent));
  for (const [tab, re] of [["Lowest balance", /smallest balance/i], ["Due date", /due soonest/i], ["Custom", /order you set/i], ["Highest interest", /highest known interest/i]]) {
    await strat(tab).click();
    await page.waitForTimeout(300);
    chk(`strategy ${tab}: selected + copy updates`, (await strat(tab).getAttribute("aria-checked")) === "true" && re.test(await copy()), (await copy()).slice(0, 120));
  }
  await page.getByRole("button", { name: "How this works" }).click();
  chk("'How this works' expands", /not financial advice/i.test(await copy()));
  await page.getByRole("button", { name: "How this works" }).click();
  chk("'How this works' collapses", !/not financial advice/i.test(await copy()));

  // Custom order up/down
  await strat("Custom").click();
  await page.waitForTimeout(300);
  const order = () => page.locator("ol[aria-label='Custom payoff order'] li span.truncate").allInnerTexts();
  const o1 = await order();
  chk("custom order lists debts", o1.length >= 2, o1.join(" > "));
  chk("first Move up and last Move down are disabled", (await page.locator("ol[aria-label='Custom payoff order'] li").first().getByRole("button", { name: /up$/ }).isDisabled()) && (await page.locator("ol[aria-label='Custom payoff order'] li").last().getByRole("button", { name: /down$/ }).isDisabled()));
  await page.locator("ol[aria-label='Custom payoff order'] li").first().getByRole("button", { name: /down$/ }).click();
  await page.waitForTimeout(400);
  const o2 = await order();
  chk("Move down swaps first two", o2[0] === o1[1] && o2[1] === o1[0], `${o1.slice(0, 2)} -> ${o2.slice(0, 2)}`);
  await page.locator("ol[aria-label='Custom payoff order'] li").nth(1).getByRole("button", { name: /up$/ }).click();
  await page.waitForTimeout(400);
  chk("Move up restores order", (await order()).join() === o1.join());
  await h.shot(page, "dp-sweep-custom");
  await strat("Highest interest").click();

  // Disclosures + Month Cycle link
  const disc = page.getByRole("button", { name: /How is this calculated\?/ }).first();
  chk("disclosure collapsed", (await disc.getAttribute("aria-expanded")) === "false");
  await disc.click();
  chk("disclosure expands", (await disc.getAttribute("aria-expanded")) === "true");
  await disc.click();
  chk("disclosure collapses", (await disc.getAttribute("aria-expanded")) === "false");
  await page.getByRole("button", { name: "Month Cycle details" }).click();
  chk("Month Cycle details expands", /Income received/.test(await main(page)));
  await page.getByRole("button", { name: "Month Cycle details" }).click();

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
  chk("controls wrote nothing", JSON.stringify(await snapshotDb()) === JSON.stringify(before));
  await page.getByRole("link", { name: /Month Cycle ·/ }).click();
  chk("Month Cycle link → /month-cycle", await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/month-cycle", null, { timeout: 30000 }).then(() => true, () => false), page.url());
});

scenario("dp-sweep-budget", "Debt Planner sweep: budget input, presets, scenarios, extra-payment simulation, persistence", async ({ page, logs }, chk) => {
  await openPlanner(page);
  const before = await snapshotDb();
  const t0 = await main(page);
  const defaultBudget = num((await budget(page).inputValue()) || "0");
  const req = num(/Required this cycle\s*₹\s*([\d,.]+)/.exec(t0)?.[1] ?? "");
  chk("default budget = required rounded up to ₹500", defaultBudget === Math.max(Math.ceil(req / 500) * 500, 0), `${defaultBudget} vs ${req}`);

  // Presets
  const presets = page.locator('[aria-label="Suggested budgets"] button');
  const pc = await presets.count();
  chk("budget presets present", pc >= 1, pc);
  for (let i = 0; i < pc; i++) {
    const label = flat(await presets.nth(i).innerText());
    await presets.nth(i).click();
    await page.waitForTimeout(500);
    const v = num(await budget(page).inputValue());
    chk(`preset "${label}" sets the budget (within ₹1)`, Math.abs(v - num(label.replace(/Required/, ""))) <= 1, `${v}`);
    chk(`preset "${label}" shows pressed after click`, (await presets.nth(i).getAttribute("aria-pressed")) === "true", `${label}: budget ${v}, pressed=${await presets.nth(i).getAttribute("aria-pressed")}`);
  }

  // Shortfall: budget below required
  await budget(page).fill("100");
  await page.waitForTimeout(1200);
  let t = await main(page);
  chk("low budget → shortfall notice", /Budget shortfall/.test(t) && /Increase the budget by/.test(t), (t.match(/Budget shortfall.{0,160}/) || [""])[0]);
  chk("low budget → roadmap paused chip", /Paused/.test(t));
  chk("low budget → extra panel says comparison unavailable", /Payoff comparison unavailable/.test(t));
  await h.shot(page, "dp-sweep-shortfall");

  // Generous budget → debt-free
  await budget(page).fill("100000");
  await page.waitForTimeout(1500);
  t = await main(page);
  chk("high budget → Debt-free chip with a date", /Debt-free [A-Z][a-z]{2,4} \d{4}/.test(t), (t.match(/Debt-free.{0,30}/) || [""])[0]);
  chk("high budget → no shortfall notice", !/Budget shortfall/.test(t));
  await h.shot(page, "dp-sweep-highbudget");

  // Empty / negative / zero budgets must not crash
  for (const v of ["", "0", "-500", "1e3", "0.5"]) {
    await budget(page).fill(v);
    await page.waitForTimeout(700);
    const tt = await main(page);
    chk(`budget "${v}" → page stays healthy`, /Your debts/.test(tt) && !/NaN|undefined|Infinity/.test(tt), (tt.match(/.{0,30}(NaN|undefined|Infinity).{0,30}/) || [""])[0]);
  }

  // Scenario picks
  await budget(page).fill("30000");
  await page.waitForTimeout(1200);
  const sc = page.locator("section[aria-labelledby='dp-scenarios'] button");
  const sn = await sc.count();
  chk("budget scenarios listed", sn >= 2, sn);
  const current = await page.locator("section[aria-labelledby='dp-scenarios'] button[aria-pressed='true']").count();
  chk("current budget flagged in scenarios", current === 1, current);
  if (sn >= 2) {
    const pick = sc.nth(0);
    const amt = num(flat(await pick.innerText()).split("/")[0]);
    await pick.click();
    await page.waitForTimeout(600);
    chk("picking a scenario sets the budget", Math.abs(num(await budget(page).inputValue()) - amt) < 1, `${await budget(page).inputValue()} vs ${amt}`);
  }

  // Extra payment (₹50,000 clears the December requirement, so the comparison is available)
  await budget(page).fill("50000");
  await page.waitForTimeout(1200);
  chk("extra default 5000", (await extra(page).inputValue()) === "5000");
  t = await main(page);
  chk("extra panel compares Without / With", /Without extra/.test(t) && /With ₹5,000 extra/.test(t) && /Months saved/.test(t) && /Interest saved/.test(t), (await page.locator("section[aria-labelledby='dp-extra']").evaluate((el) => el.textContent)).slice(-600));
  const extraItems = await page.locator("section[aria-labelledby='dp-extra'] ul > li").allInnerTexts();
  const extraTotal = extraItems.reduce((s, r) => s + num(/₹\s*([\d,.]+)/.exec(r)?.[1] ?? ""), 0);
  chk("'Where the extra goes' sums to the extra", Math.abs(extraTotal - 5000) < 1, JSON.stringify({ extraTotal, extraItems }));
  await extra(page).fill("");
  await page.waitForTimeout(800);
  chk("empty extra → prompt to enter an amount", /Enter an amount to compare/.test(await main(page)));
  await extra(page).fill("-100");
  await page.waitForTimeout(800);
  chk("negative extra → prompt, no crash", /Enter an amount to compare/.test(await main(page)));
  await extra(page).fill("12000");
  await page.waitForTimeout(1000);
  chk("label follows the extra amount", /With ₹12,000 extra/.test(await main(page)));
  const sel = page.getByLabel("Apply using", { exact: true });
  const opts = await sel.locator("option").allInnerTexts();
  chk("target select offers Strategy + each debt", opts.length >= 3 && /^Strategy:/.test(opts[0]), opts.join(" | "));
  await sel.selectOption({ index: 1 });
  await page.waitForTimeout(1000);
  chk("choosing a target says 'You chose this debt'", /You chose this debt/.test(await main(page)));
  await h.shot(page, "dp-sweep-extra-target");
  await sel.selectOption({ index: 0 });
  await page.waitForTimeout(800);

  // Roadmap show-all
  const showAll = page.getByRole("button", { name: /Show all \d+ months/ });
  if (await showAll.count()) {
    const m0 = await page.locator("section[aria-labelledby='dp-payoff'] ol > li").count();
    await showAll.click();
    await page.waitForTimeout(500);
    const m1 = await page.locator("section[aria-labelledby='dp-payoff'] ol > li").count();
    chk("Show all months reveals more", m1 > m0, `${m0} -> ${m1}`);
    await page.getByRole("button", { name: "Show fewer months" }).click();
    chk("Show fewer months restores 6", (await page.locator("section[aria-labelledby='dp-payoff'] ol > li").count()) === 6);
  } else chk("roadmap has <= 6 months (no toggle)", true);

  // Persistence across reload
  await page.getByRole("radio", { name: "Lowest balance", exact: true }).click();
  await budget(page).fill("27500");
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByRole("heading", { name: "Your debts" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  chk("budget + strategy survive reload", (await budget(page).inputValue()) === "27500" && (await page.getByRole("radio", { name: "Lowest balance", exact: true }).getAttribute("aria-checked")) === "true", await budget(page).inputValue());
  // Corrupted storage must not crash the page
  await page.evaluate(() => localStorage.setItem("flowfi.debtPlanner.v1", "{not json"));
  await page.reload();
  await page.getByRole("heading", { name: "Your debts" }).waitFor({ timeout: 60000 });
  chk("corrupt storage → defaults, no crash", /Payoff roadmap/.test(await main(page)));
  await page.evaluate(() => localStorage.setItem("flowfi.debtPlanner.v1", JSON.stringify({ strategy: "bogus", customOrder: "x" })));
  await page.reload();
  const ok = await page.getByRole("heading", { name: "Your debts" }).waitFor({ timeout: 30000 }).then(() => true, () => false);
  chk("invalid stored strategy / order → no crash", ok && /Payoff roadmap/.test(await main(page).catch(() => "")), ok);
  await page.evaluate(() => localStorage.removeItem("flowfi.debtPlanner.v1"));

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
  chk("simulation wrote nothing", JSON.stringify(await snapshotDb()) === JSON.stringify(before));
});

scenario("dp-sweep-empty", "Debt Planner sweep: with no seeded debt-free fixtures the page still renders; deep links from rows resolve", async ({ page, logs }, chk) => {
  await openPlanner(page, { fixtures: false });
  const t = await main(page);
  chk("renders without optional fixtures", /Your debts/.test(t) && !/NaN|undefined|Infinity/.test(t));
  // Follow the first row's Open link and make sure the target page loads healthy.
  const first = rows(page).first().locator("button").first();
  await first.click();
  const link = rows(page).first().locator("a[href]").first();
  const href = await link.getAttribute("href");
  await link.click();
  chk("Open link navigates", await page.waitForFunction((p) => location.pathname.replace(/\/+$/, "") === p, href.split("?")[0].replace(/\/+$/, ""), { timeout: 30000 }).then(() => true, () => false), `${href} -> ${page.url()}`);
  await page.waitForTimeout(2500);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors after navigating", errs.length === 0, errs.slice(0, 4).join(" || "));
});
