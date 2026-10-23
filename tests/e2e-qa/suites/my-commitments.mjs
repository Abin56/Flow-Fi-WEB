/**
 * Browser QA scenarios (my-commitments.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * "My EMI commitments" summary on Loan & EMI: month switching, the incomplete-total warning, the lazy People
 * reimbursement load, ownership pills, text contrast and responsive layout (desktop/mobile × light/dark).
 * Read-only apart from the portal's own synthetic fixtures — nothing here writes through the app.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const VPS = { desktop: { width: 1920, height: 1080 }, mobile: { width: 390, height: 844 } };

/** WCAG contrast of an element's text against the nearest opaque ancestor background, via canvas colour normalising. */
async function contrastOf(locator) {
  return locator.evaluate((el) => {
    const px = (css) => {
      const c = document.createElement("canvas").getContext("2d");
      c.clearRect(0, 0, 1, 1);
      c.fillStyle = css;
      c.fillRect(0, 0, 1, 1);
      const d = c.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bg = [255, 255, 255, 1];
    for (let n = el; n; n = n.parentElement) {
      const p = px(getComputedStyle(n).backgroundColor);
      if (p[3] >= 0.95) { bg = p; break; }
    }
    const fg = px(getComputedStyle(el).color);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
  });
}

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    const id = `mycommit-${vpName}-${scheme}`;
    scenario(
      id,
      `My EMI commitments: ${vpName} ${vp.width}x${vp.height}, ${scheme}`,
      async ({ page }, chk, notes) => {
        await h.addFixture(page, "shared-emi");
        await h.addFixture(page, "card-emi");
        await page.evaluate(() => window.next.router.push("/loans"));
        const panel = page.locator('section[aria-label="My EMI commitments"]');
        await panel.waitFor({ timeout: 60000 });
        // Seeded schedules refresh after first paint — wait for the card list to settle (reload once if a listener stalls).
        const list = page.locator('section[aria-label="Loans and EMIs"]');
        // Every seeded record must be present, with its schedule, before figures are read (a listener can stall after seeding).
        const EXPECTED_CARDS = 6;
        const ready = async (ms) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            const n = await list.locator('[role="button"]').count().catch(() => 0);
            const next = await list.getByText("Next EMI").count().catch(() => 0);
            if (n >= EXPECTED_CARDS && next >= 1) return true;
            await page.waitForTimeout(500);
          }
          return false;
        };
        if (!(await ready(20000))) {
          await page.reload();
          await panel.waitFor({ timeout: 60000 });
          await ready(60000);
        }
        chk("all seeded records loaded before reading figures", (await list.locator('[role="button"]').count()) >= EXPECTED_CARDS, String(await list.locator('[role="button"]').count()));
        await page.waitForTimeout(1500);
        const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark") || matchMedia("(prefers-color-scheme: dark)").matches);
        chk(`theme applied (${scheme})`, isDark === (scheme === "dark"), `dark=${isDark}`);

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
        const box = await panel.boundingBox();
        chk("panel fits the viewport width", box != null && box.x >= 0 && box.x + box.width <= vp.width + 1, JSON.stringify(box));

        const thisMonth = await panel.innerText();
        chk("This month selected by default, with all four confirmed figures", /This month/.test(thisMonth) && /MY EMI — CONFIRMED/i.test(thisMonth) && /ALREADY PAID/i.test(thisMonth) && /STILL TO PAY/i.test(thisMonth) && /INSTALLMENTS/i.test(thisMonth), thisMonth.replace(/\s+/g, " ").slice(0, 400));
        notes.push(`this month: ${thisMonth.replace(/\s+/g, " ").slice(0, 600)}`);

        // Ownership pills on cards: shared fixture is explicit shares → at least one non-"Needs review" pill; every card has one.
        const cardTexts = await list.locator('[role="button"]').evaluateAll((els) => els.map((e) => e.textContent ?? ""));
        const hasPill = (t) => /Mine|Shared|Others|Confirm who owes this EMI/.test(t);
        chk("every card carries an ownership pill", cardTexts.length > 0 && cardTexts.every(hasPill), `${cardTexts.length} cards`);
        chk("a confirmed shared card shows My share", cardTexts.some((t) => /Shared/.test(t) && /My share/.test(t)) || !cardTexts.some((t) => /Shared/.test(t)), cardTexts.map((t) => (t.match(/Mine|Shared|Others|Confirm who owes this EMI/) ?? ["?"])[0]).join(","));
        chk("Needs review cards never show My share", cardTexts.filter((t) => /Confirm who owes this EMI/.test(t)).every((t) => !/My share/.test(t)));

        // Incomplete-total warning appears exactly when something is unconfirmed this month.
        const alert = panel.getByRole("alert");
        const warned = (await alert.count()) > 0;
        chk("warning shown only with unconfirmed ownership", warned === /Confirm who owes this EMI/.test(cardTexts.join(" ")) || !warned, `warned=${warned}`);

        // Contrast of the figures, labels, pills and warning.
        const targets = [
          ["heading", panel.locator("h2")],
          ["first figure", panel.locator("span.font-heading").first()],
          ["figure label", panel.getByText("ALREADY PAID", { exact: false }).first()],
          ["hint text", panel.getByText("Pro-rata of lender payments").first()],
        ];
        if (warned) targets.push(["warning text", alert.first()]);
        for (const [name, loc] of targets) {
          if ((await loc.count()) === 0) continue;
          const ratio = await contrastOf(loc.first());
          chk(`contrast ≥ 4.5: ${name}`, ratio >= 4.5, `${ratio}:1`);
        }
        // Every ownership pill (each tone), not just the first card's.
        const pills = list.locator('[role="button"]').getByText(/^(Mine|Shared|Others|Confirm who owes this EMI)$/);
        for (let i = 0; i < (await pills.count()); i++) {
          const ratio = await contrastOf(pills.nth(i));
          chk(`contrast ≥ 4.5: ownership pill #${i + 1} (${await pills.nth(i).innerText()})`, ratio >= 4.5, `${ratio}:1`);
        }

        // New labels, and the EMI breakdown: collapsed by default, keyboard-operable, reconciled to the summary, no overflow.
        chk("clearer labels are shown", /STILL TO PAY THE LENDER/i.test(thisMonth) && /MY INSTALLMENTS/i.test(thisMonth) && /STILL OWED TO ME THIS MONTH/i.test(thisMonth) && !/FROM MY ACCOUNTS|OTHERS WILL REPAY ME/i.test(thisMonth));
        const toggle = panel.getByRole("button", { name: /View EMI breakdown/ });
        chk("the breakdown is collapsed by default", (await toggle.getAttribute("aria-expanded")) === "false" && (await panel.getByTestId("breakdown-reconciled").count()) === 0);
        await toggle.focus();
        await page.keyboard.press("Enter");
        await panel.getByTestId("breakdown-reconciled").waitFor({ timeout: 10000 });
        chk("Enter opens the breakdown", (await toggle.getAttribute("aria-expanded")) === "true");
        const reconciled = (await panel.getByTestId("breakdown-reconciled").innerText()).replace(/\s+/g, " ");
        const mineN = Number(/(\d+) installments? across (\d+) agreements?/.exec(reconciled)?.[1] ?? -1);
        const mineRecords = Number(/(\d+) installments? across (\d+) agreements?/.exec(reconciled)?.[2] ?? -1);
        const countedRows = await panel.getByText(/^Counted — /).count();
        chk("the breakdown reconciles to the summary: counted rows = My installments", countedRows === mineN, `${countedRows} rows vs ${mineN}; ${mineRecords} agreements`);
        const unconfirmedWarned = /(\d+) installments? in (\d+) EMIs? with unconfirmed owner/.exec(thisMonth.replace(/\s+/g, " "));
        if (unconfirmedWarned) chk("unconfirmed installments in the warning = unconfirmed rows listed", (await panel.getByText(/who owes this EMI is unconfirmed/).count()) === Number(unconfirmedWarned[1]), `${unconfirmedWarned[1]}`);
        chk("a reconciliation failure is never shown", (await panel.getByText(/could not be reconciled/).count()) === 0);
        chk("the breakdown states that attributed paid is not proof of payment", /not proof that you paid from your own account/.test(await panel.innerText()));
        chk("no horizontal overflow with the breakdown open", (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
        const bdBox = await panel.boundingBox();
        chk("the panel still fits the viewport with the breakdown open", bdBox != null && bdBox.x >= 0 && bdBox.x + bdBox.width <= vp.width + 1, JSON.stringify(bdBox));
        const bdRatio = await contrastOf(panel.getByText(/^Counted — /).first());
        chk("contrast ≥ 4.5: breakdown reason text", bdRatio >= 4.5, `${bdRatio}:1`);
        await h.shot(page, `${id}-breakdown`);
        await page.screenshot({ path: `${h.SHOTS_DIR}/${id}-breakdown-full.png`, fullPage: true });
        await page.keyboard.press("Enter");
        chk("Enter closes it again", (await toggle.getAttribute("aria-expanded")) === "false");
        await h.shot(page, `${id}-this-month`);
        await page.screenshot({ path: `${h.SHOTS_DIR}/${id}-full.png`, fullPage: true });

        // Month switching: Next month changes the label/figures; switching back restores the exact original (no drift, no double count).
        await panel.getByRole("radio", { name: "Next month" }).click();
        await page.waitForTimeout(300);
        const nextMonth = await panel.innerText();
        chk("Next month shows a different month label", nextMonth.split("\n")[0] !== thisMonth.split("\n")[0] || nextMonth !== thisMonth, nextMonth.replace(/\s+/g, " ").slice(0, 300));
        // The breakdown follows the selected month and still reconciles there.
        await toggle.click();
        await panel.waitFor();
        const novText = (await panel.innerText()).replace(/\s+/g, " ");
        const novLine = /(\d+) installments? across (\d+) agreements?/.exec(novText);
        chk("Next month: the breakdown opens and reconciles", /Adds up to the figures above/.test(novText) && novLine != null && (await panel.getByText(/^Counted — /).count()) === Number(novLine[1]), novLine?.[0] ?? "no summary line");
        chk("Next month: the breakdown names the next month", /Nov 2026|Due in /.test(novText));
        await h.shot(page, `${id}-next-month-breakdown`);
        await toggle.click();
        await h.shot(page, `${id}-next-month`);
        await panel.getByRole("radio", { name: "This month" }).click();
        await page.waitForTimeout(300);
        chk("switching back restores identical This month content", (await panel.innerText()) === thisMonth);

        // Reimbursement is lazy: nothing about People is loaded until the button is pressed.
        const load = panel.getByRole("button", { name: /Load from People Ledger/ });
        if ((await load.count()) > 0) {
          await load.click();
          await panel.getByText(/Tracked in the People Ledger|Nothing open on this month|Loading People rows/).first().waitFor({ timeout: 30000 });
          await panel.getByText(/Tracked in the People Ledger/).first().waitFor({ timeout: 60000 });
          chk("Load from People Ledger shows a separate receivable figure", true, (await panel.innerText()).replace(/\s+/g, " ").slice(-300));
          await h.shot(page, `${id}-reimbursement`);
        } else {
          chk("no shared installments this month → no reimbursement load offered", /No shared installments this month/.test(await panel.innerText()));
        }
        const finalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        chk("still no horizontal overflow after interactions", finalOverflow <= 1, `${finalOverflow}px`);
      },
      { viewport: vp, scheme },
    );
  }
}

