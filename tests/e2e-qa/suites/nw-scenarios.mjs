/**
 * Scenario-based Net Worth verification (emulator + real browser). Expected figures are written in the scenario
 * BEFORE it runs (independent oracle: the user's inputs), then compared with what the Dashboard hero DISPLAYS and
 * with what People Ledger / the account store hold.
 *   npm run test:e2e-qa -- nw- --copy
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const rupees = (s) => Number(String(s).replace(/[₹,\s−-]/g, ""));

/** What the Net Worth card shows: headline chart label + each bar's label/value. */
async function hero(page) {
  await h.go(page, "/dashboard");
  await page.waitForFunction(() => document.querySelector('main section[aria-label="Net worth"] [role="img"]'), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const sec = document.querySelector('main section[aria-label="Net worth"]');
    const img = sec.querySelector('[role="img"]');
    const label = img.getAttribute("aria-label") ?? "";
    const text = sec.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    return { label, text };
  });
}
const parse = (hr) => {
  const m = hr.label.match(/own ₹([\d,.]+), owe ₹([\d,.]+), net worth ([-−]?)₹([\d,.]+)/) ?? [];
  const after = (name) => {
    const i = hr.text.findIndex((t) => t === name);
    return i >= 0 ? rupees(hr.text[i - 1] ?? "") : NaN; // value is rendered above its label
  };
  return { assets: rupees(m[1]), debt: rupees(m[2]), nw: (m[3] ? -1 : 1) * rupees(m[4]), fromOthers: after("From others"), mine: after("Mine"), raw: hr.text.join(" | ") };
};

scenario("nw-probe", "Probe: print the Net Worth card text", async ({ page }, chk, notes) => {
  const hr = await hero(page);
  notes.push(hr.label, hr.text.join(" | "));
  chk("probe", true, JSON.stringify(parse(hr)));
});

scenario("nw-refresh", "Dashboard shows settled Net Worth and Cash Flow on the first render after a hard refresh", async ({ page, logs }, chk) => {
  const before = await hero(page);
  const expected = await page.getByRole("region", { name: "Net worth", exact: true }).locator("p.tabular-nums").first().textContent();
  const expectedCash = await page.getByRole("region", { name: "Cash flow", exact: true }).locator("p.tabular-nums").first().textContent();

  await page.addInitScript(() => {
    window.__qaDashboardReadings = { netWorth: [], cashFlow: [] };
    const observer = new MutationObserver(() => {
      const hero = document.querySelector('main section[aria-label="Net worth"]');
      const headline = hero?.querySelector("p.tabular-nums")?.textContent;
      const readings = window.__qaDashboardReadings;
      if (headline != null) {
        const chart = hero.querySelector('[role="img"]')?.getAttribute("aria-label") ?? null;
        const previous = readings.netWorth.at(-1);
        if (previous?.headline !== headline || previous?.chart !== chart) readings.netWorth.push({ headline, chart });
      }
      const cash = document.querySelector('main section[aria-label="Cash flow"] p.tabular-nums')?.textContent;
      if (cash != null && readings.cashFlow.at(-1) !== cash) readings.cashFlow.push(cash);
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  });

  await page.reload();
  await page.getByRole("img", { name: before.label, exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole("region", { name: "Cash flow", exact: true }).locator("p.tabular-nums").first().waitFor({ timeout: 60000 });
  const readings = await page.evaluate(() => window.__qaDashboardReadings);
  chk("the headline and chart show the same settled figures from their first render", readings.netWorth.length === 1 && readings.netWorth[0].headline === expected && readings.netWorth[0].chart === before.label, JSON.stringify(readings));
  chk("cash flow shows its settled figure on its first render", readings.cashFlow.length === 1 && readings.cashFlow[0] === expectedCash, JSON.stringify(readings));
  const trend = page.getByTitle("Last 7 days").locator("path.recharts-area-curve").first();
  await trend.waitFor({ state: "attached" });
  chk("the Net Worth trend draws a line after refresh", Boolean(await trend.getAttribute("d")));
  const cashChart = page.getByRole("img", { name: /^Weekly cash flow/ });
  await cashChart.locator("svg").waitFor({ state: "attached" });
  chk("the Cash Flow graph draws bars for its recorded activity", await cashChart.locator('path[fill="url(#cf-in)"], path[fill="url(#cf-out)"]').count() > 0);
  const amount = (text) => Number(text.replace(/[₹,]/g, ""));
  const cashCard = page.getByRole("region", { name: "Cash flow", exact: true });
  const [net, moneyIn, moneyOut] = (await cashCard.locator("p.tabular-nums").allTextContents()).map(amount);
  const weeks = (await cashChart.getAttribute("aria-label")).split("; ").map((label) => (label.match(/-?₹[\d,.]+/g) ?? []).map(amount));
  const weeklyIn = weeks.reduce((total, [income = 0]) => total + income, 0);
  const weeklyOut = weeks.reduce((total, [, expenses = 0]) => total + expenses, 0);
  chk("weekly Money In and Money Out add up to the monthly figures", f.close2(weeklyIn, moneyIn) && f.close2(weeklyOut, moneyOut), JSON.stringify({ weeklyIn, weeklyOut, moneyIn, moneyOut }));

  const lastWeek = weeks.findLastIndex((week) => week.length > 0);
  await cashChart.locator('svg rect[fill="transparent"]').nth(lastWeek).hover();
  const tooltip = await cashChart.getByText("Running net", { exact: true }).locator("xpath=..").innerText();
  const runningNet = amount(tooltip.match(/-?₹[\d,.]+/)?.[0] ?? "NaN");
  chk("the final Running net matches the monthly Net cash flow", f.close2(runningNet, net) && f.close2(weeklyIn - weeklyOut, net), JSON.stringify({ runningNet, net }));
  chk("dashboard readiness does not cause a React render warning", !logs.some((message) => message.includes("Cannot update a component")));
});

scenario("nw-assigned-card-purchase", "An assigned card expense adds a card liability and an equal People receivable", async ({ page }, chk) => {
  const totals = async () => {
    const { label, text } = await hero(page);
    const debt = rupees(label.match(/owe (₹[\d,.]+)/)?.[1]);
    const assigned = text.find((line) => line.includes("of your debt is assigned"))?.match(/^(₹[\d,.]+)/)?.[1];
    return { debt, others: assigned ? rupees(assigned) : 0, netWorth: parse({ label, text }).nw };
  };
  const before = await totals();
  await h.go(page, "/transactions");
  await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor();
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#txn-amount").fill("2000");
  const description = "QA card expense paid for someone else";
  await dialog.getByPlaceholder(/e\.g\. Blue Tokai/).fill(description);
  await dialog.getByText(/Account\s?\*/).first().locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: /QA Credit Card/ }).click();
  await dialog.getByText("Assign to a person", { exact: true }).locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: /QA Priya/ }).click();
  await dialog.getByRole("radio", { name: /Money I Gave/ }).click();
  await dialog.getByRole("button", { name: "Add Expense", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("txn-amount")?.value === "");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  const after = await totals();
  chk("card debt rises by ₹2,000 and Others’ share stays at its Loan/EMI amount", after.debt - before.debt === 2000 && after.others === before.others, JSON.stringify({ before, after }));
  chk("the same ₹2,000 receivable offsets the new card debt in net worth", f.close2(after.netWorth, before.netWorth));
});
