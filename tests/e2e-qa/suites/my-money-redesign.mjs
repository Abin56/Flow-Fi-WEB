/**
 * My Money compact redesign (UI-only) — density, layout and themes on synthetic emulator data. Read-only.
 *   npm run test:e2e-qa -- mmux- --copy
 */
import { readFile } from "node:fs/promises";
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

async function open(page) {
  await h.go(page, "/my-money");
  await page.getByRole("heading", { level: 1, name: "My Money" }).waitFor({ timeout: 60000 });
  await page.waitForSelector('[aria-label="Period summary"]', { timeout: 60000 });
  await page.waitForTimeout(2500);
}

const errsOf = (logs) => logs.filter((l) => !/Select is changing|status of 400|React DevTools|Download the React/.test(l));

async function monthlyAmountsVisible(page) {
  const buttons = page.getByRole("group", { name: /^Spending by month in/ }).getByRole("button");
  return buttons.evaluateAll((months) => months.length === 12 && months.every((month) => {
    const amount = month.getAttribute("aria-label").split(": ")[1]?.split(". Open this period")[0];
    return month.innerText.includes(amount === "not started yet" ? "—" : amount);
  }));
}

scenario("mm-account-spending", "My Money and Month Cycle show direct loan debits and export separate account spending CSVs", async ({ page }, chk) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const bank = await h.accountBalance("QA Bank");
  const loan = (await h.list("loans")).find((row) => row.name === "QA Loan 12");
  const date = new Date();
  const base = { dateTime: date, createdAt: date, accountId: bank.id, type: "expense", categoryId: "uncategorized", deletedAt: null };
  const expenseDescription = "QA account expense for household supplies and recurring utility bills paid from the savings account";
  await page.evaluate((uid) => {
    const key = `flowfi:user-preferences:${uid}`;
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...preferences, monthCycleStartDay: 17 }));
    window.dispatchEvent(new CustomEvent("flowfi:user-preferences-changed", { detail: uid }));
  }, await h.authUid());
  await h.createDocUnderUser("transactions/qa-account-spend-loan", {
    ...base, description: "QA direct loan debit", amount: 5321.23, loanId: loan.id, paymentAllocationType: "regularEmi",
  });
  await h.createDocUnderUser("transactions/qa-account-spend-expense", { ...base, description: expenseDescription, amount: 123.45 });

  await open(page);
  const year = page.getByRole("region", { name: "Spending this year" });
  const period = page.getByRole("region", { name: "Spending this period" });
  const yearDetails = year.getByRole("button", { name: /^View details for account spending/ });
  const paidAmount = /^₹5,321\.23$/;
  chk("direct loan debit appears in the period and year", await period.locator("dd").filter({ hasText: paidAmount }).isVisible() && await year.locator("dd").filter({ hasText: paidAmount }).isVisible());
  for (const width of [900, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await yearDetails.evaluate((trigger) => {
      const main = document.querySelector("main");
      return { overflow: main.scrollWidth - main.clientWidth, summaryHeight: trigger.parentElement.parentElement.offsetHeight };
    });
    chk(`desktop spending summary stays compact at ${width}px`, layout.overflow <= 1 && layout.summaryHeight <= 112, JSON.stringify(layout));
  }
  await h.shot(page, "my-money-account-spending");
  const getPageHeight = () => page.locator("main").evaluate((main) => main.scrollHeight);
  const pageHeight = await getPageHeight();
  await yearDetails.click();
  const details = page.getByRole("dialog", { name: "From your accounts" });
  const months = details.getByRole("region", { name: "Monthly account breakdown" });
  chk("year shows twelve monthly rows with the loan debit in its own month", await months.getByRole("row").count() === 13 && await months.getByRole("cell", { name: "₹5,321.23", exact: true }).count() === 1);
  chk("custom cycle rows show the full cycle date range", await months.getByRole("columnheader", { name: "Cycle ends" }).isVisible() && await months.getByRole("rowheader", { name: /17 .*16 / }).count() === 12);
  const scrolling = await months.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    return { scrollTop: list.scrollTop, headerTop: Math.round(list.querySelector("thead").getBoundingClientRect().top - list.getBoundingClientRect().top) };
  });
  chk("details scroll internally with a fixed table heading and no page growth", scrolling.scrollTop > 0 && Math.abs(scrolling.headerTop) <= 1 && pageHeight === await getPageHeight(), JSON.stringify(scrolling));
  await h.shot(page, "my-money-account-spending-details");
  await details.getByRole("tab", { name: "Transactions" }).click();
  chk("transactions view shows loan and expense details", await details.getByRole("row", { name: /QA direct loan debit.*QA Bank/ }).isVisible() && await details.getByRole("row", { name: /QA account expense.*QA Bank/ }).isVisible());
  chk("long descriptions fit inside the transactions view", await details.getByText(expenseDescription, { exact: true }).evaluate((text) => {
    const list = text.closest('[data-slot="scroll-area"]');
    return text.scrollWidth <= text.clientWidth + 1 && text.clientHeight >= 2 * parseFloat(getComputedStyle(text).lineHeight) - 1 && list.scrollWidth <= list.clientWidth + 1;
  }));
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "hidden" });
  await yearDetails.evaluate((trigger) => trigger === document.activeElement || new Promise((resolve) => requestAnimationFrame(() => resolve(trigger === document.activeElement))))
    .then((restored) => chk("closing details returns focus to its action", restored));

  const personalSpend = await page.getByRole("region", { name: "Period summary" }).getByText("My spending", { exact: true })
    .evaluate((label) => label.parentElement.nextElementSibling.textContent);

  for (const [scope, label, expected, unexpected, filename] of [
    [year, /Export Loan \/ EMI paid CSV/, '"QA direct loan debit","QA Bank",5321.23', "QA account expense", "flowfi-loan-emi-payments-"],
    [period, /Export Other expenses CSV/, `"${expenseDescription}","QA Bank",123.45`, "QA direct loan debit", "flowfi-other-expenses-"],
  ]) {
    await scope.getByRole("button", { name: /^View details for account spending/ }).click();
    const downloadPromise = page.waitForEvent("download");
    await details.getByRole("button", { name: label }).click();
    const download = await downloadPromise;
    const csv = await readFile(await download.path(), "utf8");
    chk(`${filename} export contains only the intended group`, download.suggestedFilename().startsWith(filename) && csv.includes(expected) && !csv.includes(unexpected));
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await details.waitFor({ state: "hidden" });
  }

  await h.go(page, "/month-cycle");
  const cycle = page.getByRole("region", { name: "Cycle summary" });
  await cycle.getByText("₹5,321.23", { exact: true }).waitFor();
  await cycle.getByRole("button", { name: personalSpend, exact: true }).waitFor();
  chk("the existing My Spend figure agrees across pages", await cycle.getByRole("button", { name: personalSpend, exact: true }).isVisible(), personalSpend);
  await cycle.getByRole("button", { name: /^View details for account spending/ }).click();
  chk("Month Cycle has the same debit and both exports", await details.getByText("₹5,321.23", { exact: true }).count() === 2 && await details.getByRole("button", { name: /^Export.*CSV/ }).count() === 2);
  await h.shot(page, "month-cycle-account-spending");
});

