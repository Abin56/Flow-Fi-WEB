/**
 * Browser QA — the Loan & EMI workspace (ldp-*). Local emulator only, synthetic data.
 * `/loans/<id>/` is one screen: every record in a narrow list on the left, the selected one on the right. Switching records
 * swaps the right panel in place; Record Payment opens as a compact popup over the visible workspace;
 * the selected installment drives its own strip; a shared agreement shows plain People statuses and paying the bank never
 * marks anyone received; old `?agreement=` deep links land on the workspace with their query handed along.
 */
import { scenario } from "../lib/core.mjs";
import { FIRESTORE_DOCS } from "../lib/env.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const onDetailPath = () => /^\/loans\/[^/]+\/?$/.test(location.pathname) && !location.pathname.startsWith("/loans/_");
const idFromUrl = (page) => page.evaluate(() => location.pathname.split("/").filter(Boolean)[1]);
const inline = (page) => page.locator("[data-stack-layer]");

async function patchFixture(path, fields) {
  const uid = await h.authUid();
  const url = new URL(`${FIRESTORE_DOCS}/users/${uid}/${path}`);
  for (const name of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", name);
  const result = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!result.ok) throw new Error(`Synthetic fixture setup failed (${result.status})`);
}

async function openInstallmentPayment(page, name, kind = "emi") {
  await openFromList(page, name, `${kind}-page`);
  await page.getByTestId("installment-detail").getByRole("button", { name: /^Pay Now/ }).click();
  await inline(page).getByTestId("pay-card").waitFor();
  return inline(page);
}

async function selectQaBank(page, field) {
  await field.click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
}

scenario("receipt-workflow-past", "Past Payment posts the selected full receipt to its specific historical share", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const name = "QA Shared EMI";
  const [first] = await f.scheduleState("emi", name);
  const people = await h.list("people");
  const priya = people.find((p) => p.name === "QA Priya");
  const ravi = people.find((p) => p.name === "QA Ravi");
  const bank = await f.bal("QA Bank");
  const layer = await openInstallmentPayment(page, name);
  await layer.getByTestId("other-payment-flows").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Past payment" }).click();
  await layer.getByRole("button", { name: "Continue with 1 EMI" }).click();
  const payDate = layer.getByRole("textbox", { name: "Date paid", exact: true });
  await payDate.locator("..").getByRole("button", { name: "Open calendar" }).click();
  await page.getByTestId("date-calendar").getByRole("button", { name: /^Due / }).click();
  await layer.getByRole("radiogroup", { name: "QA Priya", exact: true }).getByRole("radio", { name: "Received in full" }).click();
  chk("the past receipt explains that the person paid you and the money is already in the account", await layer.getByText(/Select Received for money the person paid you/).isVisible());
  await selectQaBank(page, layer.getByRole("combobox", { name: "Received into account" }));
  await layer.getByRole("button", { name: /^Save past payment of ₹3,000/ }).click();
  await layer.waitFor({ state: "hidden" });
  const ref = `emi-inst:${first.id}`;
  const receipts = (await h.list(`people/${priya.id}/ledger`)).filter((e) => !e.deletedAt && e.obligationRef === ref && e.type === "receivedBack");
  const raviReceipts = (await h.list(`people/${ravi.id}/ledger`)).filter((e) => !e.deletedAt && e.obligationRef === ref && e.type === "receivedBack");
  const paid = await f.scheduleState("emi", name);
  chk("exactly ₹1,000 is allocated to Priya's selected installment, already in account, with a known date", receipts.length === 1 && receipts[0].amount === 1000 && receipts[0].recordedEarlier === true && receipts[0].receivedDateKnown !== false, JSON.stringify(receipts.map(({ amount, obligationRef, recordedEarlier }) => ({ amount, obligationRef, recordedEarlier }))));
  chk("the other participant remains outstanding, and the bank is unchanged", raviReceipts.length === 0 && f.close2(await f.bal("QA Bank"), bank));
  chk("only the selected lender installment is paid", paid[0].amountPaid === 3000 && paid.slice(1).every((i) => i.amountPaid === 0));
  await page.getByTestId("installment-row-1").click();
  const detail = page.getByTestId("installment-detail");
  await detail.getByText("QA Priya", { exact: true }).waitFor();
  const personLines = detail.getByTestId("installment-person");
  const priyaLine = await personLines.filter({ hasText: "QA Priya" }).innerText();
  const raviLine = await personLines.filter({ hasText: "QA Ravi" }).innerText();
  chk("the live People share display reflects Priya settled and Ravi pending", /Settled/.test(priyaLine) && /Pending\s+₹1,000/.test(raviLine), [priyaLine, raviLine].join(" ").replace(/\s+/g, " "));
  await h.go(page, `/people?person=${encodeURIComponent(priya.id)}`);
  await page.getByRole("tab", { name: /^Linked EMIs/ }).click();
  const choice = page.getByTestId("linked-emi-choice").filter({ hasText: name });
  if (await choice.isVisible()) await choice.click();
  const agreement = page.getByTestId("linked-emi-card").filter({ hasText: name });
  await agreement.waitFor();
  const ledgerText = (await agreement.innerText()).replace(/\s+/g, " ");
  chk("People Ledger shows ₹1,000 paid toward the shares and ₹0 due now", /Paid toward share \+₹1,000/.test(ledgerText) && /Due now ₹0/.test(ledgerText) && ledgerText.includes("1/3 shares repaid to you"), ledgerText);
}, { viewport: { width: 1366, height: 768 }, scheme: "light" });