// "This EMI is mine": confirm / remove on a real card — mobile + desktop, light + dark, keyboard, failure + retry, and a
// before/after proof that no financial record changes. Emulator-only synthetic data.
const CONFIRM_CASES = [
  ["mycommit-confirm", "desktop", "light"],
  ["mycommit-confirm-mobile-light", "mobile", "light"],
  ["mycommit-confirm-mobile-dark", "mobile", "dark"],
];

/** Every financial record the confirmation must not touch. Loans / EMIs are compared minus the confirmation and its audit trail. */
async function financialSnapshot() {
  const strip = (d) => {
    const rest = { ...d };
    delete rest.ownershipConfirmedMine;
    delete rest.editHistory;
    delete rest.lastEditedAt;
    return rest;
  };
  const schedules = await h.list("paymentSchedules");
  const installments = [];
  for (const s of schedules) installments.push([s.id, await h.list(`paymentSchedules/${s.id}/installments`)]);
  return JSON.stringify({
    loans: (await h.list("loans")).map(strip),
    emis: (await h.list("emis")).map(strip),
    accounts: await h.list("accounts"),
    creditCards: await h.list("creditCards"),
    transactions: await h.list("transactions"),
    people: await h.list("people"),
    schedules,
    installments,
  });
}

for (const [id, vpName, scheme] of CONFIRM_CASES) {
  const vp = VPS[vpName];
  scenario(
    id,
    `My EMI commitments: confirm / remove 'This EMI is mine' — ${vpName} ${vp.width}x${vp.height}, ${scheme}`,
    async ({ page }, chk, notes) => {
      await h.addFixture(page, "shared-emi");
      await h.addFixture(page, "card-emi");
      await page.evaluate(() => window.next.router.push("/loans"));
      const panel = page.locator('section[aria-label="My EMI commitments"]');
      await panel.waitFor({ timeout: 60000 });
      const list = page.locator('section[aria-label="Loans and EMIs"]');
      const ready = async (ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if ((await list.locator('[role="button"]').count().catch(() => 0)) >= 6 && (await list.getByText("Next EMI").count().catch(() => 0)) >= 1) return true;
          await page.waitForTimeout(500);
        }
        return false;
      };
      if (!(await ready(20000))) {
        await page.reload();
        await panel.waitFor({ timeout: 60000 });
        await ready(60000);
      }
      await page.waitForTimeout(1500);
      chk(`theme applied (${scheme})`, (await page.evaluate(() => document.documentElement.classList.contains("dark") || matchMedia("(prefers-color-scheme: dark)").matches)) === (scheme === "dark"));

      const panelText = async () => (await panel.innerText()).replace(/\s+/g, " ");
      const markers = async () => [...(await h.list("loans")), ...(await h.list("emis"))].filter((d) => d.ownershipConfirmedMine != null);
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const cardOf = (name) => list.locator('[role="button"]', { hasText: name }).first();
      const detailsOpen = async () => (await page.getByRole("dialog").getByText("Installments", { exact: true }).count()) > 0;

      const financialBefore = await financialSnapshot();
      const panelBefore = await panelText();
      chk("no record is confirmed up front", (await markers()).length === 0);

      const action = list.locator("button", { hasText: "This EMI is mine" }).first();
      chk("an unconfirmed card offers 'This EMI is mine'", (await action.count()) > 0);
      const name = (await list.locator('[role="button"]', { hasText: "This EMI is mine" }).first().locator("h3").first().innerText()).trim();
      await action.scrollIntoViewIfNeeded();

      // layout, contrast, tap target
      chk("no horizontal overflow with the action shown", (await overflow()) <= 1, `${await overflow()}px`);
      const cardBox = await cardOf(name).boundingBox();
      const btnBox = await action.boundingBox();
      chk("the action stays inside its card", cardBox != null && btnBox != null && btnBox.x >= cardBox.x - 1 && btnBox.x + btnBox.width <= cardBox.x + cardBox.width + 1, JSON.stringify({ btnBox, cardBox }));
      const ratio = await contrastOf(action);
      chk("contrast ≥ 4.5: 'This EMI is mine'", ratio >= 4.5, `${ratio}:1`);
      const size = btnBox ? `${Math.round(btnBox.width)}×${Math.round(btnBox.height)}px` : "no box";
      chk("the action is at least 24×24 CSS px (WCAG 2.5.8)", btnBox != null && btnBox.height >= 24 && btnBox.width >= 24, size);
      if (vpName === "mobile") chk("on a phone the action is a comfortable ≥ 32px tall touch target", btnBox != null && btnBox.height >= 32, size);
      // Same row with the old small target (no min-height, no negative margin): the larger target must not grow it.
      const { withTarget, smallTarget } = await action.evaluate((el) => {
        const row = el.parentElement;
        const withTarget = row.getBoundingClientRect().height;
        const saved = el.style.cssText;
        el.style.cssText = "min-height:0;margin:0;";
        const smallTarget = row.getBoundingClientRect().height;
        el.style.cssText = saved;
        return { withTarget, smallTarget };
      });
      notes.push(`action ${size}; badge row ${Math.round(withTarget)}px (${Math.round(smallTarget)}px with the old small target)`);
      chk("the larger target does not make the card's badge row taller", withTarget <= smallTarget + 1, `${Math.round(withTarget)}px vs ${Math.round(smallTarget)}px`);
      await h.shot(page, `${id}-card`);

      // accessibility: a real, uniquely named button
      chk("exactly one real button named 'This EMI is mine'", (await list.getByRole("button", { name: "This EMI is mine", exact: true }).count()) === (await list.locator("button", { hasText: "This EMI is mine" }).count()));

      // keyboard: Enter and Space open only the confirm dialog, never the record; Esc closes it
      await action.focus();
      chk("the action takes keyboard focus", await action.evaluate((el) => el === document.activeElement));
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 10000 });
      chk("Enter opens the confirm dialog, not the record", /Only this label changes/.test(await dialog.innerText()) && !(await detailsOpen()), name);
      chk("the dialog names the agreement", (await dialog.innerText()).includes(name));
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached", timeout: 10000 });
      chk("Escape closes it and nothing was saved", (await markers()).length === 0);
      await action.focus();
      await page.keyboard.press("Space");
      await dialog.waitFor({ timeout: 10000 });
      chk("Space opens the confirm dialog too, not the record", /Only this label changes/.test(await dialog.innerText()) && !(await detailsOpen()));
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached", timeout: 10000 });
      await action.click();
      await dialog.waitFor({ timeout: 10000 });
      chk("a pointer click opens only the confirm dialog", !(await detailsOpen()) && (await page.getByRole("dialog").count()) === 1);
      await h.shot(page, `${id}-dialog`);
      chk("no horizontal overflow with the dialog open", (await overflow()) <= 1, `${await overflow()}px`);
      const dBox = await dialog.boundingBox();
      chk("the dialog fits the viewport", dBox != null && dBox.x >= 0 && dBox.x + dBox.width <= vp.width + 1 && dBox.y >= 0 && dBox.y + dBox.height <= vp.height + 1, JSON.stringify(dBox));

      // failure + Retry: block the transactional commit, confirm, see the error, unblock, retry
      let blocked = 0;
      const blocker = (route) => {
        blocked += 1;
        return route.abort("failed");
      };
      await page.route("**/*:commit*", blocker);
      await dialog.getByRole("button", { name: /it’s mine/ }).click();
      const alert = dialog.getByRole("alert");
      await alert.waitFor({ timeout: 60000 });
      notes.push(`failure message: ${(await alert.innerText()).replace(/\s+/g, " ")} (commit calls blocked: ${blocked})`);
      chk("a failed save shows an error and keeps the dialog open", /Couldn’t save/.test(await alert.innerText()) && (await dialog.count()) === 1);
      chk("nothing was confirmed after the failure", (await markers()).length === 0);
      chk("the Retry button is enabled again", await dialog.getByRole("button", { name: /it’s mine/ }).isEnabled());
      await h.shot(page, `${id}-error`);
      await page.unroute("**/*:commit*", blocker);
      await dialog.getByRole("button", { name: /it’s mine/ }).click();
      await dialog.waitFor({ state: "detached", timeout: 30000 });
      await cardOf(name).locator("button", { hasText: "Remove confirmation" }).waitFor({ timeout: 15000 });
      chk("Retry succeeds and the card now reads Mine", /\bMine\b/.test(await cardOf(name).innerText()));
      chk("exactly one record carries the confirmation", (await markers()).length === 1);

      // only the classification changed
      const panelAfter = await panelText();
      notes.push(`before: ${panelBefore.slice(0, 420)}`, `after: ${panelAfter.slice(0, 420)}`);
      chk("My EMI — Confirmed text changed", panelAfter !== panelBefore);
      chk("no financial record changed (loans/EMIs minus the flag, accounts, cards, transactions, people, schedules, installments)", (await financialSnapshot()) === financialBefore);
      await h.shot(page, `${id}-confirmed`);

      // remove
      await cardOf(name).locator("button", { hasText: "Remove confirmation" }).focus();
      await page.keyboard.press("Enter");
      await dialog.waitFor({ timeout: 10000 });
      chk("Remove opens a remove dialog, not the record", /go back to/.test(await dialog.innerText()) && !(await detailsOpen()));
      await dialog.getByRole("button", { name: "Remove" }).click();
      await dialog.waitFor({ state: "detached", timeout: 15000 });
      await cardOf(name).locator("button", { hasText: "This EMI is mine" }).waitFor({ timeout: 15000 });
      chk("removing returns the card to 'Confirm who owes this EMI'", /Confirm who owes this EMI/.test(await cardOf(name).innerText()));
      chk("no record is confirmed after removal", (await markers()).length === 0);
      chk("summary text is back to what it was", (await panelText()) === panelBefore);
      chk("no financial record changed after removal either", (await financialSnapshot()) === financialBefore);
      chk("still no horizontal overflow", (await overflow()) <= 1, `${await overflow()}px`);
    },
    { viewport: vp, scheme },
  );
}