for (const [w, hgt] of [
  [900, 768],
  [1024, 768],
  [1280, 720],
  [1440, 900],
  [1920, 1080],
]) {
  scenario(`mmux-layout-${w}`, `My Money web layout at ${w}×${hgt}; light/dark`, async ({ page, logs }, chk, notes) => {
    await page.setViewportSize({ width: w, height: hgt });
    await h.addFixture(page, "shared-emi");
    await open(page);
    const m = await page.evaluate(() => {
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const summary = r(document.querySelector('[aria-label="Period summary"]'));
      const pay = document.querySelector("#mm-to-pay-section");
      const rows = [...(pay?.querySelectorAll("li.group\\/row") ?? [])].map((li) => {
        const line = li.firstElementChild.getBoundingClientRect();
        return Math.round(line.height);
      });
      const collect = r(document.querySelector("#mm-collect-section"));
      const year = r(document.querySelector("#mm-year-spending"));
      const history = r(document.querySelector("#mm-completed"));
      const spend = r(document.querySelector('section[aria-labelledby="mm-spending"]'));
      const amounts = document.querySelectorAll("#mm-year-spending [role=group] button > span:last-child");
      const wrappedAmounts = [...amounts].filter((amount) => {
        const range = document.createRange();
        range.selectNodeContents(amount);
        return range.getClientRects().length > 1;
      }).map((amount) => amount.textContent);
      return {
        rows,
        summaryBottom: Math.round(summary.bottom),
        payTop: Math.round(r(pay).top),
        payRight: Math.round(r(pay).right),
        collectTop: Math.round(collect.top),
        yearTop: Math.round(year.top),
        yearLeft: Math.round(year.left),
        yearWidth: Math.round(year.width),
        yearHeight: Math.round(year.height),
        historyTop: history && Math.round(history.top),
        spendTop: spend && Math.round(spend.top),
        spendHeadingBottom: r(document.querySelector("#mm-spending"))?.bottom,
        wrappedAmounts,
      };
    });
    notes.push(JSON.stringify(m));
    chk("payments and the annual chart start side by side just below the summary", m.payTop === m.yearTop && m.payRight < m.yearLeft && m.payTop - m.summaryBottom <= 16);
    chk("annual chart stays compact in its side panel", m.yearHeight <= 300, m.yearHeight);
    chk("payment history, money to collect and period spending are discoverable on the first screen", [m.historyTop, m.collectTop, m.spendHeadingBottom].every((edge) => edge != null && edge < hgt), `${m.historyTop} / ${m.collectTop} / ${m.spendHeadingBottom}`);
    if (w >= 1280) chk("money to collect starts in the third column", m.collectTop === m.payTop, m.collectTop);
    chk("payment row details stay compact", m.rows.some((x) => x > 0) && m.rows.every((x) => x <= 76), m.rows.join(","));
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
    chk("no horizontal overflow", o.sw <= o.cw + 1 && o.mw <= 1, JSON.stringify(o));
    chk("all 12 monthly amounts are visible without hovering", await monthlyAmountsVisible(page));
    chk("monthly amounts fit on one line", m.wrappedAmounts.length === 0, m.wrappedAmounts.join(", "));
    await h.shot(page, `mmux-${w}-light`);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(700);
    await h.shot(page, `mmux-${w}-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    if (w === 900) {
      const people = page.getByRole("region", { name: "Money to collect" });
      chk("the narrow People preview shows one row", await people.locator("li:visible").count() === 1);
      await people.getByRole("button", { name: "Show all 2" }).click();
      chk("the People preview expands to both rows", await people.locator("li:visible").count() === 2);
      await people.getByRole("button", { name: "Show fewer" }).click();
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      const resized = await page.waitForFunction((width) => {
        return document.querySelector("#mm-year-spending").getBoundingClientRect().width > width + 30;
      }, m.yearWidth, { timeout: 5000 }).then(() => true, () => false);
      chk("the chart adapts when the sidebar is collapsed", resized && await monthlyAmountsVisible(page));
    }
    chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
  });
}

scenario("mmux-interactions", "My Money redesign: expand shared breakdown, covered elsewhere and completed; row actions navigate; mobile has no overflow", async ({ page, logs }, chk) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await h.addFixture(page, "shared-emi");
  await open(page);
  const share = page.getByRole("button", { name: /Your share|Includes others' share/ }).first();
  if (await share.count()) {
    await share.click();
    await page.waitForTimeout(300);
    chk("shared breakdown expands", (await share.getAttribute("aria-expanded")) === "true");
    await h.shot(page, "mmux-shared-open");
  }
  const completed = page.getByRole("button", { name: /^Payments made/ });
  if (await completed.count()) {
    const before = await completed.getAttribute("aria-expanded");
    await completed.click();
    await page.waitForTimeout(300);
    chk("Completed toggles", (await completed.getAttribute("aria-expanded")) !== before);
  }
  const action = page.locator("#mm-to-pay-section li a").first();
  if (await action.count()) {
    const href = await action.getAttribute("href");
    await action.click();
    const want = href.split("?")[0].replace(/\/+$/, "");
    const ok = await page.waitForFunction((p) => location.pathname.replace(/\/+$/, "") === p, want, { timeout: 60000 }).then(() => true, () => false);
    chk(`row action opens ${want}`, ok, await page.evaluate(() => location.pathname));
  } else chk("payments list has a row action (seed)", false, "none");
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const o = await page.evaluate(() => {
      const main = document.querySelector("main");
      const overflow = main.scrollWidth - main.clientWidth;
      const mainRight = main.getBoundingClientRect().right;
      const outside = overflow > 1
        ? [...main.querySelectorAll("*")]
            .filter((node) => node.getBoundingClientRect().right > mainRight + 1)
            .slice(0, 6)
            .map((node) => node.getAttribute("aria-label") || node.getAttribute("class") || node.tagName)
        : [];
      return {
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        mw: overflow,
        outside,
        chartBottom: document.querySelector("#mm-year-spending [role=group]").getBoundingClientRect().bottom,
      };
    });
    chk(`mobile ${viewport.width}px: no horizontal overflow`, o.sw <= o.cw + 1 && o.mw <= 1, JSON.stringify(o));
    chk(`mobile ${viewport.width}px: all chart labels fit on the first screen`, o.chartBottom <= viewport.height, o.chartBottom);
    chk(`mobile ${viewport.width}px: all 12 monthly amounts are visible without hovering`, await monthlyAmountsVisible(page));
    await h.shot(page, `mmux-${viewport.width}-light`);
    if (viewport.width === 320) {
      const main = page.locator("main");
      await main.evaluate((el) => { el.scrollTop = 300; });
      const quickPay = page.getByRole("region", { name: "My Money quick bar" }).getByRole("link");
      const bounds = await quickPay.boundingBox({ timeout: 5000 });
      chk("mobile 320px: the quick pay link fits while scrolling", bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, JSON.stringify(bounds));
      await main.evaluate((el) => { el.scrollTop = 0; });
    }
  }
  const year = page.getByRole("region", { name: "Spending this year" });
  const chart = year.getByRole("group", { name: /^Spending by month in/ });
  const previousYear = await chart.getAttribute("aria-label");
  await year.getByRole("button", { name: "Previous year" }).click();
  chk("year controls update the chart", (await chart.getAttribute("aria-label")) !== previousYear);
  await year.getByRole("button", { name: /Back to selected period/ }).click();
  chk("reset restores the selected period’s year", (await chart.getAttribute("aria-label")) === previousYear);
  const otherMonth = chart.getByRole("button", { pressed: false }).first();
  const monthName = await otherMonth.getAttribute("aria-label");
  await otherMonth.click();
  chk("choosing a chart month selects its period", (await chart.getByRole("button", { name: monthName, exact: true, pressed: true }).count()) === 1);
  chk("no console errors / page errors", errsOf(logs).length === 0, errsOf(logs).slice(0, 4).join(" || "));
});
