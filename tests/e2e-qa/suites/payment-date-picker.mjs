/**
 * Browser QA — payment date calendar (dpk-*). Local emulator only, synthetic data (24 months of EMI history).
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const pad = (n) => String(n).padStart(2, "0");
const display = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

scenario("dpk-calendar", "Payment date calendar: today default, opens on the old due month, direct month/year, no writes or requests while browsing, chosen date is what gets saved", async ({ page }, chk) => {
  await h.openPortalSignedIn(page);
  await page.click('[data-testid="qa-seed-history-emi"]');
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="qa-seed-history-emi"]')?.textContent?.includes("Adding"), null, { timeout: 120000 });
  await h.go(page, "/loans-installments");
  await page.getByText("QA 24-Month EMI").first().click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Record past payments" }).click();
  await page.getByText(/Step 1 of/).first().waitFor({ timeout: 30000 });
  await page.getByRole("checkbox", { name: "#1", exact: true }).click();
  await page.getByRole("button", { name: /^Continue with 1/ }).click();
  const form = page.locator("body");
  await form.getByTestId("payment-due-context").waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);

  const field = form.getByLabel("Date paid", { exact: true });
  chk("the paid date starts empty, not the due date", (await field.inputValue()) === "");
  const dueText = await form.getByTestId("payment-due-context").innerText();

  let requests = 0;
  const count = (r) => { if (/:(8380|9399)\//.test(r.url())) requests += 1; };
  await page.evaluate(() => window.__reset());
  page.on("request", count);
  const opened = Date.now();
  await field.locator("xpath=..").getByRole("button", { name: "Open calendar" }).click();
  const cal = page.getByTestId("date-calendar");
  await cal.waitFor();
  const openMs = Date.now() - opened;
  await h.shot(page, "dpk-1-due-month");
  const year = Number(await cal.getByLabel("Year", { exact: true }).inputValue());
  const month = Number(await cal.getByLabel("Month", { exact: true }).inputValue());
  const due = new Date((await cal.getByRole("button", { name: /^Due / }).innerText()).replace(/^Due /, ""));
  chk("opens on the due month", month === due.getMonth() && year === due.getFullYear(), `${month + 1}/${year}; ${dueText}`);
  chk("the due month is over a year back, no arrow clicking needed", Date.now() - due.getTime() > 330 * 86400000, dueText);
  await cal.getByLabel("Year", { exact: true }).selectOption(String(year - 1));
  await cal.getByLabel("Month", { exact: true }).selectOption("2");
  await cal.getByRole("button", { name: "Previous month" }).click();
  await cal.getByLabel("Year", { exact: true }).selectOption(String(year));
  chk("browsing months leaves the field empty", (await field.inputValue()) === "");
  await page.keyboard.press("Escape");
  await cal.waitFor({ state: "detached" });
  chk("Escape closes only the calendar, not the payment sheet", await form.getByTestId("payment-due-context").isVisible());

  await field.locator("xpath=..").getByRole("button", { name: "Open calendar" }).click();
  await cal.getByLabel("Month", { exact: true }).selectOption(String(due.getMonth()));
  await cal.getByLabel("Year", { exact: true }).selectOption(String(due.getFullYear()));
  const day = due.getDate() === 15 ? 16 : 15;
  const chosen = new Date(due.getFullYear(), due.getMonth(), day, 12);
  await cal.getByRole("button", { name: new RegExp(`^${day} `) }).click();
  await page.waitForTimeout(300);
  page.off("request", count);
  const commits = await page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);
  chk("calendar navigation wrote nothing", commits === 0, `${commits} commits`);
  chk("emulator requests during calendar use (informational)", true, `${requests} requests; first open ${openMs} ms`);
  chk("the picked day is shown", (await field.inputValue()) === display(chosen), await field.inputValue());
  await h.shot(page, "dpk-2-picked");

  const account = form.getByRole("combobox", { name: /Account \(record only\)|Paid from account|Account for/ });
  if (await account.count()) { await account.first().click(); await page.getByRole("option").first().click(); }
  chk("an unrelated edit keeps the date", (await field.inputValue()) === display(chosen));
  console.log("dpk save button enabled:", await form.getByRole("button", { name: /^Save past payment/ }).isEnabled(), "requests:", requests, "openMs:", openMs);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("dpk-defaults", "Pay now defaults to today; Pay several shows one date and what it applies to", async ({ page }, chk) => {
  await h.go(page, "/loans");
  await page.locator('[role="button"]', { hasText: "QA Loan 12" }).first().click();
  await page.getByTestId("loan-page").waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Record Payment" }).first().click();
  const sheet = page.locator("body");
  const field = sheet.getByLabel("Payment date", { exact: true });
  await field.waitFor({ timeout: 30000 });
  chk("Pay now defaults to today", (await field.inputValue()) === display(new Date()), await field.inputValue());
  await field.locator("xpath=..").getByRole("button", { name: "Open calendar" }).click();
  const cal = page.getByTestId("date-calendar");
  await cal.waitFor();
  chk("Pay now opens on this month with Today and Due shortcuts", Number(await cal.getByLabel("Month", { exact: true }).inputValue()) === new Date().getMonth() && (await cal.getByRole("button", { name: /^Due / }).count()) === 1 && (await cal.getByRole("button", { name: "Today", exact: true }).count()) === 1);
  await h.shot(page, "dpk-3-pay-now");
  await cal.getByRole("button", { name: "Today", exact: true }).click();
  chk("Today keeps today's date", (await field.inputValue()) === display(new Date()));
}, { viewport: { width: 1440, height: 900 }, scheme: "dark" });

scenario("dpk-several", "Pay several on old installments: one payment date (today), said plainly; its calendar only jumps to the due month — no due date is assigned", async ({ page }, chk) => {
  await page.click('[data-testid="qa-seed-history-emi"]');
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="qa-seed-history-emi"]')?.textContent?.includes("Adding"), null, { timeout: 120000 });
  await h.go(page, "/loans-installments");
  await page.getByText("QA 24-Month EMI").first().click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Record Payment" }).first().click();
  await page.getByRole("radio", { name: /Pay several/ }).click();
  await page.getByText(/Step 1 of/).first().waitFor({ timeout: 30000 });
  for (const n of ["#1", "#2"]) await page.getByRole("checkbox", { name: n, exact: true }).click();
  await page.getByRole("button", { name: /^Review 2/ }).click();
  const field = page.getByLabel("Payment date", { exact: true });
  await field.waitFor({ timeout: 15000 });
  chk("one payment date, today by default", (await field.inputValue()) === display(new Date()), await field.inputValue());
  chk("it says which date both are recorded on", /All 2 EMIs are recorded as paid on/.test(await page.getByTestId("bulk-pay-date-note").innerText()));
  await field.locator("xpath=..").getByRole("button", { name: "Open calendar" }).click();
  const cal = page.getByTestId("date-calendar");
  chk("no single due date is offered for several installments", (await cal.getByRole("button", { name: /^Due / }).count()) === 0);
  await cal.getByRole("button", { name: /^Show / }).click();
  await h.shot(page, "dpk-4-several");
  chk("jumping to the due month changes only the view", (await field.inputValue()) === display(new Date()) && (await cal.getByLabel("Year", { exact: true }).inputValue()) === "2024");
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