scenario("schedule-earlier-receipts", "Schedule reads earlier People receipts and held advance without changing either balance", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const name = "QA Shared EMI";
  const emi = (await h.list("emis")).find((item) => item.name === name);
  const [first, second, third] = await f.scheduleState("emi", name);
  const peopleFixtures = await h.list("people");
  const priya = peopleFixtures.find((person) => person.name === "QA Priya");
  const ravi = peopleFixtures.find((person) => person.name === "QA Ravi");
  const ledgerPath = `people/${priya.id}/ledger`;
  const applicationsPath = `people/${priya.id}/advanceApplications`;
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 20, 12);
  await Promise.all([first, second, third].map((inst, index) =>
    patchFixture(`paymentSchedules/${emi.scheduleId}/installments/${inst.id}`, {
      dueDate: { timestampValue: new Date(now.getFullYear(), now.getMonth() + index, 15, 12).toISOString() },
    }),
  ));
  const receipt = (id, amount, sourceKind, obligationRef, { date = previous, paymentId = id, personId = priya.id } = {}) =>
    h.createDocUnderUser(`people/${personId}/ledger/${id}`, {
      personId, type: "receivedBack", amount, sourceKind, obligationRef, paymentId,
      date, createdAt: date, receivedDateKnown: true, recordedEarlier: true, note: "",
      increasesBalance: true, transactionRef: null, parentEntryId: null, receivedStatus: "received",
      deletedAt: null, lastEditedAt: null, editHistory: [],
    });
  await receipt("linked", 400, "emiInstallment", `emi-inst:${second.id}`, { paymentId: "split-receipt" });
  await receipt("advance", 600, "advance", null, { paymentId: "split-receipt" });
  await receipt("general", 120, "manual", null, { date: now });
  await receipt("older-general-1", 20, "manual", null, { date: new Date(now.getFullYear(), now.getMonth() - 2, 20, 12) });
  await receipt("older-general-2", 30, "manual", null, { date: new Date(now.getFullYear(), now.getMonth() - 3, 20, 12) });
  await receipt("linked", 1000, "emiInstallment", `emi-inst:${second.id}`, { personId: ravi.id });
  await h.createDocUnderUser(`${applicationsPath}/advance-part`, {
    personId: priya.id, advanceEntryId: "advance", obligationKey: `emi-inst:${first.id}`,
    amount: 200, date: now, createdAt: now, deletedAt: null,
  });
  const paidFixture = await h.patchNumber(`paymentSchedules/${emi.scheduleId}/installments/${first.id}`, "amountPaid", first.amountDue);
  if (!paidFixture.ok) throw new Error("Failed to set up synthetic lender-paid installment");
  const snapshot = async () => JSON.stringify(await Promise.all([
    f.scheduleState("emi", name), h.list(ledgerPath), h.list(`people/${ravi.id}/ledger`),
    h.list(applicationsPath), h.list("people"), h.list("transactions"), f.bal("QA Bank"),
  ]));
  const before = await snapshot();

  await openFromList(page, name, "emi-page");
  await page.getByTestId("installment-row-2").click();
  const detail = page.getByTestId("installment-detail");
  const people = detail.getByTestId("installment-person");
  const row = people.filter({ hasText: "QA Priya" });
  const receiptsDisclosure = row.locator("details > summary").filter({ hasText: "Receipts" });
  await receiptsDisclosure.waitFor();
  const history = row.getByRole("list", { name: "Recent receipts from QA Priya" });
  const personText = (await row.innerText()).replace(/\s+/g, " ");
  const lender = detail.locator('[aria-label="Lender payment"]');
  const grid = page.getByTestId("installment-grid");
  const balance = grid.getByTestId("schedule-people-balance");
  await balance.waitFor();
  chk("the Schedule footer uses the current cycle's linked balance", await balance.getByText("₹1,800", { exact: true }).isVisible()
    && (await grid.getByRole("columnheader", { name: "People pending" }).count()) === 0);
  await h.shot(page, "schedule-people-balance");
  await grid.getByRole("radio", { name: /^Unpaid/ }).click();
  chk("the lender filter leaves the People balance unchanged", (await grid.getByTestId("installment-row-1").count()) === 0
    && await balance.getByText("₹1,800", { exact: true }).isVisible());
  await grid.getByRole("radio", { name: "All" }).click();
  await page.setViewportSize({ width: 1152, height: 850 });
  chk("the People balance fits a narrower desktop viewport", await balance.evaluate((element) => {
    const { left, right } = element.getBoundingClientRect();
    return left >= 0 && right <= document.documentElement.clientWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  chk("the selected share and lender balances are independent", /Pending ₹600/.test(personText) && /Paid\s+₹0\b/.test(await lender.innerText()), personText);
  chk("a person's share can be settled while the lender is unpaid", /Settled/.test(await people.filter({ hasText: "QA Ravi" }).innerText()));
  chk("the name links to the person's ledger and cycle", (await row.getByRole("link", { name: "QA Priya" }).getAttribute("href"))?.includes(`person=${priya.id}&cycle=`));
  chk("receipt history stays collapsed in the pending view", !(await history.isVisible()));
  await receiptsDisclosure.click();
  chk("only the unused part is shown as earlier advance", /₹400 available advance.*From earlier cycles/.test((await row.innerText()).replace(/\s+/g, " ")));
  const mixedReceipt = await history.getByRole("listitem").filter({ hasText: "₹1,000" }).innerText();
  chk("one dated receipt shows all three allocations", /20\s+\w+\s+\d{4}\s+₹1,000/.test(mixedReceipt) &&
    ["₹400 applied to #2", "₹200 advance applied to #1", "₹400 unallocated advance"].every((part) => mixedReceipt.includes(part)), mixedReceipt);
  chk("the general receipt stays separate and only the current cycle's receipt is counted here", /Received this cycle ₹120.*₹120 General receipt/.test((await row.innerText()).replace(/\s+/g, " ")));
  chk("three recent receipts are visible by default", await history.getByRole("listitem").count() === 3);
  await h.shot(page, "schedule-earlier-receipts-selected");
  await row.getByRole("button", { name: "View history for QA Priya" }).click();
  chk("View history expands the existing four records", await history.getByRole("listitem").count() === 4);
  await row.getByRole("button", { name: "Show fewer receipts for QA Priya" }).click();

  await page.getByTestId("installment-row-1").click();
  chk("a paid lender does not settle another person's share", /Paid\s+₹3,000/.test(await lender.innerText()) && /Pending\s+₹1,000/.test(await people.filter({ hasText: "QA Ravi" }).innerText()));
  chk("the first installment shows its balance after the applied advance", /Pending\s+₹800/.test(await row.innerText()));
  await receiptsDisclosure.click();
  chk("the receipt details identify the advance applied to this EMI", await row.getByText("₹200 applied from advance").isVisible());
  await page.getByTestId("installment-row-3").click();
  chk("neither the general receipt nor the held advance settles the third installment", /Pending\s+₹1,000/.test(await row.innerText()));
  chk("changing installments keeps the same People cycle balance", await balance.getByText("₹1,800", { exact: true }).isVisible());
  await page.getByRole("button", { name: "Next cycle", exact: true }).first().click();
  await balance.getByText("₹2,400", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Next cycle", exact: true }).first().click();
  chk("selecting future cycles adds their linked dues and carries unpaid amounts", await balance.getByText("₹4,400", { exact: true }).isVisible());
  chk("browsing and expanding receipt history leaves the financial records unchanged", before === await snapshot());
  await row.getByRole("link", { name: "QA Priya" }).click();
  await page.getByRole("tab", { name: "Overview", exact: true }).waitFor();
  const ledgerUrl = new URL(page.url());
  chk("the link opens the selected person's People Ledger in the EMI cycle", ledgerUrl.pathname.startsWith("/people")
    && ledgerUrl.searchParams.get("person") === priya.id && ledgerUrl.searchParams.has("cycle"));
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("schedule-card-bill-breakdown", "Pay bill shows purchases and financed EMI then records one payment", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi-a");
  const account = (await h.list("accounts")).find((item) => item.name === "QA Case A Card");
  const card = (await h.list("creditCards")).find((item) => item.accountId === account.id);
  const purchases = await f.txns((t) => t.accountId === account.id);
  const now = new Date();
  const billedAt = new Date(now.getFullYear(), now.getMonth() - 2, 20, 12);
  await Promise.all(purchases.map((t) => patchFixture(`transactions/${t.id}`, {
    dateTime: { timestampValue: billedAt.toISOString() },
  })));
  await h.createDocUnderUser("transactions/qa-cycle-card-retail", {
    type: "expense", amount: 2000, accountId: account.id, categoryId: purchases[0].categoryId, description: "QA retail",
    dateTime: billedAt, createdAt: billedAt, notes: "", status: "posted", deletedAt: null, excludeFromCalculations: false,
    transferId: null, editHistory: [],
  });
  await patchFixture(`accounts/${account.id}`, { currentBalance: { doubleValue: -20000 } });
  const before = await f.bal("QA Bank");
  await h.go(page, `/credit-cards?card=${encodeURIComponent(card.id)}`);
  await page.getByRole("region", { name: "Selected card" }).filter({ hasText: "QA Case A Card" }).getByRole("button", { name: "Pay bill", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  const parts = dialog.getByTestId("card-bill-parts");
  await parts.waitFor();
  chk("the one bill shows ₹2,000 purchases and ₹18,000 Loan / EMI", /Purchases\s+₹2,000/.test(await parts.innerText())
    && /Loan \/ EMI\s+₹18,000/.test(await parts.innerText()));
  await h.shot(page, "schedule-card-bill-breakdown");
  await dialog.getByText("Select account").first().click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dialog.getByRole("button", { name: /^Pay ₹20,000/ }).click();
  await dialog.getByTestId("pay-bill-scope").getByText(/^No bill is due on this card/).waitFor();
  chk("the bill payment clears the card and debits the bank once", f.close2(await f.bal("QA Case A Card"), 0)
    && f.close2(before - await f.bal("QA Bank"), 20_000));
  const incoming = await f.txns((t) => t.accountId === account.id && t.type === "income" && t.transferId != null);
  chk("there is one incoming card transfer for the entire statement", incoming.length === 1 && incoming[0].amount === 20_000);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

scenario("receipt-workflow-quick", "A custom bank-funded EMI payment waits for a valid date and debits only once", async ({ page }, chk) => {
  const name = "QA Phone EMI";
  const before = await f.scheduleState("emi", name);
  const bank = await f.bal("QA Bank");
  const bankAccount = (await h.list("accounts")).find((a) => a.name === "QA Bank");
  const emi = (await h.list("emis")).find((e) => e.name === name);
  const oldTransactions = await f.txns((t) => t.emiId === emi.id);
  const layer = await openInstallmentPayment(page, name);
  await layer.getByTestId("change-amount").click();
  await layer.getByTestId("amount-card").getByRole("spinbutton").fill("250");
  await selectQaBank(page, layer.getByRole("combobox", { name: "Paid from account" }));
  const date = layer.getByRole("textbox", { name: "Payment date" });
  const originalDate = await date.inputValue();
  await date.fill("31022026");
  const pay = layer.getByRole("button", { name: "Pay ₹250", exact: true });
  chk("an invalid typed date blocks Pay instead of silently substituting today", await pay.isDisabled());
  await date.press("Enter");
  chk("Enter with an invalid date creates no payment", f.close2(await f.bal("QA Bank"), bank) && (await f.scheduleState("emi", name))[0].amountPaid === before[0].amountPaid && await layer.isVisible());
  await date.fill(originalDate);
  await pay.evaluate((button) => { button.click(); button.click(); });
  await layer.waitFor({ state: "hidden" });
  const after = await f.scheduleState("emi", name);
  const transactions = (await f.txns((t) => t.emiId === emi.id)).filter((t) => !oldTransactions.some((old) => old.id === t.id));
  chk("the intended installment receives exactly ₹250", after[0].amountPaid === before[0].amountPaid + 250 && after.slice(1).every((i, index) => i.amountPaid === before[index + 1].amountPaid));
  chk("the selected bank is debited ₹250 with one linked transaction", f.close2(await f.bal("QA Bank"), bank - 250) && transactions.length === 1 && transactions[0].accountId === bankAccount.id && transactions[0].amount === 250 && transactions[0].installmentId === after[0].id);
  await page.getByRole("tab", { name: /^Payment history/ }).click();
  const history = page.getByRole("tabpanel", { name: "Payment history" });
  await history.getByText(/₹250/).first().waitFor();
  chk("the live payment history shows ₹250 after saving", (await history.innerText()).includes("₹250"));
}, { viewport: { width: 1366, height: 768 }, scheme: "light" });

scenario("receipt-workflow-card", "Existing card purchases use the card-bill route or an explicit principal transfer", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi-a");
  const bank = await f.bal("QA Bank");
  const cardBalance = await f.bal("QA Case A Card");
  let layer = await openInstallmentPayment(page, "QA Case A Free EMI");
  const billLink = layer.getByRole("link", { name: "Pay card bill" });
  const href = await billLink.getAttribute("href");
  chk("the charged purchase offers the existing Pay bill deep link and defaults to recording the EMI", /^\/credit-cards\/?\?card=.+&pay=1$/.test(href ?? "") && await layer.getByRole("button", { name: "Record ₹1,500 card EMI" }).isVisible(), href);
  await billLink.click();
  await page.waitForURL(/\/credit-cards(?:\/|\?|$)/);
  const billDialog = page.getByRole("dialog").filter({ has: page.getByTestId("pay-bill-scope") });
  await billDialog.waitFor();
  chk("Pay card bill opens the existing Credit Cards payment form", await billDialog.isVisible());

  layer = await openInstallmentPayment(page, "QA Case A Free EMI");
  await layer.getByRole("button", { name: "Record ₹1,500 card EMI" }).click();
  await layer.waitFor({ state: "hidden" });
  const installments = await f.scheduleState("emi", "QA Case A Free EMI");
  chk("recording the interest-free EMI adds no duplicate charge or bank debit", installments[0].amountPaid === 1500 && f.close2(await f.bal("QA Bank"), bank) && f.close2(await f.bal("QA Case A Card"), cardBalance));

  layer = await openInstallmentPayment(page, "QA Case A EMI");
  await layer.locator("summary").filter({ hasText: "EMI payment options" }).click();
  await layer.getByRole("radio", { name: "Pay from a bank account" }).click();
  await selectQaBank(page, layer.getByRole("combobox", { name: "Paid from account" }));
  await layer.getByRole("button", { name: /^Pay ₹3,075\.37 card EMI from bank/ }).click();
  await layer.waitFor({ state: "hidden" });
  chk("the explicit bank option debits ₹3,075.37 once and pays down ₹2,955.37 of card principal", f.close2(await f.bal("QA Bank"), bank - 3075.37) && f.close2(await f.bal("QA Case A Card"), cardBalance + 2955.37));
}, { viewport: { width: 1366, height: 768 }, scheme: "light" });

scenario("receipt-workflow-history", "Received History reads live allocations and reflows at narrow desktop widths", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const layer = await openInstallmentPayment(page, "QA Shared EMI");
  const people = layer.getByTestId("people-card");
  const history = layer.getByRole("complementary", { name: "Received History" });
  const selectPerson = history.getByRole("combobox", { name: "Person for received history" });
  await selectPerson.selectOption({ label: "QA Priya" });
  const peopleBox = await people.boundingBox();
  const historyBox = await history.boundingBox();
  chk("the history is beside the payment form at 1920px", !!peopleBox && !!historyBox && historyBox.x >= peopleBox.x + peopleBox.width);
  const row = people.getByRole("row", { name: /^QA Priya/ });
  await row.getByRole("button", { name: /^Yes, receive/ }).click();
  await row.getByRole("spinbutton", { name: "Amount received from QA Priya" }).fill("400");
  await row.getByRole("button", { name: "Receipt details for QA Priya" }).click();
  const receipt = page.getByRole("dialog", { name: "Receipt details for QA Priya" });
  await receipt.getByRole("radio", { name: "Add to my account" }).click();
  await selectQaBank(page, receipt.getByRole("combobox", { name: "Received into account" }));
  await receipt.getByRole("button", { name: "Record Received" }).click();
  await row.getByText("Receipt saved", { exact: true }).waitFor();
  const applied = history.getByText("Applied to #1", { exact: true }).locator("..");
  await applied.getByText("₹400", { exact: true }).waitFor();
  chk("the saved receipt updates the selected installment, this cycle and Recent receipts", await history.getByText("Received this cycle", { exact: true }).locator("..").getByText("₹400", { exact: true }).isVisible()
    && await history.getByText("Remaining share", { exact: true }).locator("..").getByText("₹600", { exact: true }).isVisible()
    && /#1\s+₹400/.test(await history.getByRole("list", { name: "Recent People receipts" }).innerText()));
  await h.shot(page, "receipt-workflow-history-wide");
  await page.setViewportSize({ width: 1280, height: 768 });
  const toggle = history.getByRole("button", { name: /^Received History/ });
  await toggle.click();
  chk("history expands beneath the form with no horizontal overflow at 1280px", await selectPerson.isVisible() && await layer.getByTestId("layer-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
}, { viewport: { width: 1920, height: 768 }, scheme: "light" });

for (const width of [1024, 1280, 1366, 1440, 1920]) {
  scenario(`compact-payment-${width}`, `Shared EMI payment workspace at ${width}×768`, async ({ page }, chk) => {
    await h.addFixture(page, "shared-emi");
    await openFromList(page, "QA Shared EMI", "emi-page");
    await page.getByTestId("installment-detail").getByRole("button", { name: /^Pay Now/ }).click();

    const layer = inline(page);
    const body = layer.getByTestId("layer-body");
    const table = body.getByRole("table", { name: "Who shares this installment" });
    const person = table.getByRole("row", { name: /^QA Priya/ });
    await person.waitFor();
    const path = new URL(page.url()).pathname;
    const before = await f.commits(page);
    const fits = await body.evaluate((el) => ({
      vertical: el.scrollHeight - el.clientHeight,
      horizontal: Math.max(el.scrollWidth - el.clientWidth, document.documentElement.scrollWidth - innerWidth),
    }));
    chk("the normal payment fits without scrolling", fits.vertical <= 2 && fits.horizontal <= 1, JSON.stringify(fits));
    chk("the People table has visible desktop headers", (await table.locator("thead").boundingBox())?.height > 12);
    const calendar = page.getByTestId("date-calendar");
    await body.getByRole("button", { name: "Open calendar" }).click();
    await calendar.getByRole("button", { name: "Today", exact: true }).click();
    await calendar.waitFor({ state: "hidden" });
    chk("choosing a payment date leaves the form open", await table.isVisible());
    const rowCount = await table.getByRole("row").count();
    await person.getByRole("button", { name: /^No, no new receipt/ }).click();
    await person.getByRole("button", { name: "Keep pending" }).click();
    chk("No stays pending without a write", await person.getByText("Kept pending").isVisible() && (await f.commits(page)) === before);
    await person.getByRole("button", { name: /^Yes, receive/ }).click();
    const amount = person.getByRole("spinbutton", { name: "Amount received from QA Priya" });
    chk("Yes focuses the row's amount", await amount.evaluate((el) => document.activeElement === el));
    await amount.fill("400");
    chk("the projected balance is ₹600 and the table gains no row", await person.getByText("After receipt ₹600").isVisible() && (await table.getByRole("row").count()) === rowCount);
    await amount.press("Enter");
    chk("Enter in the amount leaves the installment unpaid", (await f.commits(page)) === before);
    const trigger = person.getByRole("button", { name: "Receipt details for QA Priya" });
    const amountBox = await amount.boundingBox();
    const triggerBox = await trigger.boundingBox();
    chk("the amount and Details share one line", !!amountBox && !!triggerBox && amountBox.x + amountBox.width <= triggerBox.x && Math.abs(amountBox.y + amountBox.height / 2 - triggerBox.y - triggerBox.height / 2) <= 2);
    await trigger.press("Enter");
    let receipt = page.getByRole("dialog", { name: "Receipt details for QA Priya" });
    await receipt.waitFor();
    const receiptBox = await receipt.boundingBox();
    const footer = await layer.getByRole("button", { name: /^Pay ₹/ }).boundingBox();
    chk("the popover fits the viewport and clears the footer", !!receiptBox && !!footer && receiptBox.x >= 0 && receiptBox.x + receiptBox.width <= width && receiptBox.y >= 0 && receiptBox.y + receiptBox.height <= footer.y, JSON.stringify({ receiptBox, footer }));
    await receipt.getByRole("button", { name: "Open calendar" }).click();
    await calendar.getByRole("button", { name: "Today", exact: true }).click();
    await calendar.waitFor({ state: "hidden" });
    chk("calendar selection returns to the receipt", await receipt.isVisible());
    await page.keyboard.press("Escape");
    await receipt.waitFor({ state: "hidden" });
    chk("Escape restores focus and retains the amount draft", await trigger.evaluate((el) => document.activeElement === el) && (await amount.inputValue()) === "400");

    let balanceAfterReceipt;
    if (width === 1366) {
      await trigger.click();
      receipt = page.getByRole("dialog", { name: "Receipt details for QA Priya" });
      await receipt.getByRole("radio", { name: "Add to my account" }).click();
      await receipt.getByRole("combobox", { name: "Received into account" }).click();
      await page.getByRole("option", { name: /QA Bank/ }).click();
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await h.shot(page, `compact-payment-${width}-receipt`);
      const bank = await f.bal("QA Bank");
      await receipt.getByRole("button", { name: "Record Received" }).click();
      await receipt.waitFor({ state: "hidden" });
      await person.getByText("Receipt saved", { exact: true }).waitFor();
      balanceAfterReceipt = await f.bal("QA Bank");
      chk("the bank receives exactly ₹400", f.close2(balanceAfterReceipt, bank + 400));
    } else {
      await trigger.click();
      await page.getByRole("button", { name: "Discard draft" }).click();
    }

    const more = layer.getByTestId("other-payment-flows").getByRole("button", { name: "More" });
    for (const [menuItem, mode] of [["Past payment", /Record past payments/], ["Pay several", /Pay several EMIs/]]) {
      await more.press("Enter");
      await page.getByRole("menuitem", { name: menuItem }).press("Enter");
      await layer.getByRole("heading", { name: mode }).waitFor();
      chk(`${menuItem} stays in the workspace`, new URL(page.url()).pathname === path);
      const back = layer.getByRole("button", { name: "Back to payment" });
      chk(`${menuItem} focuses Back to payment`, await back.evaluate((el) => document.activeElement === el));
      if (width === 1366 && menuItem === "Past payment") {
        await layer.getByRole("button", { name: "Continue with 1 EMI" }).click();
        await layer.getByRole("heading", { name: "Record past payment", exact: true }).waitFor();
        chk("the single past payment shows its account-neutral effect", await layer.getByTestId("past-payment-effect").isVisible());
      }
      if (width === 1366 && menuItem === "Pay several") {
        await layer.getByRole("checkbox", { name: "#1", exact: true }).check();
        await layer.getByRole("button", { name: /^Review 1 EMI/ }).click();
        chk("Pay several review shows the payer, account and payment date", await layer.getByRole("radiogroup", { name: "Who paid #1" }).isVisible()
          && await layer.getByRole("combobox", { name: "Paid from account" }).isVisible()
          && await layer.getByRole("textbox", { name: "Payment date" }).isVisible());
      }
      await back.click();
      await table.waitFor();
      chk("returning to normal payment focuses More", await more.evaluate((el) => document.activeElement === el));
    }
    await layer.evaluate((el) => Promise.allSettled(el.getAnimations().map((animation) => animation.finished)));
    await h.shot(page, `compact-payment-${width}`);
    await layer.getByRole("button", { name: "Cancel", exact: true }).click();
    await layer.waitFor({ state: "hidden" });
    chk("the lender schedule remains unpaid", f.paidTotal(await f.scheduleState("emi", "QA Shared EMI")) === 0);
    if (balanceAfterReceipt != null) chk("cancelling the EMI payment keeps the independent receipt", f.close2(await f.bal("QA Bank"), balanceAfterReceipt));
  }, { viewport: { width, height: 768 }, scheme: "light" });
}

async function openFromList(page, name, testId) {
  await h.go(page, "/loans");
  // The card itself (the summary strip names the next payment too, so a plain text match can hit that instead).
  await page.locator('[role="button"]', { hasText: name }).first().click();
  await page.waitForFunction(onDetailPath, null, { timeout: 30000 });
  await page.locator(`[data-testid="${testId}"]`).waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
}

scenario("agreement-owner-navigation", "Loan & EMI shows the owner in the list, detail and side navigation", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await h.go(page, "/loans");
  const card = page.locator('[role="button"]').filter({ has: page.getByRole("heading", { name: "QA Shared EMI", exact: true }) });
  const cardOwner = card.getByText("QA Priya", { exact: true });
  await cardOwner.waitFor();
  chk("the EMI lists both linked owners before opening it", await card.getByText("QA Ravi", { exact: true }).isVisible());
  await cardOwner.click();

  const emi = page.getByTestId("emi-page");
  const owner = "Shared with QA Priya and QA Ravi";
  await emi.getByTestId("agreement-owner").getByText(owner, { exact: true }).waitFor();
  const nav = page.getByTestId("agreement-nav");
  const shared = nav.getByRole("link", { name: /QA Shared EMI/ });
  chk("the header and selected side row show the same names", await shared.getByText(owner, { exact: true }).isVisible()
    && await shared.getAttribute("aria-current") === "page");
  await h.shot(page, "agreement-owner-navigation");

  await nav.getByRole("link", { name: /QA Loan 12/ }).getByText("QA Loan 12", { exact: true }).click();
  await page.getByTestId("loan-page").getByRole("heading", { name: "QA Loan 12", exact: true }).waitFor();
  const search = nav.getByRole("textbox", { name: "Search loans and EMIs" });
  await search.fill("QA Ravi");
  chk("the side search finds the EMI by the person's name", await shared.isVisible()
    && (await nav.getByRole("link", { name: /QA Phone EMI/ }).count()) === 0);
  await shared.getByText(owner, { exact: true }).click();
  await emi.getByRole("heading", { name: "QA Shared EMI", exact: true }).waitFor();
  chk("clicking the name in the side row opens the correct record in place", await shared.getAttribute("aria-current") === "page"
    && await emi.getByTestId("agreement-owner").getByText(owner, { exact: true }).isVisible());

  await search.fill("QA Loan 12");
  const arrow = await shared.evaluate((link) => link.closest("li")?.nextElementSibling ? "ArrowDown" : "ArrowUp");
  await shared.press(arrow);
  await page.getByTestId("loan-page").getByRole("heading", { name: "QA Loan 12", exact: true }).waitFor();
  chk("the arrow keys also open the next side row", await nav.getByRole("link", { name: /QA Loan 12/ }).getAttribute("aria-current") === "page");
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

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
    chk("clicking a row selects it and fills the strip beneath", (await page.getByTestId("installment-detail").getAttribute("aria-label")) === "EMI 2");
    chk("a linked person's pending amount appears for the selected cycle", /cycle.*Pending\s+₹1,000/s.test(await page.getByTestId("installment-person").first().innerText()));
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
    chk("a personal agreement displays only the lender side", (await page.getByTestId("installment-person").count()) === 0 && (await page.getByTestId("schedule-people-balance").count()) === 0);
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
  const loan = (await h.list("loans")).find((row) => row.name === "QA Loan 12");
  const person = (await h.list("people")).find((row) => row.name === "QA Priya");
  const schedule = `paymentSchedules/${loan.scheduleId}/installments`;
  const installments = (await h.list(schedule)).filter((i) => !i.isSkipped && i.amountDue > (i.amountPaid ?? 0)).sort((a, b) => a.sequenceNumber - b.sequenceNumber).slice(0, 2);
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
  chk("a direct payment offers no way to add the money to an account", (await shares.getByRole("radio", { name: /Add to my account/ }).count()) === 0);
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
  await payment.getByRole("radiogroup", { name: `Who paid #${installments[1].sequenceNumber}`, exact: true }).getByRole("radio", { name: "Person paid lender" }).click();
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
