/**
 * Transaction Inbox — automatic description filling, end to end in the browser against the Firestore EMULATOR only
 * (see tests/e2e-qa/README.md). Synthetic candidates carry a real-looking SMS body; the candidate sheet is driven like
 * a user would, and the saved transactions are read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { sameDayIso, selectAllDays } from "../lib/inbox-days.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const s = (v) => ({ stringValue: v });
const nul = { nullValue: null };

async function put(uid, { id, amount, merchant, message, accountId, minutesAgo, direction = "debit", reference = null }) {
  const fields = {
    amount: { doubleValue: amount },
    direction: s(direction),
    eventType: s("upiPayment"),
    transactionDate: { timestampValue: sameDayIso(minutesAgo) },
    merchant: merchant ? s(merchant) : nul,
    bankName: s("QA Bank"),
    rawLastFour: nul,
    accountId: s(accountId),
    cardId: nul,
    referenceNumber: reference ? s(reference) : nul,
    confidenceLevel: s("high"),
    confidenceScore: { doubleValue: 0.9 },
    needsReview: { booleanValue: false },
    needsReviewReasons: { arrayValue: { values: [] } },
    source: s("sms"),
    createdAt: { timestampValue: new Date().toISOString() },
    deletedAt: nul,
    originalMessage: s(message),
  };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${id}: ${r.status} ${await r.text()}`);
}

async function open(page) {
  const uid = await h.authUid();
  const sw = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsSyncConfig/backgroundUpload`, {
    method: "PATCH",
    headers: OWNER,
    body: JSON.stringify({ fields: { enabled: { booleanValue: true }, deviceId: s("qa-sms-device"), source: s("pairing") } }),
  });
  if (!sw.ok) throw new Error(`seed Auto Sync switch: ${sw.status}`);
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
}

const rowOf = (page, text) => page.getByTestId("candidate-row").filter({ hasText: text }).first();
const openRow = (page, text) => rowOf(page, text).getByRole("button", { name: /^Review/ }).click();

async function importFirst(page, text, { act } = {}) {
  await openRow(page, text);
  const dialog = page.getByRole("dialog").first();
  await dialog.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  const box = dialog.getByTestId("candidate-description");
  const categoryBox = dialog.getByRole("combobox").nth(0);
  const seen = { initial: await box.inputValue(), category: (await categoryBox.innerText()).replace(/\s+/g, " ").trim() }; // already filled — nothing was clicked
  if (act) await act({ dialog, box, page, categoryBox });
  // Only pick a category when none was auto-selected (the form needs one to import).
  if (/Select a category/i.test(await categoryBox.innerText())) {
    await categoryBox.click();
    await page.getByRole("option").first().click();
  }
  seen.final = await box.inputValue(); // after an unrelated field (category) changed
  await dialog.getByRole("button", { name: "Import as Transaction" }).click();
  await rowOf(page, text).waitFor({ state: "detached", timeout: 30000 });
  return seen;
}

scenario("sms-desc-1-flow", "Candidate sheet auto-fills the description, an edit is kept, approval saves what the field shows, the same SMS again adds nothing", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await h.accountBalance("QA Bank");
  const swiggyMsg = "Rs.299 debited via UPI to SWIGGY BUNDL TECHNOLOGIES Ref 827392";
  await put(uid, { id: "sd-swiggy", amount: 299, merchant: "BUNDL TECHNOLOGIES", message: swiggyMsg, accountId: bank.id, minutesAgo: 10, reference: "827392" });
  await put(uid, { id: "sd-rail", amount: 1450, merchant: "Indian Railways", message: "Rs.1450 debited via UPI to INDIAN RAILWAYS Ref 5566", accountId: bank.id, minutesAgo: 15 });
  await put(uid, { id: "sd-jio", amount: 239, merchant: "Jio", message: "Rs.239 paid to JIO PREPAID RECHARGE via UPI", accountId: bank.id, minutesAgo: 20 });
  await put(uid, { id: "sd-person", amount: 500, merchant: "Mohan Kumar", message: "UPI: Sent Rs.500.00 From QA Bank A/C *4821 To MOHAN KUMAR On 12/11/26 Ref 551122 Not You?", accountId: bank.id, minutesAgo: 30 });
  await put(uid, { id: "sd-bank", amount: 27, merchant: null, message: "Rs.27.00 debited A/cXX9585 and credited to AXIS BANK LIMITED via UPI Ref No 660124318654 on 22Sep26.", accountId: bank.id, minutesAgo: 40 });
  await open(page);
  await rowOf(page, "Indian Railways").waitFor({ timeout: 40000 });
  const before = await h.list("transactions");

  let seen = await importFirst(page, "BUNDL");
  check("Swiggy: field is already 'Swiggy — Food Order · UPI'", seen.initial === "Swiggy — Food Order · UPI", JSON.stringify(seen));
  check("Swiggy: the category is already selected too (Food)", /Food/.test(seen.category), seen.category);
  check("Swiggy: an unrelated change kept the description", seen.final === seen.initial, seen.final);
  seen = await importFirst(page, "Indian Railways");
  check("Indian Railways: 'Indian Railways · UPI'", seen.initial === "Indian Railways · UPI", JSON.stringify(seen));
  check("Indian Railways: category already Transport", /Transport/.test(seen.category), seen.category);
  seen = await importFirst(page, "Jio", {
    act: async ({ box, categoryBox, page: pg }) => {
      await box.fill("Dad's mobile recharge");
      await categoryBox.click(); // the reviewer's own category choice must survive the description edit
      await pg.getByRole("option", { name: /Shopping/ }).first().click();
      await box.fill("Dad's mobile recharge!");
      await box.fill("Dad's mobile recharge");
    },
  });
  check("Jio: auto-filled 'Jio Mobile Recharge · UPI' with Bills & Utilities first", seen.initial === "Jio Mobile Recharge · UPI" && /Bills/.test(seen.category), JSON.stringify(seen));
  check("Jio: the user's edit is not overwritten when another field changes", seen.final === "Dad's mobile recharge", seen.final);
  seen = await importFirst(page, "Mohan Kumar");
  check("personal UPI: 'Mohan Kumar · UPI' (payee only, no invented purpose)", seen.initial === "Mohan Kumar · UPI", JSON.stringify(seen));
  check("personal UPI: no category invented", /Select a category/i.test(seen.category), seen.category);
  seen = await importFirst(page, "QA Bank");
  check("no payee in the SMS: the existing detected name stays (no forced guess)", seen.initial === "QA Bank", JSON.stringify(seen));
  check("no payee in the SMS: no category invented", /Select a category/i.test(seen.category), seen.category);

  const made = (await h.list("transactions")).filter((t) => !before.some((b) => b.id === t.id));
  const by = (amount) => made.find((t) => Math.abs(t.amount - amount) < 0.001);
  check("exactly five new transactions", made.length === 5, made.length);
  const expected = [
    [299, "Swiggy — Food Order · UPI"],
    [1450, "Indian Railways · UPI"],
    [239, "Dad's mobile recharge"],
    [500, "Mohan Kumar · UPI"],
    [27, "QA Bank"],
  ];
  const cats = await h.list("categories");
  const nameOf = (id) => cats.find((c) => c.id === id)?.name ?? "";
  check("saved ₹299 category is Food (auto-selected)", nameOf(by(299)?.categoryId) === "Food", nameOf(by(299)?.categoryId));
  check("saved ₹1450 category is Transport (auto-selected)", nameOf(by(1450)?.categoryId) === "Transport", nameOf(by(1450)?.categoryId));
  check("saved ₹239 keeps the reviewer's manual Shopping (not the auto Bills & Utilities)", nameOf(by(239)?.categoryId) === "Shopping", nameOf(by(239)?.categoryId));
  for (const [amount, description] of expected) {
    const t = by(amount);
    check(`₹${amount}: saved description is "${description}"`, t?.description === description, t?.description);
    check(`₹${amount}: expense, QA Bank, source sms`, t?.type === "expense" && t?.accountId === bank.id && t?.source === "sms", JSON.stringify({ type: t?.type, acc: t?.accountId, src: t?.source }));
  }

  // The same captured SMS arrives again and the reviewer renames it: the duplicate guard must still hold.
  const count = (await h.list("transactions")).length;
  const bal = (await h.accountBalance("QA Bank")).currentBalance;
  await put(uid, { id: "sd-swiggy", amount: 299, merchant: "BUNDL TECHNOLOGIES", message: swiggyMsg, accountId: bank.id, minutesAgo: 10, reference: "827392" });
  await rowOf(page, "BUNDL").waitFor({ timeout: 30000 });
  await openRow(page, "BUNDL");
  const dialog = page.getByRole("dialog").first();
  await dialog.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await dialog.getByTestId("candidate-description").fill("Renamed on purpose");
  if (/Select a category/i.test(await dialog.getByRole("combobox").nth(0).innerText())) {
    await dialog.getByRole("combobox").nth(0).click();
    await page.getByRole("option").first().click();
  }
  await dialog.getByRole("button", { name: /Import as Transaction|Import anyway/ }).first().click();
  const warned = await page.getByRole("button", { name: "Import anyway" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("same SMS again with a different description: the duplicate warning still appears", warned);
  if (warned) {
    await page.getByRole("button", { name: "Import anyway" }).click();
    await page.getByText("Already imported").first().waitFor({ timeout: 20000 });
  }
  check("no second financial transaction", (await h.list("transactions")).length === count, (await h.list("transactions")).length);
  check("balance unchanged by the repeat", Math.abs((await h.accountBalance("QA Bank")).currentBalance - bal) < 0.01);
});

scenario("sms-desc-2-bulk", "Bulk approval saves the same auto-filled descriptions", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await h.accountBalance("QA Bank");
  await put(uid, { id: "sb-zomato", amount: 180, merchant: "Zomato", message: "Rs.180 debited via UPI to ZOMATO Ref 1", accountId: bank.id, minutesAgo: 10 });
  await put(uid, { id: "sb-biryani", amount: 640, merchant: "Kerala Biryani House", message: "Rs.640 debited via UPI to KERALA BIRYANI HOUSE Ref 2", accountId: bank.id, minutesAgo: 20 });
  await open(page);
  await rowOf(page, "Zomato").waitFor({ timeout: 40000 });
  const before = await h.list("transactions");
  await selectAllDays(page);
  await page.getByRole("button", { name: /Import selected \(2\)/ }).click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByText(/Import 2 transactions/).waitFor({ timeout: 20000 });
  await dialog.getByRole("combobox").nth(0).click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("button", { name: /^Import 2/ }).click();
  await page.getByText("No SMS candidates").waitFor({ timeout: 30000 });
  const made = (await h.list("transactions")).filter((t) => !before.some((b) => b.id === t.id));
  const by = (amount) => made.find((t) => Math.abs(t.amount - amount) < 0.001);
  check("two transactions", made.length === 2, made.length);
  check("Zomato saved as 'Zomato — Food Order · UPI'", by(180)?.description === "Zomato — Food Order · UPI", by(180)?.description);
  check("Biryani house saved as 'Kerala Biryani House · UPI'", by(640)?.description === "Kerala Biryani House · UPI", by(640)?.description);
  check("amounts, direction and account unchanged", made.every((t) => t.type === "expense" && t.accountId === bank.id));
});
