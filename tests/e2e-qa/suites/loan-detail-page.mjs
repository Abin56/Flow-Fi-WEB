/**
 * Browser QA — the Loan & EMI workspace (ldp-*). Local emulator only, synthetic data.
 * `/loans/<id>/` is one screen: every record in a narrow list on the left, the selected one on the right. Switching records
 * swaps the right panel in place; Record Payment opens as a compact popup over the visible workspace;
 * the selected installment drives its own strip; a shared agreement shows plain People statuses and paying the bank never
 * marks anyone received; old `?agreement=` deep links land on the workspace with their query handed along.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const onDetailPath = () => /^\/loans\/[^/]+\/?$/.test(location.pathname) && !location.pathname.startsWith("/loans/_");
const idFromUrl = (page) => page.evaluate(() => location.pathname.split("/").filter(Boolean)[1]);
const inline = (page) => page.locator("[data-stack-layer]");

async function openFromList(page, name, testId) {
  await h.go(page, "/loans");
  // The card itself (the summary strip names the next payment too, so a plain text match can hit that instead).
  await page.locator('[role="button"]', { hasText: name }).first().click();
  await page.waitForFunction(onDetailPath, null, { timeout: 30000 });
  await page.locator(`[data-testid="${testId}"]`).waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
}

for (const [id, vp, scheme] of [
  ["ldp-emi-desktop", { width: 1440, height: 900 }, "light"],
  ["ldp-emi-desktop-dark", { width: 1440, height: 900 }, "dark"],
]) {
  scenario(id, `Workspace: list left, shared EMI right, inline payment, selected installment, People statuses, switching records (${scheme})`, async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await openFromList(page, "QA Shared EMI", "emi-page");

    // One screen, two panels, no window.
    chk("the left list shows every record", (await page.locator('[data-testid="agreement-nav"] li').count()) >= 3);
    chk("no window is open", (await page.locator("[data-stack-base], [role=dialog]").count()) === 0);
    const fits = await page.evaluate(() => {
      const m = document.querySelector("main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });
    chk("the workspace fits the screen — the page doesn't scroll", fits <= 2, `${fits}px`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("no horizontal overflow", overflow <= 1, `${overflow}px`);
    chk("the primary payment action is visible", await page.getByRole("button", { name: "Record Payment" }).isVisible());
    for (const t of ["Schedule", "Payment history", "People", "Details"]) chk(`tab: ${t}`, (await page.getByRole("tab", { name: new RegExp(t) }).count()) === 1);
    await h.shot(page, `${id}-1-workspace`);

    // The grid + the selected installment.
    const rows = page.locator('[data-testid^="installment-row-"]');
    chk("the schedule is a compact table with a row per installment", (await rows.count()) === 3);
    const rowH = (await rows.first().boundingBox())?.height ?? 99;
    chk("rows are dense (≤ 34px)", rowH <= 34, `${Math.round(rowH)}px`);
    chk("the next installment to pay is selected by default", (await page.locator('[data-testid="installment-row-1"]').getAttribute("aria-selected")) === "true");
    await page.locator('[data-testid="installment-row-2"]').click();
    chk("clicking a row selects it and fills the strip beneath", /installment 2/i.test(await page.locator('[data-testid="installment-detail"]').innerText()));
    chk("a person's share shows beside the installment, Pending until a reimbursement is recorded", /Pending/.test(await page.locator('[data-testid="installment-detail"]').innerText()));
    await page.keyboard.press("ArrowDown");
    chk("↓ moves the selection", (await page.locator('[data-testid="installment-row-3"]').getAttribute("aria-selected")) === "true");
    await h.shot(page, `${id}-2-selected`);

    // Pay inline from the selected installment.
    await page.locator('[data-testid="installment-row-2"]').click();
    await page.locator('[data-testid="installment-detail"]').getByRole("button", { name: /^Pay / }).click();
    await inline(page).waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    const box = await inline(page).boundingBox();
    const nav = await page.locator('[data-testid="agreement-nav"]').boundingBox();
    chk("Pay opens merged into the workspace — no popup, no window", (await page.locator("[role=dialog]").count()) === 0 && !!box);
    chk("the left list stays visible beside it", !!box && !!nav && nav.x + nav.width <= box.x + 1, `nav right ${Math.round((nav?.x ?? 0) + (nav?.width ?? 0))}, form left ${Math.round(box?.x ?? 0)}`);
    chk("it is the existing form, on the picked installment", /Installment #2 of 3/.test(await inline(page).innerText()));
    await h.shot(page, `${id}-3-inline-payment`);
    await inline(page).getByRole("button", { name: "Back" }).first().click();
    await inline(page).waitFor({ state: "detached", timeout: 10000 });
    chk("closing returns to the schedule with the same installment selected", (await page.locator('[data-testid="installment-row-2"]').getAttribute("aria-selected")) === "true");

    // A due installment: the People question (already paid you?) in its compact form.
    await page.locator('[data-testid="installment-row-1"]').click();
    await page.locator('[data-testid="installment-detail"]').getByRole("button", { name: /^Pay / }).click();
    await inline(page).waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    chk("a due, shared installment asks whether they already paid — in one compact line", (await inline(page).getByRole("region", { name: "Has their share been paid?" }).count()) === 1);
    await h.shot(page, `${id}-3d-question`);
    await inline(page).getByRole("radio", { name: "No, not yet" }).click();
    await page.waitForTimeout(400);
    await h.shot(page, `${id}-3e-answered`);
    await inline(page).getByRole("button", { name: "Back" }).first().click();
    await inline(page).waitFor({ state: "detached", timeout: 10000 });
    await page.locator('[data-testid="installment-row-2"]').click();

    // Header action: Record Payment, then Past payment, both inline.
    await page.getByRole("button", { name: "Record past payments" }).click();
    await inline(page).waitFor({ timeout: 30000 });
    chk("Record past payments opens in the same place", await inline(page).isVisible());
    await page.waitForTimeout(500);
    await h.shot(page, `${id}-3b-past`);
    await inline(page).getByRole("radio", { name: /pay several/i }).click();
    await page.waitForTimeout(500);
    await h.shot(page, `${id}-3c-several`);
    await inline(page).getByRole("button", { name: "Back" }).first().click();
    await inline(page).waitFor({ state: "detached", timeout: 10000 });

    // People tab.
    await page.getByRole("tab", { name: /People/ }).click();
    await page.waitForTimeout(400);
    const people = page.locator('[data-testid="agreement-people"]');
    chk("People tab lists the sharing people with plain statuses", (await people.locator("section").count()) >= 1 && /Pending|Received|Partially received|Postponed/.test(await people.innerText()));
    chk("each person has Record received and Postpone", (await people.getByRole("link", { name: /Record money received/ }).count()) >= 1 && (await people.getByRole("link", { name: /Postpone collecting/ }).count()) >= 1);
    await h.shot(page, `${id}-4-people`);
    await page.getByRole("tab", { name: /Schedule/ }).click();
    chk("returning to Schedule keeps the selection", (await page.locator('[data-testid="installment-row-2"]').getAttribute("aria-selected")) === "true");

    // Switch records without leaving the screen.
    const before = await idFromUrl(page);
    await page.locator('[data-testid="agreement-nav"]').getByText("QA Loan 12").first().click();
    await page.locator('[data-testid="loan-page"]').waitFor({ timeout: 30000 });
    const after = await idFromUrl(page);
    chk("picking another record swaps the right panel in place", before !== after && (await page.locator("[role=dialog]").count()) === 0);
    chk("the new record's schedule is shown", (await page.locator('[data-testid^="installment-row-"]').count()) === 12);
    await h.shot(page, `${id}-5-loan`);

    // The list page is still there.
    await page.locator('[data-testid="agreement-nav"]').getByRole("link").first().click();
    await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/loans", null, { timeout: 30000 });
    chk("the Loan & EMI list page is still reachable", true);
  }, { viewport: vp, scheme });
}

scenario("ldp-loan-and-deeplink", "A Loan opens in the workspace; ?agreement= deep links (with pay=1) redirect to it and reopen Record Payment inline", async ({ page }, chk) => {
  await openFromList(page, "QA Loan 12", "loan-page");
  const id = await idFromUrl(page);
  await h.go(page, "/loans");
  await page.evaluate((x) => window.next.router.push(`/loans?agreement=${x}&pay=1`), id);
  const landed = await page
    .waitForFunction((x) => location.pathname.includes(x), id, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  chk("an old ?agreement= link lands on the record's own workspace", landed, await page.evaluate(() => location.pathname + location.search));
  if (!landed) return;
  await page.locator('[data-testid="loan-page"]').waitFor({ timeout: 30000 });
  chk("the agreement param is consumed", !(await page.evaluate(() => location.search.includes("agreement="))));
  const form = await inline(page).waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  chk("pay=1 reopens Record Payment in the workspace", form && (await page.locator("[role=dialog]").count()) === 0);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("ldp-not-found", "An unknown id shows a plain not-found with a way back", async ({ page }, chk) => {
  await h.go(page, "/loans");
  await page.evaluate(() => window.next.router.push("/loans/does-not-exist/"));
  await page.locator('[data-testid="agreement-not-found"]').waitFor({ timeout: 30000 });
  chk("not-found offers Back to Loan & EMI", (await page.getByRole("link", { name: /Back to Loan & EMI/ }).count()) === 1);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
