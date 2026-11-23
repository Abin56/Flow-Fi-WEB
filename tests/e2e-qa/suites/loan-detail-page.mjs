/**
 * Browser QA — the Loan & EMI workspace (ldp-*). Local emulator only, synthetic data.
 * `/loans/<id>/` is one screen: every record in a narrow list on the left, the selected one on the right. Switching records
 * swaps the right panel in place; Record Payment opens as a compact popup over the visible workspace;
 * the selected installment drives its own strip; a shared agreement shows plain People statuses and paying the bank never
 * marks anyone received; old `?agreement=` deep links land on the workspace with their query handed along.
 */
import { scenario } from "../lib/core.mjs";
import { FIRESTORE_DOCS } from "../lib/env.mjs";
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
    for (const section of ["Payment history", "People", "Details", "Schedule"]) {
      const tab = page.getByRole("tab", { name: new RegExp(`^${section}`) });
      await tab.click();
      const panel = page.getByRole("tabpanel", { name: section, exact: true });
      chk(`${section} stays usable with a payment draft`, (await panel.isVisible()) && !(await inline(page).isVisible()) && (await tab.getAttribute("aria-selected")) === "true");
    }
    await page.getByRole("tab", { name: "Open form" }).click();
    chk("returning to the form keeps the reimbursement answer", (await inline(page).getByRole("radio", { name: "No, not yet" }).getAttribute("aria-checked")) === "true");
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
  if (!form) return;
  const payment = inline(page);
  const fields = await payment.getByTestId("pay-card").boundingBox();
  const review = await payment.getByRole("complementary", { name: "Reimbursements and payment review" }).boundingBox();
  chk("loan fields and review fit side by side", !!fields && !!review && fields.x + fields.width <= review.x);
  const breakdown = payment.getByTestId("payment-impact");
  chk("the detailed breakdown starts collapsed", await breakdown.evaluate((element) => element.closest("details")?.open === false));
  const account = await payment.getByRole("combobox", { name: "Paid from account" }).boundingBox();
  const body = await payment.getByTestId("layer-body").boundingBox();
  chk("the paying account is within view before scrolling", !!account && !!body && account.y + account.height <= body.y + body.height);
  await h.shot(page, "ldp-loan-payment-layout");
  await payment.getByRole("radio", { name: /paid directly/i }).click();
  chk("the direct payment uses the same form and labels the reference account", await payment.getByLabel("Account for this record").isVisible());
  await h.shot(page, "ldp-loan-direct-layout");
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("tab", { name: "Open form" }).click();
  await payment.getByRole("button", { name: "Back", exact: true }).click();
  chk("Back returns to the last page tab used", await page.getByRole("tabpanel", { name: "Details", exact: true }).isVisible());
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("ldp-shared-loan-workflows", "A shared loan uses the same payment workspace for direct, past, and multiple installments", async ({ page }, chk) => {
  const uid = await h.authUid();
  const loan = (await h.list("loans")).find((row) => row.name === "QA Loan 12");
  const person = (await h.list("people")).find((row) => row.name === "QA Priya");
  const schedule = `paymentSchedules/${loan.scheduleId}/installments`;
  const installments = (await h.list(schedule)).filter((i) => !i.isSkipped && i.amountDue > (i.amountPaid ?? 0)).sort((a, b) => a.sequenceNumber - b.sequenceNumber).slice(0, 2);
  const patchFixture = async (path, fields) => {
    const url = new URL(`${FIRESTORE_DOCS}/users/${uid}/${path}`);
    for (const name of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", name);
    const result = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
    if (!result.ok) throw new Error(`Synthetic shared loan setup failed (${result.status})`);
  };
  await Promise.all([
    patchFixture(`loans/${loan.id}`, { beneficiaryPersonId: { stringValue: person.id }, beneficiaryRepaysInstallments: { booleanValue: true } }),
    ...installments.map((i, index) => patchFixture(`${schedule}/${i.id}`, { dueDate: { timestampValue: new Date(Date.now() - (2 - index) * 86400000).toISOString() } })),
  ]);

  await openFromList(page, "QA Loan 12", "loan-page");
  await page.getByTestId("installment-detail").getByRole("button", { name: /^Pay lender/ }).click();
  const payment = inline(page);
  await payment.getByRole("region", { name: "Has their share been paid?" }).waitFor();
  chk("the reimbursement question opens without a duplicate locked card", (await payment.getByTestId("pay-card-locked").count()) === 0);
  await h.shot(page, "ldp-shared-loan-1-payer");

  await payment.getByRole("radio", { name: "QA Priya paid directly" }).click();
  const shares = payment.getByRole("region", { name: "People sharing it" });
  await shares.getByRole("radio", { name: "Cover part", exact: true }).click();
  await shares.getByLabel("Amount covered for QA Priya").fill("100");
  await shares.getByRole("radio", { name: "Record without balance change" }).click();
  await shares.getByRole("button", { name: "Set reminder" }).click();
  chk("direct payment exposes partial coverage and an optional reminder", await shares.getByLabel("Reminder date").isVisible());
  await shares.getByRole("button", { name: "Remove reminder" }).click();
  chk("removing the reminder returns to a single action", (await shares.getByLabel("Reminder date").count()) === 0 && await shares.getByRole("button", { name: "Set reminder" }).isVisible());
  await h.shot(page, "ldp-shared-loan-2-direct");

  const selectInstallments = async (mode) => {
    await payment.getByRole("radio", { name: mode }).click();
    for (const i of installments) {
      const checkbox = payment.getByRole("checkbox", { name: `#${i.sequenceNumber}`, exact: true });
      if (!(await checkbox.isChecked())) await checkbox.check();
    }
  };
  await selectInstallments("Past payment");
  chk("past selection displays its live total and zero lender debit", await payment.getByText("Selected amount", { exact: true }).isVisible() && await payment.getByText("Lender account debit", { exact: true }).isVisible());
  await h.shot(page, "ldp-shared-loan-3-past-select");
  await payment.getByRole("button", { name: "Continue with 2 installments" }).click();
  await payment.getByRole("radio", { name: /Each on its due date/ }).click();
  await payment.getByLabel("Account (record only)").click();
  await page.getByRole("option").first().click();
  await payment.getByRole("button", { name: "Continue to people's shares" }).click();
  await payment.getByRole("button", { name: "Continue to review" }).click();
  chk("past review keeps the lender account movement explicit", /₹0/.test(await payment.getByTestId("bulk-effect").innerText()));
  await h.shot(page, "ldp-shared-loan-4-past-review");

  await selectInstallments("Pay several");
  await payment.getByRole("button", { name: /^Review 2 installments/ }).click();
  await payment.getByRole("radiogroup", { name: `Who paid #${installments[1].sequenceNumber}`, exact: true }).getByRole("radio", { name: "Paid by someone else" }).click();
  chk("mixed-payer review displays the account total and direct payment count", await payment.getByText("From your account", { exact: true }).isVisible() && await payment.getByText(/1 paid directly/).isVisible());
  await h.shot(page, "ldp-shared-loan-5-several-review");
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("ldp-recorded-payment", "Recorded payment stays compact with lender details, People, and correction actions", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await openFromList(page, "QA Shared EMI", "emi-page");
  await page.getByTestId("installment-detail").getByRole("button", { name: /^Pay / }).click();
  const layer = inline(page);
  await layer.getByRole("radio", { name: "No, not yet" }).click();
  await layer.getByRole("combobox", { name: "Paid from account" }).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await layer.getByRole("button", { name: /^Pay ₹[\d,.]+ to lender$/ }).click();
  await layer.waitFor({ state: "detached", timeout: 30000 });

  await page.getByRole("tab", { name: /Payment history/ }).click();
  await page.getByRole("button", { name: /view payment/i }).click();
  const summary = layer.getByTestId("recorded-payment-summary");
  await summary.waitFor();
  const details = summary.getByRole("region", { name: "Payment details" });
  const people = summary.getByRole("complementary", { name: "People reimbursements" });
  await people.getByText("Nothing received yet", { exact: true }).waitFor();
  const [frame, main, side] = await Promise.all([summary.boundingBox(), details.boundingBox(), people.boundingBox()]);
  chk("lender and People details sit side by side in a bounded summary", frame.width <= 880 && main.x + main.width <= side.x && Math.abs(main.y - side.y) <= 1, `${Math.round(frame.width)}px wide`);
  chk("the account, installment status, and reimbursement actions are visible", await details.getByText("QA Bank", { exact: true }).isVisible() && await details.getByText("Installment settled").isVisible() && await people.getByRole("link", { name: /Record money received.*QA Priya/ }).isVisible());

  const undo = layer.getByRole("button", { name: "Mark as unpaid", exact: true });
  const edit = layer.getByRole("button", { name: "Edit payment", exact: true });
  const [undoBox, editBox] = await Promise.all([undo.boundingBox(), edit.boundingBox()]);
  chk("corrections share one compact action bar", undoBox.width < 200 && Math.abs(undoBox.y - editBox.y) <= 1);
  await h.shot(page, "ldp-recorded-payment-summary");
  await undo.click();
  await layer.getByRole("heading", { name: "Mark as unpaid?" }).waitFor();
  await layer.getByRole("button", { name: "Keep payment" }).click();
  await edit.click();
  await layer.getByRole("heading", { name: "Edit payment" }).waitFor();
  await layer.getByRole("button", { name: "Back", exact: true }).click();
  await layer.getByRole("button", { name: "Close", exact: true }).click();
  chk("the sheet returns to Payment history after both correction views", await page.getByRole("tabpanel", { name: "Payment history", exact: true }).isVisible());
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("ldp-not-found", "An unknown id shows a plain not-found with a way back", async ({ page }, chk) => {
  await h.go(page, "/loans");
  await page.evaluate(() => window.next.router.push("/loans/does-not-exist/"));
  await page.locator('[data-testid="agreement-not-found"]').waitFor({ timeout: 30000 });
  chk("not-found offers Back to Loan & EMI", (await page.getByRole("link", { name: /Back to Loan & EMI/ }).count()) === 1);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
