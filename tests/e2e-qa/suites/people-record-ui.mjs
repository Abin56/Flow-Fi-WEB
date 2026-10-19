/**
 * People → Record payment: structure and layout of the restructured panel (Step 1 Money details, Step 2 Apply to
 * bills, Step 3 Remaining money, After recording (optional), one three-way intent). UI-only: nothing is recorded
 * here — the money paths are covered by the people-*, pdate-* and rev-people-* scenarios. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const stepTitles = (page) => page.locator("h4").evaluateAll((els) => els.map((e) => e.textContent.replace(/^Step \d+/, "").trim()));
const radio = (page, re) => page.getByRole("radio", { name: re });

/** The sticky header must be what you see at the top of the drawer — nothing may paint over it while scrolled. */
async function headerOnTop(page) {
  return page.evaluate(() => {
    const form = document.querySelector("form[aria-label^='Record payment']");
    const header = form?.firstElementChild;
    if (!header) return { ok: false, why: "no header" };
    const r = header.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !!hit && header.contains(hit), top: Math.round(r.top), hit: hit?.tagName };
  });
}
const scrollDrawer = (page, y) =>
  page.evaluate((to) => {
    const form = document.querySelector("form[aria-label^='Record payment']");
    let n = form;
    while (n && !(n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
    if (n) n.scrollTop = to;
    return !!n;
  }, y);

async function openForm(page) {
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page);
}

for (const [id, vp, scheme] of [
  ["rpui-desktop-light", { width: 1366, height: 900 }, "light"],
  ["rpui-mobile-light", { width: 390, height: 844 }, "light"],
  ["rpui-desktop-dark", { width: 1366, height: 900 }, "dark"],
]) {
  scenario(
    id,
    `Record payment UI (${id.replace("rpui-", "")}): intent, steps, bills summary, remaining money, After recording, header`,
    async ({ page }, chk) => {
      await openForm(page);
      await h.shot(page, `${id}-01-initial`);

      // One top-level intent, three choices (postpone is an action, not a direction).
      const names = await page.getByRole("radio").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")).filter((n) => /^(Money received|Money paid|Not paid yet)/.test(n ?? "")));
      chk("one intent selector: Received / Paid / Not paid yet", names.length === 3, names.join(" | "));
      chk("Received is the default choice", (await radio(page, /Money received from/).getAttribute("aria-checked")) === "true");
      chk("steps are labelled in order", JSON.stringify(await stepTitles(page)) === JSON.stringify(["Money details", "Apply to bills", "Remaining money"]), (await stepTitles(page)).join(" > "));
      chk("Remaining money keeps its place with a calm state before any amount", /Enter an amount|Nothing left to assign/.test(await page.getByTestId("rp-remaining-none").innerText()));
      const fundingBox = await page.getByTestId("rp-in-balance").boundingBox();
      const acctBox = await page.getByText("Receive into account").first().boundingBox();
      // Paired with the account: beside it (same row) on wider screens, directly under it on phones.
      const paired = !!fundingBox && !!acctBox && (vp.width >= 640 ? Math.abs(fundingBox.y - acctBox.y) < 40 && fundingBox.x > acctBox.x :fundingBox.y > acctBox.y && fundingBox.y - acctBox.y < 110);
      chk("Already in my account balance is a visible card paired with the account field", paired, JSON.stringify({ acct: acctBox && [Math.round(acctBox.x), Math.round(acctBox.y)], fund: fundingBox && [Math.round(fundingBox.x), Math.round(fundingBox.y), Math.round(fundingBox.height)] }));
      chk("Step 1 has no large empty gap: amount and date share a row", await page.evaluate(() => {
        const amt = document.querySelector("input[aria-label='Amount received']")?.getBoundingClientRect();
        const date = [...document.querySelectorAll("span,label,p")].find((e) => e.textContent?.trim() === "Date")?.getBoundingClientRect();
        return !!amt && !!date && (window.innerWidth < 640 || Math.abs(date.top - amt.top) < 40);
      }));

      // A typo-sized amount is read back grouped and flagged, not blocked.
      await f.amountField(page).fill("57547654");
      await page.waitForTimeout(300);
      chk("large amount: grouped readout + non-blocking warning", (await page.getByTestId("rp-amount-readout").innerText()) === "₹5,75,47,654" && (await page.getByTestId("rp-amount-high").count()) === 1);
      await h.shot(page, `${id}-01b-large-amount`);

      // Auto → manual allocation, with the live bills summary.
      await f.amountField(page).fill("1500");
      await page.waitForTimeout(400);
      chk("auto mode is announced", /Auto/.test(await page.getByTestId("rp-alloc-mode").innerText()));
      const summary = await page.getByTestId("rp-bills-summary").innerText();
      chk("bills summary shows applied / owed / still owed", /applied to bills/.test(summary) && /still owed/.test(summary), summary);
      chk("leftover goes to Remaining money (advance by default)", /left to use/.test(await page.locator("#rp-remaining-heading").locator("xpath=ancestor::section").innerText()));
      chk("no Add buttons while everything is assigned (no empty rows)", (await page.getByRole("button", { name: /^Add (income|purpose|another purpose)$/ }).count()) === 0 && (await page.getByTestId("rp-add-hint").count()) === 1);
      await h.shot(page, `${id}-02-leftover`);

      await page.getByRole("button", { name: /^Pay part of / }).first().click();
      await page.keyboard.type("200");
      await page.waitForTimeout(300);
      chk("taking over a row switches to Manual and says so", /Manual/.test(await page.getByTestId("rp-alloc-mode").innerText()));
      chk("bill left unpaid while money goes to advance → 'Apply to bills first' nudge", (await page.getByRole("button", { name: "Apply to bills first" }).count()) === 1);
      await h.shot(page, `${id}-03-manual`);

      // Optional follow-ups live in one collapsed section.
      const after = page.getByRole("button", { name: /After recording/ });
      chk("After recording (optional) is collapsed by default", (await after.getAttribute("aria-expanded")) === "false");
      await after.click();
      chk("opening it shows the reminder", (await page.getByRole("radiogroup", { name: "Reminder" }).count()) === 1);
      await h.shot(page, `${id}-04-after`);

      // The sticky header stays on top while the drawer scrolls (the old z-index overlap).
      const scrolled = await scrollDrawer(page, 400);
      await page.waitForTimeout(250);
      const top = await headerOnTop(page);
      chk("header stays above the content while scrolled", !scrolled || top.ok, JSON.stringify(top));
      await h.shot(page, `${id}-05-scrolled`);
      await scrollDrawer(page, 0);

      // Historical account-neutral mode.
      await page.getByTestId("rp-in-balance").getByRole("checkbox").check();
      await page.waitForTimeout(300);
      chk("account-neutral mode: note shown, Remaining money explains nothing can be assigned", /no account changes/.test(await page.getByTestId("rp-in-balance-effect").innerText()) && /Nothing to assign/.test(await page.getByTestId("rp-remaining-none").innerText()));
      await h.shot(page, `${id}-06-in-balance`);
      await page.getByTestId("rp-in-balance").getByRole("checkbox").uncheck();

      // Not paid yet: the no-money form, then back.
      const wait = radio(page, /Not paid yet/);
      if ((await wait.count()) > 0) {
        await wait.click();
        await page.waitForTimeout(400);
        chk("Not paid yet: no amount/account fields, postpone form shown", (await page.getByLabel(/^Amount received$/).count()) === 0 && (await page.getByTestId("rp-postpone").count()) === 1);
        const label = await wait.innerText();
        chk("Not paid yet card text is not truncated", await wait.evaluate((b) => [...b.querySelectorAll("span")].every((s) => s.scrollWidth <= s.clientWidth + 1)), label.replace(/\n/g, " | "));
        await h.shot(page, `${id}-07-postpone`);
        await radio(page, /Money received from/).click();
        chk("back to Received restores the money form", (await page.getByLabel(/^Amount received$/).count()) === 1);
      } else {
        chk.finding("RPUI-1", "Not paid yet is offered for QA Priya's receivable", false, "not offered in this fixture (postponable rows missing)");
      }

      // Paid direction.
      await radio(page, /Money paid to/).click();
      await page.waitForTimeout(300);
      chk("Paid direction: Amount paid + pay-from account", (await page.getByLabel(/^Amount paid$/).count()) === 1 && (await page.getByText("Pay from account").count()) > 0);
      await h.shot(page, `${id}-08-paid`);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
      const primary = page.getByRole("button", { name: /^Record ₹|^Save changes/ }).last();
      const box = await primary.boundingBox().catch(() => null);
      chk("primary button inside the viewport and at least 40px tall", !!box && box.y >= 0 && box.y + box.height <= vp.height + 1 && box.x >= 0 && box.x + box.width <= vp.width + 1 && box.height >= 40, JSON.stringify(box && { y: Math.round(box.y), h: Math.round(box.height), w: Math.round(box.width) }));
    },
    { viewport: vp, scheme },
  );
}
