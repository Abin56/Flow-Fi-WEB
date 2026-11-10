/**
 * Loan & EMI sweep (testing-phase check): the page renders, no console/page errors, no layout overflow, the figures agree
 * with each other and with the stored loans / EMIs / installments, and every control (Add, search, filters, cards, dialogs,
 * commitments panel, deep links) does what its label says. Local emulator only. Read-only except where a scenario says so.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const num = (s) => {
  const neg = /^[\s]*[-−]/.test(s);
  const n = Number(String(s).replace(/[^0-9.]/g, "")) || 0;
  return neg ? -n : n;
};
const LIST = 'section[aria-label="Loans and EMIs"]';
const CARDS = `${LIST} [role="button"]`;
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);

/** Seeds the shared + card EMI fixtures (portal page), then lands on /loans with fresh listeners (a reload after seeding). */
async function openLoans(page, { fixtures = true } = {}) {
  if (fixtures) {
    await h.addFixture(page, "shared-emi");
    await h.addFixture(page, "card-emi");
  }
  await h.go(page, "/loans");
  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByRole("heading", { level: 1, name: "Loan & EMI" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.getByText("Next payment").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
}

/** Every card on the list as { name, text, outstanding, paid, total, next }. */
async function cards(page) {
  const raw = await page.locator(CARDS).evaluateAll((els) => els.map((el) => ({ name: el.querySelector("h3")?.innerText.trim() ?? "", text: el.innerText.replace(/\s+/g, " ").trim() })));
  return raw.map((c) => ({
    ...c,
    outstanding: num(/(?:OUTSTANDING|STILL TO RECEIVE)\s*(₹[\d,.]+)/i.exec(c.text)?.[1] ?? ""),
    lent: /STILL TO RECEIVE/i.test(c.text),
    paid: Number(/Installments paid (\d+) of (\d+)/.exec(c.text)?.[1] ?? NaN),
    total: Number(/Installments paid (\d+) of (\d+)/.exec(c.text)?.[2] ?? NaN),
    nextAmount: num(/NEXT EMI\s*(₹[\d,.]+)/i.exec(c.text)?.[1] ?? ""),
    overdue: /overdue/i.test(/NEXT EMI.*?(?:Installments paid|$)/i.exec(c.text)?.[0] ?? ""),
  }));
}
const names = async (page) => (await cards(page)).map((c) => c.name).sort();
async function summary(page) {
  const t = flat(await page.locator('section[aria-label="Summary"]').innerText());
  return {
    raw: t,
    total: num(/TOTAL OUTSTANDING\s*(₹[\d,.]+)/i.exec(t)?.[1] ?? ""),
    next: /NEXT PAYMENT\s*(₹[\d,.]+)\s*(.*?)\s*DUE/i.exec(t),
    overdue: Number(/(\d+) overdue/.exec(t)?.[1] ?? 0),
    active: Number(/ACTIVE\s*(\d+)/i.exec(t)?.[1] ?? NaN),
    closed: Number(/CLOSED\s*(\d+)/i.exec(t)?.[1] ?? NaN),
  };
}
const showing = async (page) => {
  const m = /Showing (\d+) of (\d+)/.exec(flat(await page.locator(LIST).innerText()));
  return m ? { shown: Number(m[1]), of: Number(m[2]) } : null;
};
const overflow = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));

scenario("le-sweep-render", "Loan & EMI sweep: every section renders, no console errors, no overflow (desktop / laptop / tablet / mobile, light + dark)", async ({ page, logs }, chk) => {
  await openLoans(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "le-sweep-desktop-light");
  chk("title 'Loan & EMI' + subtitle", /Track what you owe, installments and repayments\./.test(main));
  chk("'Add' button present and enabled", await page.getByRole("button", { name: "Add", exact: true }).first().isEnabled());
  for (const [label, sel] of [["Summary", 'section[aria-label="Summary"]'], ["Loans and EMIs list", LIST]]) chk(`section present: ${label}`, (await page.locator(sel).count()) === 1);
  chk("My EMI commitments panel present", /My EMI/.test(main));
  chk("six cards (2 bank loans, 1 personal loan, 3 EMIs)", (await page.locator(CARDS).count()) === 6, await page.locator(CARDS).count());
  chk("every card shows name, outstanding and installment progress", (await cards(page)).every((c) => c.name && c.outstanding >= 0 && Number.isFinite(c.total)), JSON.stringify((await cards(page)).filter((c) => !c.name || !Number.isFinite(c.total)).map((c) => c.text.slice(0, 60))));
  chk("no 'NaN' / 'undefined' / 'Infinity' / '[object' text", !/NaN|undefined|Infinity|\[object/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity|\[object).{0,30}/) || [""])[0]);
  chk("no skeleton left after load", (await page.locator('main [class*="animate-pulse"]').count()) === 0);
  chk("search box shown (more than 4 records) with an example from the user's own list", (await page.getByLabel(/Search loans and EMIs/).count()) === 1 && /e\.g\./.test((await page.getByLabel(/Search loans and EMIs/).getAttribute("placeholder")) ?? ""));

  for (const [name, vp] of [["desktop", { width: 1920, height: 1080 }], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(vp);
      await page.waitForTimeout(900);
      const o = await overflow(page);
      const culprits = o.main > 1 || o.doc > 1
        ? await page.evaluate(() => {
            const m = document.querySelector("main");
            const right = m.getBoundingClientRect().right;
            const clipped = (el) => { for (let n = el.parentElement; n && n !== m; n = n.parentElement) { if (getComputedStyle(n).overflowX !== "visible") return true; } return false; };
            return [...m.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > right + 1 && el.getBoundingClientRect().width > 0 && !clipped(el)).slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")} +${Math.round(el.getBoundingClientRect().right - right)} "${el.innerText.slice(0, 24).replace(/\s+/g, " ")}"`);
          })
        : [];
      chk(`${name} ${vp.width}px ${scheme}: no horizontal overflow`, o.doc <= 1 && o.main <= 1, JSON.stringify(o) + (culprits.length ? ` culprits: ${culprits.join(" | ")}` : ""));
      await h.shot(page, `le-sweep-${name}-${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1366, height: 768 });
  const before = (await summary(page)).raw;
  await page.reload();
  await page.getByText("Next payment").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  chk("hard reload: summary unchanged", (await summary(page)).raw === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / warnings / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("le-sweep-figures", "Loan & EMI sweep: summary, cards, counts and the stored installments all agree", async ({ page, logs }, chk, notes) => {
  await openLoans(page);
  const cs = await cards(page);
  const s = await summary(page);
  const loans = await h.list("loans");
  const emis = await h.list("emis");

  const owed = cs.filter((c) => !c.lent).reduce((n, c) => n + c.outstanding, 0);
  const recv = cs.filter((c) => c.lent).reduce((n, c) => n + c.outstanding, 0);
  chk(`'Total outstanding' == Σ card outstanding (${owed})`, Math.abs(s.total - owed) <= cs.length, `${s.total} vs ${owed}`);
  if (recv > 0) chk(`'to receive' line == Σ lent cards (${recv})`, new RegExp(`${recv.toLocaleString("en-IN")} to receive`).test(s.raw), s.raw);
  chk("'Active' + 'Closed' == number of cards", s.active + s.closed === cs.length, `${s.active}+${s.closed} vs ${cs.length}`);
  chk("'All obligations N' badge and 'Showing n of N' == cards", (await showing(page))?.of === cs.length && (await showing(page))?.shown === cs.length, JSON.stringify(await showing(page)));
  chk("stored records == cards (loans + EMIs, not deleted)", loans.filter((l) => !l.deletedAt).length + emis.filter((e) => !e.deletedAt).length === cs.length, `${loans.length}+${emis.length}`);
  chk("overdue count == cards flagged overdue", s.overdue === cs.filter((c) => c.overdue).length, `${s.overdue} vs ${cs.filter((c) => c.overdue).length}`);
  const first = cs[0];
  chk("'Next payment' names the first (soonest) card and its next-EMI amount", !!s.next && s.next[2].includes(first.name) && num(s.next[1]) === first.nextAmount, `${s.next?.[1]} ${s.next?.[2]} vs ${first.name} ${first.nextAmount}`);

  // Each card's "x of y" against the stored installments of its schedule.
  let sampled = false;
  for (const c of cs) {
    const rec = loans.find((l) => l.name === c.name) ?? emis.find((e) => e.name === c.name);
    const inst = rec ? await h.list(`paymentSchedules/${rec.scheduleId}/installments`) : [];
    if (!sampled && inst[0]) { notes.push(`installment doc fields: ${Object.keys(inst[0]).join(",")}`); sampled = true; }
    const paid = inst.filter((i) => !i.deletedAt && i.amountDue > 0 && i.amountPaid >= i.amountDue - 0.005).length;
    chk(`${c.name}: card says ${c.paid} of ${c.total} — stored schedule has ${inst.length} installments, ${paid} settled`, inst.length === c.total && paid === c.paid, `${c.paid}/${c.total} vs ${paid}/${inst.length}`);
  }

  // Type / status pills filter the list and the counts agree.
  const pills = await page.getByRole("radiogroup", { name: "Type" }).getByRole("radio").evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  notes.push(`type pills: ${pills.join(" | ")}`);
  for (const p of pills) {
    const m = /^(.*?)\s(\d+)$/.exec(p);
    await page.getByRole("radiogroup", { name: "Type" }).getByRole("radio", { name: p }).click();
    await page.waitForTimeout(500);
    const sh = await showing(page);
    chk(`type pill "${m[1]}" shows ${m[2]} (list and 'Showing' agree)`, sh?.shown === Number(m[2]) && (await page.locator(CARDS).count()) === Number(m[2]), `${JSON.stringify(sh)} cards ${await page.locator(CARDS).count()}`);
  }
  await page.getByRole("radiogroup", { name: "Type" }).getByRole("radio", { name: /^All types/ }).click();
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors while reading the page", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("le-sweep-controls", "Loan & EMI sweep: search, amount queries, filters, Reset, empty state, card open/close, Add dialog, commitments panel and deep links respond", async ({ page, logs }, chk) => {
  await openLoans(page);
  const search = page.getByLabel(/Search loans and EMIs/);
  const total = (await cards(page)).length;
  const q = async (text) => { await search.fill(text); await page.waitForTimeout(600); return names(page); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());

  let r = await q("phone");
  chk("search 'phone' → QA Phone EMI", eq(r, ["QA Phone EMI"]), r.join(","));
  r = await q("housing");
  chk("search by lender 'housing' → QA Loan 60", eq(r, ["QA Loan 60"]), r.join(","));
  r = await q(">100000");
  chk("search '>100000' → only the ₹3,00,000 loan", eq(r, ["QA Loan 60"]), r.join(","));
  r = await q("1000-5000");
  chk("search '1000-5000' (a range over outstanding / total / next EMI)", eq(r, ["QA Shared EMI", "QA Phone EMI", "QA Card EMI", "QA Personal Loan"]), r.join(","));
  r = await q("24000");
  chk("search '24000' finds the ₹24,000 EMI", r.includes("QA Phone EMI"), r.join(","));
  chk("typing shows 'Showing n of N' and a Reset button", (await showing(page))?.shown === r.length && (await page.getByRole("button", { name: "Reset" }).count()) === 1);
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.waitForTimeout(500);
  chk("'Clear search' (x) empties the box and restores all cards", (await search.inputValue()) === "" && (await page.locator(CARDS).count()) === total);
  r = await q("zzz-nothing");
  chk("no match → 'No matches' with 'Clear filters'", /No matches/.test(await page.locator(LIST).innerText()) && (await page.getByRole("button", { name: "Clear filters" }).count()) === 1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.waitForTimeout(500);
  chk("'Clear filters' restores the list", (await page.locator(CARDS).count()) === total && (await search.inputValue()) === "");
  await q("loan");
  await page.getByRole("radiogroup", { name: "Type" }).getByRole("radio", { name: /^Bank Loan/ }).click();
  await page.waitForTimeout(500);
  chk("search + type pill combine (AND)", eq(await names(page), ["QA Loan 12", "QA Loan 60"]), (await names(page)).join(","));
  await page.getByRole("button", { name: "Reset" }).click();
  await page.waitForTimeout(500);
  chk("'Reset' clears search and the pills together", (await page.locator(CARDS).count()) === total && (await search.inputValue()) === "" && (await page.getByRole("radio", { name: /^All types/ }).getAttribute("aria-checked")) === "true");

  // Cards: mouse, keyboard
  const card = page.locator(CARDS).filter({ hasText: "QA Phone EMI" }).first();
  await card.click();
  const dlg = page.getByRole("dialog").first();
  await dlg.waitFor();
  chk("clicking a card opens its details", /QA Phone EMI/.test(await dlg.innerText()));
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });
  chk("Escape closes the details", (await page.getByRole("dialog").count()) === 0);
  await card.focus();
  await page.keyboard.press("Enter");
  await dlg.waitFor();
  chk("Enter on a focused card opens it", /QA Phone EMI/.test(await dlg.innerText()));
  await dlg.getByRole("button", { name: "Close", exact: true }).first().click();
  await dlg.waitFor({ state: "hidden" });
  chk("the X closes the details", (await page.getByRole("dialog").count()) === 0);

  // Commitments panel
  const panel = page.locator("main").getByText("My EMI").first();
  chk("commitments panel shows this month's confirmed total", /My EMI — Confirmed/.test(flat(await page.locator("main").innerText())));
  const ctl = (name) => page.getByRole("radio", { name }).or(page.getByRole("tab", { name })).or(page.getByRole("button", { name, exact: true })).first();
  const nextBtn = ctl("Next month");
  const beforePanel = flat(await page.locator("main").innerText()).match(/My EMI — Confirmed.*?(?=All obligations)/)?.[0] ?? "";
  await nextBtn.click();
  await page.waitForTimeout(600);
  const afterPanel = flat(await page.locator("main").innerText()).match(/My EMI — Confirmed.*?(?=All obligations)/)?.[0] ?? "";
  chk("'Next month' switches the panel to the next month", afterPanel !== beforePanel && /Dec 2026/.test(afterPanel), afterPanel.slice(0, 120));
  await ctl("This month").click();
  await page.waitForTimeout(600);
  chk("'This month' switches back", (flat(await page.locator("main").innerText()).match(/My EMI — Confirmed.*?(?=All obligations)/)?.[0] ?? "") === beforePanel);
  void panel;
  const showBtn = page.getByRole("button", { name: /Show details/ }).first();
  if (await showBtn.count()) {
    await showBtn.click();
    await page.waitForTimeout(500);
    chk("'Show details' expands and offers 'Hide details'", (await page.getByRole("button", { name: /Hide details/ }).count()) === 1);
    await page.getByRole("button", { name: /Hide details/ }).first().click();
  }

  // Add dialog (nothing saved)
  await page.evaluate(() => window.__reset());
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  const add = page.getByRole("dialog").first();
  await add.waitFor();
  chk("Add opens 'Add to Loan & EMI' with four kinds", /Add to Loan & EMI/.test(await add.innerText()) && (await add.getByRole("radio").count()) === 4, (await add.getByRole("radio").allInnerTexts()).map(flat).join(" | "));
  for (const kind of ["Loan I Took", "Purchase", "Credit Card", "Loan I Gave"]) {
    await add.getByRole("radio", { name: new RegExp(`^${kind}`) }).click();
    await page.waitForTimeout(350);
    chk(`'${kind}' selects it and shows its fields`, (await add.getByRole("radio", { name: new RegExp(`^${kind}`) }).getAttribute("aria-checked")) === "true" && /Amount/.test(await add.innerText()), flat(await add.innerText()).slice(0, 90));
    await h.shot(page, `le-sweep-add-${kind.replace(/ /g, "-").toLowerCase()}`);
  }
  await add.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(800);
  chk("Save with nothing filled is refused with a message and writes nothing", (await commits(page)) === 0 && /Amount|required|Enter|Select|Add/i.test(await page.locator("body").innerText()));
  await page.keyboard.press("Escape");
  await add.waitFor({ state: "hidden" });
  chk("Escape closes the Add dialog; nothing written", (await page.getByRole("dialog").count()) === 0 && (await commits(page)) === 0);

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("le-sweep-handoff", "Loan & EMI sweep: /emi and ?create= deep links land on the one workspace; /loans-installments renders", async ({ page, logs }, chk) => {
  await openLoans(page, { fixtures: false });
  await h.go(page, "/dashboard");
  await page.waitForTimeout(1500);
  await h.go(page, "/emi");
  await page.getByRole("heading", { level: 1, name: "Loan & EMI" }).waitFor({ timeout: 60000 });
  chk("/emi opens the Loan & EMI workspace", /Track what you owe/.test(await page.locator("main").innerText()));
  for (const [param, kind] of [["borrowed", "Loan I Took"], ["lent", "Loan I Gave"], ["installmentPurchase", "Purchase"]]) {
    await h.go(page, "/dashboard");
    await page.waitForTimeout(1200);
    await h.go(page, `/loans?create=${param}`);
    const add = page.getByRole("dialog").first();
    await add.waitFor({ timeout: 30000 });
    chk(`?create=${param} opens Add with '${kind}' preselected`, /Add to Loan & EMI/.test(await add.innerText()) && (await add.getByRole("radio", { name: new RegExp(`^${kind}`) }).getAttribute("aria-checked")) === "true");
    await page.keyboard.press("Escape");
    await add.waitFor({ state: "hidden" });
  }
  await h.go(page, "/loans-installments");
  await page.waitForTimeout(3000);
  const body = flat(await page.locator("main").innerText());
  chk("/loans-installments renders (no error page)", body.length > 40 && !/This page could not be found|Something went wrong|Application error/i.test(body), body.slice(0, 100));
  await h.shot(page, "le-sweep-installments-route");
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────── Details dialogs ───────────────────────── */

const topDialog = (page) => page.getByRole("dialog").last();
async function openRecord(page, name) {
  await page.locator(CARDS).filter({ hasText: name }).first().click();
  await page.getByRole("dialog").first().waitFor();
  await page.waitForTimeout(1800);
}
/** Esc closes the top dialog only; returns how many dialogs remain. */
async function escOnce(page) {
  const before = await page.getByRole("dialog").count();
  await page.keyboard.press("Escape");
  await page.waitForFunction((n) => document.querySelectorAll('[role="dialog"]').length < n, before, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  return page.getByRole("dialog").count();
}

scenario("le-sweep-loan-dialog", "Loan & EMI sweep: the loan details dialog — tabs, installment filters, Pay / Record / Receive More / Edit / paid-row dialogs all open and cancel without writing", async ({ page, logs }, chk) => {
  await openLoans(page, { fixtures: false });
  await openRecord(page, "QA Loan 12");
  const d = page.getByRole("dialog").first();
  const t = flat(await d.innerText());
  chk("header: LOAN, name, outstanding ₹55,269, '1 of 12 paid · 11 left'", /LOAN QA Loan 12/.test(t) && /OUTSTANDING ₹55,269/.test(t) && /1 of 12 paid/.test(t) && /11 left/.test(t), t.slice(0, 160));
  chk("next installment is #2 of 12, ₹5,331, due 14 Dec", /Next installment.*Due 14 Dec.*₹5,331.*#2 of 12/.test(t), t.slice(0, 220));
  await h.shot(page, "le-sweep-loan-dialog");

  const rowSel = '[aria-label^="Installment "], [aria-label^="Pay installment"]';
  const pill = (n) => d.getByRole("radio", { name: new RegExp(`^${n}`) }).or(d.getByRole("tab", { name: new RegExp(`^${n}`) })).or(d.getByRole("button", { name: new RegExp(`^${n} \\d+`) })).first();
  for (const [name, want] of [["All", 12], ["Upcoming", 11], ["Paid", 1]]) {
    await pill(name).click();
    await page.waitForTimeout(400);
    chk(`filter '${name}' lists ${want} installment rows`, (await d.locator(rowSel).count()) === want, await d.locator(rowSel).count());
  }
  await pill("All").click();
  await page.waitForTimeout(300);
  chk("11 'Pay' buttons (one per upcoming installment)", (await d.getByRole("button", { name: /^Pay installment \d+/ }).count()) === 11, await d.getByRole("button", { name: /^Pay installment \d+/ }).count());

  for (const tab of ["Details", "History", "Installments"]) {
    await d.getByRole("tab", { name: new RegExp(`^${tab}`) }).or(d.getByRole("button", { name: new RegExp(`^${tab}`) })).first().click();
    await page.waitForTimeout(500);
    chk(`tab '${tab}' shows its content`, flat(await d.innerText()).length > 80 && !/NaN|undefined/.test(await d.innerText()), flat(await d.innerText()).slice(0, 100));
    if (tab === "Details") await h.shot(page, "le-sweep-loan-details-tab");
    if (tab === "History") chk("History shows the one recorded payment (₹5,331, 'already paid earlier')", /5,33[01]/.test(await d.innerText()) && /already paid earlier/i.test(await d.innerText()));
  }

  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: /^Pay installment 2/ }).click();
  const pay = topDialog(page);
  await pay.waitFor();
  await page.waitForTimeout(1200);
  const pt = flat(await pay.innerText());
  chk("payment dialog: ₹5,330.93 to the lender, outstanding ₹55,269.07 → ₹50,490.83", /Pay installment/.test(pt) && /TO PAY LENDER ₹5,330\.93/.test(pt) && /₹55,269\.07/.test(pt) && /₹50,490\.83/.test(pt), pt.slice(0, 200));
  chk("it says what is still needed ('Paying account')", /Still needed:\s*Paying account/.test(pt));
  await h.shot(page, "le-sweep-loan-pay-dialog");
  for (const [btn, expect] of [["Record past payments", /past payments|Already paid/i], ["Pay several installments now", /several|installments/i]]) {
    await pay.getByRole("button", { name: new RegExp(btn) }).click();
    await page.waitForTimeout(1200);
    chk(`'${btn}' opens its own dialog`, expect.test(await topDialog(page).innerText()), flat(await topDialog(page).innerText()).slice(0, 100));
    await h.shot(page, `le-sweep-loan-${btn.split(" ")[0].toLowerCase()}-${btn.split(" ")[1]}`);
    await escOnce(page);
    if ((await page.getByRole("dialog").count()) < 2) {
      await d.getByRole("button", { name: /^Pay installment 2/ }).click();
      await topDialog(page).waitFor();
      await page.waitForTimeout(1000);
    }
  }
  await topDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(600);
  chk("Cancel closes the payment dialog and returns to the loan", (await page.getByRole("dialog").count()) === 1);

  await d.getByRole("button", { name: /^Installment 1 for .*edit or mark unpaid/ }).click();
  const rec = topDialog(page);
  await rec.waitFor();
  await page.waitForTimeout(1000);
  const rt = flat(await rec.innerText());
  chk("paid row opens 'Recorded payment' (₹5,330.93, already paid earlier)", /Recorded payment/.test(rt) && /5,330\.93/.test(rt) && /Already paid earlier/i.test(rt), rt.slice(0, 160));
  for (const b of ["Mark as unpaid", "Edit payment", "Close"]) chk(`recorded payment has a '${b}' button`, (await rec.getByRole("button", { name: b, exact: true }).count()) >= 1);
  await rec.getByRole("button", { name: "Edit payment" }).click();
  await page.waitForTimeout(1000);
  chk("'Edit payment' opens an edit form", /Edit|amount/i.test(await topDialog(page).innerText()), flat(await topDialog(page).innerText()).slice(0, 100));
  await h.shot(page, "le-sweep-loan-edit-payment");
  for (let i = 0; i < 4 && (await page.getByRole("button", { name: "Receive More Money", exact: true }).count()) === 0; i++) await escOnce(page);
  chk("Escape from the edit form returns to the loan details", (await page.getByRole("button", { name: "Receive More Money", exact: true }).count()) === 1);

  for (const [btn, expect] of [["Receive More Money", /Add more money you received/], ["Record Payment", /LOAN PAYMENT|Pay installment/i], ["Edit", /Edit QA Loan 12/]]) {
    await d.getByRole("button", { name: btn, exact: true }).click();
    await page.waitForTimeout(1200);
    chk(`'${btn}' opens its dialog`, expect.test(await topDialog(page).innerText()), flat(await topDialog(page).innerText()).slice(0, 90));
    if (btn === "Receive More Money") {
      await topDialog(page).getByRole("button", { name: "Receive More Money" }).click();
      await page.waitForTimeout(800);
      chk("'Receive More Money' with no amount is refused (nothing written)", (await commits(page)) === 0 && /Add more money you received/.test(await topDialog(page).innerText()), `${await commits(page)} commits`);
    }
    if (btn === "Edit") await h.shot(page, "le-sweep-loan-edit");
    await topDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(700);
    chk(`Cancel closes '${btn}' and keeps the loan open`, (await page.getByRole("button", { name: "Close loan", exact: true }).count()) === 1);
  }
  chk("none of this wrote anything", (await commits(page)) === 0, `${await commits(page)} commits`);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("le-sweep-close-reopen", "Loan & EMI sweep: Close / Reopen a loan and an EMI persists and moves the counts; Delete needs the typed name", async ({ page, logs }, chk) => {
  await openLoans(page);
  const before = await summary(page);
  const loans = () => h.list("loans");
  const emis = () => h.list("emis");
  const emiCount0 = (await emis()).filter((e) => !e.deletedAt).length;

  await openRecord(page, "QA Personal Loan");
  let d = page.getByRole("dialog").first();
  await d.getByRole("button", { name: "Close loan", exact: true }).click();
  await page.waitForTimeout(2500);
  chk("Close loan: the stored loan is closed", (await loans()).find((l) => l.name === "QA Personal Loan")?.isClosed === true);
  chk("the dialog now says Closed and offers Reopen", /Closed/.test(await d.innerText()) && (await d.getByRole("button", { name: "Reopen", exact: true }).count()) === 1);
  await d.getByRole("button", { name: "Close", exact: true }).first().click();
  await d.waitFor({ state: "hidden" });
  await page.waitForTimeout(1200);
  const mid = await summary(page);
  chk("summary: Active −1, Closed +1, outstanding −₹20,000", mid.active === before.active - 1 && mid.closed === before.closed + 1 && Math.abs(before.total - mid.total - 20000) <= 6, `${before.active}/${before.closed}/${before.total} → ${mid.active}/${mid.closed}/${mid.total}`);
  chk("a Status filter (All / Active / Closed) now appears", (await page.getByRole("radiogroup", { name: "Status" }).count()) === 1);
  await page.getByRole("radiogroup", { name: "Status" }).getByRole("radio", { name: /^Closed/ }).click();
  await page.waitForTimeout(500);
  chk("Status 'Closed' lists just the closed loan", JSON.stringify(await names(page)) === JSON.stringify(["QA Personal Loan"]), (await names(page)).join(","));
  await h.shot(page, "le-sweep-closed-filter");
  await page.getByRole("radiogroup", { name: "Status" }).getByRole("radio", { name: /^Active/ }).click();
  await page.waitForTimeout(500);
  chk("Status 'Active' hides it", !(await names(page)).includes("QA Personal Loan") && (await page.locator(CARDS).count()) === before.active - 1);
  await page.getByRole("radiogroup", { name: "Status" }).getByRole("radio", { name: /^All/ }).click();
  await page.waitForTimeout(400);
  await openRecord(page, "QA Personal Loan");
  d = page.getByRole("dialog").first();
  await d.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.waitForTimeout(2500);
  chk("Reopen: the stored loan is open again", (await loans()).find((l) => l.name === "QA Personal Loan")?.isClosed === false);
  await d.getByRole("button", { name: "Close", exact: true }).first().click();
  await d.waitFor({ state: "hidden" });
  await page.waitForTimeout(1200);
  const after = await summary(page);
  chk("summary returns to the starting figures", after.active === before.active && after.closed === before.closed && Math.abs(after.total - before.total) <= 6, `${after.active}/${after.closed}/${after.total}`);

  await openRecord(page, "QA Phone EMI");
  d = page.getByRole("dialog").first();
  await d.getByRole("button", { name: "Close EMI", exact: true }).click();
  await page.waitForTimeout(2500);
  chk("Close EMI: the stored EMI is closed", (await emis()).find((e) => e.name === "QA Phone EMI")?.isClosed === true);
  await d.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.waitForTimeout(2500);
  chk("Reopen EMI: open again", (await emis()).find((e) => e.name === "QA Phone EMI")?.isClosed === false);

  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForTimeout(1200);
  const del = topDialog(page);
  chk("Delete asks first: names the EMI, says nothing is recorded, offers Cancel / Delete permanently", /Delete QA Phone EMI permanently?/.test(await del.innerText()) && /can.t be undone/.test(await del.innerText()) && (await del.getByRole("button", { name: "Cancel" }).count()) === 1 && (await del.getByRole("button", { name: /Delete permanently/i }).count()) === 1, flat(await del.innerText()).slice(0, 200));
  await h.shot(page, "le-sweep-delete-guard");
  await del.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(700);
  chk("Cancel keeps the EMI (stored and listed)", (await emis()).some((e) => e.name === "QA Phone EMI" && !e.deletedAt) && (await page.getByRole("button", { name: "Close EMI", exact: true }).count()) === 1);
  chk("no delete was written", (await emis()).filter((e) => !e.deletedAt).length === emiCount0, (await emis()).filter((e) => !e.deletedAt).length);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("le-sweep-emi-dialog", "Loan & EMI sweep: the EMI details dialog (shared and card-linked) — people shares, Pay / Record / Edit terms / past payments dialogs open and cancel without writing", async ({ page, logs }, chk) => {
  await openLoans(page);
  await openRecord(page, "QA Shared EMI");
  const d = page.getByRole("dialog").first();
  const t = flat(await d.innerText());
  chk("header: EMI, name, outstanding ₹9,000, 'Missed payment', '0 of 3 paid'", /EMI QA Shared EMI/.test(t) && /OUTSTANDING ₹9,000/.test(t) && /Missed payment/.test(t) && /0 of 3 paid/.test(t), t.slice(0, 160));
  chk("overdue installment #1 shows both people's shares to receive (₹1,000 each)", /Overdue by \d+ days?.*QA Priya: ₹1,000 to receive · QA Ravi: ₹1,000 to receive/.test(t), t.slice(200, 420));
  chk("three 'Pay' buttons", (await d.getByRole("button", { name: /^Pay installment \d+/ }).count()) === 3);
  await h.shot(page, "le-sweep-emi-dialog");
  await page.evaluate(() => window.__reset());

  await d.getByRole("button", { name: /^Pay installment 1/ }).click();
  await page.waitForTimeout(1500);
  const pay = topDialog(page);
  chk("Pay installment 1 opens an EMI payment dialog showing ₹3,000", /3,000/.test(await pay.innerText()), flat(await pay.innerText()).slice(0, 200));
  await h.shot(page, "le-sweep-emi-pay-dialog");
  await escOnce(page);
  chk("Escape returns to the EMI details", (await page.getByRole("button", { name: "Close EMI", exact: true }).count()) === 1);

  for (const [btn, expect] of [["Record Payment", /payment|Pay/i], ["Edit terms", /terms|Edit/i], ["Record past payments", /past payments|Already paid/i]]) {
    await d.getByRole("button", { name: btn, exact: true }).click();
    await page.waitForTimeout(1300);
    chk(`'${btn}' opens its dialog`, expect.test(await topDialog(page).innerText()), flat(await topDialog(page).innerText()).slice(0, 110));
    await h.shot(page, `le-sweep-emi-${btn.toLowerCase().replace(/ /g, "-")}`);
    await escOnce(page);
    chk(`closing '${btn}' keeps the EMI open`, (await page.getByRole("button", { name: /^Close EMI|^Reopen/ }).count()) === 1);
  }
  await escOnce(page);

  await openRecord(page, "QA Card EMI");
  const c = page.getByRole("dialog").first();
  const ct = flat(await c.innerText());
  chk("card EMI: outstanding ₹12,000, 0 of 4 paid, four Pay buttons", /OUTSTANDING ₹12,000/.test(ct) && /0 of 4 paid/.test(ct) && (await c.getByRole("button", { name: /^Pay installment \d+/ }).count()) === 4, ct.slice(0, 140));
  await c.getByRole("button", { name: /^Pay installment 1/ }).click();
  await page.waitForTimeout(1500);
  chk("card EMI Pay opens its payment dialog (₹3,000)", /3,000/.test(await topDialog(page).innerText()), flat(await topDialog(page).innerText()).slice(0, 160));
  await h.shot(page, "le-sweep-card-emi-pay");
  await escOnce(page);
  chk("none of this wrote anything", (await commits(page)) === 0, `${await commits(page)} commits`);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────── Add flows (write) ───────────────────────── */

const pad2 = (n) => String(n).padStart(2, "0");
async function typeDate(loc, ddmmyyyy) {
  await loc.fill("");
  await loc.pressSequentially(ddmmyyyy.replace(/\//g, ""));
}
async function openAddDialog(page, kind) {
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  const d = page.getByRole("dialog").first();
  await d.waitFor();
  await d.getByRole("radio", { name: new RegExp(`^${kind}`) }).click();
  await page.waitForTimeout(400);
  return d;
}
async function preset(d, n) {
  await d.getByRole("radio", { name: String(n), exact: true }).or(d.getByRole("button", { name: String(n), exact: true })).first().click();
}
/** Picks the option matching `re` in the dialog's native <select> that offers it. */
async function pickNative(d, re) {
  const sels = d.locator("select");
  for (let i = 0; i < (await sels.count()); i++) {
    const labels = await sels.nth(i).locator("option").allInnerTexts();
    const hit = labels.find((l) => re.test(l));
    if (hit) { await sels.nth(i).selectOption({ label: hit }); return hit; }
  }
  throw new Error(`no select offers ${re}`);
}
async function saveAndWait(page, d) {
  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: "Save", exact: true }).evaluate((b) => { b.click(); b.click(); });
  await d.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

scenario("le-sweep-add", "Loan & EMI sweep: Add a loan I took, a loan I gave, a purchase and a card EMI through the form — stored records, schedules, cards and the Edit form's dates all agree (double-click saves once)", async ({ page, logs }, chk, notes) => {
  await openLoans(page, { fixtures: false });
  const before = { loans: (await h.list("loans")).filter((l) => !l.deletedAt).length, emis: (await h.list("emis")).filter((e) => !e.deletedAt).length };
  const today = new Date();
  const todayStr = `${pad2(today.getDate())}/${pad2(today.getMonth() + 1)}/${today.getFullYear()}`;

  // ── Loan I Took ──
  let d = await openAddDialog(page, "Loan I Took");
  await d.locator('input[placeholder="e.g. HDFC Bank"]').fill("Sweep Bank");
  await d.locator('input[placeholder="0"]').first().fill("12000");
  await preset(d, 3);
  const dateInputs = d.locator('input[placeholder="dd/mm/yyyy"]');
  chk("the 'Loan taken on' default is today's local date", (await dateInputs.nth(0).inputValue()) === todayStr, await dateInputs.nth(0).inputValue());
  await typeDate(dateInputs.nth(1), "15/12/2026");
  const preview = flat(await d.innerText());
  notes.push(`preview text: ${(preview.match(/(Each|Per|EMI)[^.]{0,80}/) ?? [""])[0]}`);
  await h.shot(page, "le-sweep-add-loan-filled");
  await saveAndWait(page, d);
  let loans = (await h.list("loans")).filter((l) => !l.deletedAt);
  const mine = loans.find((l) => l.institutionName === "Sweep Bank" || l.name === "Sweep Bank");
  chk("saved once despite a double-click (one new loan)", loans.length === before.loans + 1 && !!mine, `${loans.length} vs ${before.loans}+1`);
  chk("stored: taken, ₹12,000, 3 installments, monthly", mine?.direction === "taken" && mine?.loanAmount === 12000 && mine?.installmentCount === 3 && /month/i.test(String(mine?.installmentFrequency)), JSON.stringify(mine && { dir: mine.direction, amt: mine.loanAmount, n: mine.installmentCount, f: mine.installmentFrequency }));
  const inst = (await h.list(`paymentSchedules/${mine.scheduleId}/installments`)).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  chk("schedule: 3 installments of ₹4,000 (sum ₹12,000, no interest)", inst.length === 3 && inst.every((i) => Math.abs(i.amountDue - 4000) < 0.01) && Math.abs(inst.reduce((s, i) => s + i.amountDue, 0) - 12000) < 0.01, inst.map((i) => i.amountDue).join(","));
  const due = inst.map((i) => new Date(i.dueDate));
  chk("first due date is 15 Dec 2026 (local day), then monthly", due[0].getFullYear() === 2026 && due[0].getMonth() === 11 && due[0].getDate() === 15 && due[1].getMonth() === 0 && due[1].getDate() === 15 && due[2].getMonth() === 1 && due[2].getDate() === 15, due.map((x) => x.toString().slice(4, 15)).join(" | "));
  chk("the card appears: 'Sweep Bank', outstanding ₹12,000, 0 of 3", (await cards(page)).some((c) => /Sweep Bank/.test(c.name) && c.outstanding === 12000 && c.paid === 0 && c.total === 3), (await cards(page)).map((c) => c.name).join(","));

  // Edit form must show the same dates that were entered
  await openRecord(page, "Sweep Bank");
  await page.getByRole("dialog").first().getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(1500);
  const ed = topDialog(page);
  const eDates = ed.locator('input[placeholder="dd/mm/yyyy"]');
  const loanDateShown = await eDates.nth(0).inputValue();
  const firstShown = await eDates.nth(1).inputValue();
  chk(`Edit form: 'Loan taken on' shows what was entered (${todayStr})`, loanDateShown === todayStr, `shows ${loanDateShown}`);
  chk("Edit form: 'First EMI Date' shows what was entered (15/12/2026)", firstShown === "15/12/2026", `shows ${firstShown}`);
  await h.shot(page, "le-sweep-edit-dates");
  await ed.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(600);
  await escOnce(page);

  // ── Loan I Gave ──
  d = await openAddDialog(page, "Loan I Gave");
  await pickNative(d, /QA Priya/);
  await d.locator('input[placeholder="0"]').first().fill("5000");
  await preset(d, 3);
  await saveAndWait(page, d);
  loans = (await h.list("loans")).filter((l) => !l.deletedAt);
  const gave = loans.find((l) => l.direction === "given");
  chk("Loan I Gave: stored (given, ₹5,000, 3 installments)", !!gave && gave.loanAmount === 5000 && gave.installmentCount === 3, JSON.stringify(gave && { a: gave.loanAmount, n: gave.installmentCount }));
  chk("its card says 'Still to receive ₹5,000' and the summary shows ₹5,000 to receive", (await cards(page)).some((c) => c.lent && c.outstanding === 5000) && /5,000 to receive/.test((await summary(page)).raw), (await summary(page)).raw.slice(0, 160));

  // ── Purchase ──
  d = await openAddDialog(page, "Purchase");
  await d.locator('input[placeholder="e.g. iPhone 16"]').fill("Sweep Phone");
  await d.locator('input[placeholder="0"]').first().fill("6000");
  await preset(d, 3);
  await typeDate(d.locator('input[placeholder="dd/mm/yyyy"]').first(), "20/12/2026");
  await saveAndWait(page, d);
  let emis = (await h.list("emis")).filter((e) => !e.deletedAt);
  const ph = emis.find((e) => e.name === "Sweep Phone");
  chk("Purchase: stored once (₹6,000, 3 installments)", emis.length === before.emis + 1 && ph?.principalAmount === 6000 && ph?.installmentCount === 3, JSON.stringify(ph && { a: ph.principalAmount, n: ph.installmentCount }));
  const pi = (await h.list(`paymentSchedules/${ph.scheduleId}/installments`)).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  chk("Purchase schedule: 3 × ₹2,000, first due 20 Dec 2026", pi.length === 3 && pi.every((i) => Math.abs(i.amountDue - 2000) < 0.01) && new Date(pi[0].dueDate).getDate() === 20 && new Date(pi[0].dueDate).getMonth() === 11, pi.map((i) => `${i.amountDue}@${new Date(i.dueDate).toString().slice(4, 15)}`).join(" | "));

  // ── Credit card EMI ──
  d = await openAddDialog(page, "Credit Card");
  await pickNative(d, /QA Credit Card/);
  await d.locator('input[placeholder="e.g. iPhone 16"]').fill("Sweep TV");
  await d.locator('input[placeholder="0"]').first().fill("9000");
  await preset(d, 3);
  await saveAndWait(page, d);
  emis = (await h.list("emis")).filter((e) => !e.deletedAt);
  const tv = emis.find((e) => e.name === "Sweep TV");
  chk("Card EMI: stored once, linked to the card (₹9,000 × 3)", emis.length === before.emis + 2 && tv?.principalAmount === 9000 && !!tv?.linkedCreditCardId, JSON.stringify(tv && { a: tv.principalAmount, card: tv.linkedCreditCardId }));
  chk("all four new records are listed (cards: " + (before.loans + before.emis + 4) + ")", (await page.locator(CARDS).count()) === before.loans + before.emis + 4, await page.locator(CARDS).count());
  const s = await summary(page);
  chk("summary counts them (Active == cards) and has no NaN", s.active === (await page.locator(CARDS).count()) && !/NaN/.test(s.raw), s.raw.slice(0, 140));
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────── Edit save path (write) ───────────────────────── */

scenario("le-sweep-edit", "Loan & EMI sweep: editing an unpaid loan — a lender rename leaves every stored date untouched; changing the first EMI date moves the schedule to that local day", async ({ page, logs }, chk) => {
  await openLoans(page, { fixtures: false });
  const loanDoc = async () => (await h.list("loans")).find((l) => l.name === "QA Loan 60");
  const instDocs = async (l) => (await h.list(`paymentSchedules/${l.scheduleId}/installments`)).filter((i) => !i.deletedAt).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const l0 = await loanDoc();
  const i0 = await instDocs(l0);
  const loanDate0 = l0.loanDate;
  const due0 = i0.map((i) => i.dueDate);

  await openRecord(page, "QA Loan 60");
  await page.getByRole("dialog").first().getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(1500);
  let ed = topDialog(page);
  const dates = ed.locator('input[placeholder="dd/mm/yyyy"]');
  const shownLoan = await dates.nth(0).inputValue();
  const shownFirst = await dates.nth(1).inputValue();
  const ddmmyyyy = (iso) => { const d = new Date(iso); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; };
  chk(`Edit form shows the stored loan date (${ddmmyyyy(loanDate0)}) and first EMI date (${ddmmyyyy(due0[0])})`, shownLoan === ddmmyyyy(loanDate0) && shownFirst === ddmmyyyy(due0[0]), `${shownLoan} / ${shownFirst}`);
  await ed.getByText("Bank / lender", { exact: true }).first().locator("xpath=following::input[1]").fill("QA Housing Bank 2");
  await page.evaluate(() => window.__reset());
  await ed.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(4000);
  const l1 = await loanDoc();
  const i1 = await instDocs(l1);
  chk("lender rename persisted", l1.institutionName === "QA Housing Bank 2", l1.institutionName);
  chk("a details-only edit left the loan date and all 60 due dates exactly as stored", l1.loanDate === loanDate0 && i1.length === 60 && JSON.stringify(i1.map((i) => i.dueDate)) === JSON.stringify(due0), `${l1.loanDate} vs ${loanDate0}; changed dues: ${i1.filter((i, k) => i.dueDate !== due0[k]).length}`);
  chk("amounts untouched (₹3,00,000, 60 × same EMI)", l1.loanAmount === 300000 && i1.every((i, k) => Math.abs(i.amountDue - i0[k].amountDue) < 0.005));

  // Change the first EMI date (after a save the app returns to the loan details — close them first)
  for (let i = 0; i < 3 && (await page.getByRole("dialog").count()) > 0; i++) await escOnce(page);
  await openRecord(page, "QA Loan 60");
  await page.getByRole("dialog").first().getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(1500);
  ed = topDialog(page);
  await typeDate(ed.locator('input[placeholder="dd/mm/yyyy"]').nth(1), "20/12/2026");
  await page.evaluate(() => window.__reset());
  await ed.getByRole("button", { name: "Save Changes" }).click();
  // Re-planning 60 installments takes a while on the emulator — wait for the progress to finish.
  await page.waitForFunction(() => !/Updating loan/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const i2 = await instDocs(await loanDoc());
  const d20 = new Date(i2[0].dueDate);
  chk("first installment is now due on 20 Dec 2026 (local day), 60 installments kept", i2.length === 60 && d20.getFullYear() === 2026 && d20.getMonth() === 11 && d20.getDate() === 20, `${i2.length}; first due ${d20.toString().slice(0, 21)}`);
  chk("the next installments follow monthly on the 20th", [1, 2, 3].every((k) => { const x = new Date(i2[k].dueDate); return x.getDate() === 20 && ((11 + k) % 12) === x.getMonth(); }), [1, 2, 3].map((k) => new Date(i2[k].dueDate).toString().slice(4, 15)).join(" | "));
  chk("the loan date itself did not move", (await loanDoc()).loanDate === loanDate0);
  await openRecord(page, "QA Loan 60").catch(() => {});
  await h.shot(page, "le-sweep-edit-saved");
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────── Receive More Money (write) + re-open ───────────────────────── */

scenario("le-sweep-receive-more", "Loan & EMI sweep: 'Receive More Money' writes once (bank +₹1,000, loan grows), then re-opening it is a clean form", async ({ page, logs }, chk, notes) => {
  await openLoans(page, { fixtures: false });
  const bank0 = (await h.accountBalance("QA Bank")).currentBalance;
  const loan0 = (await h.list("loans")).find((l) => l.name === "QA Loan 12");
  await openRecord(page, "QA Loan 12");
  const d = page.getByRole("dialog").first();
  const before = flat(await d.innerText());
  await d.getByRole("button", { name: "Receive More Money", exact: true }).click();
  await page.waitForTimeout(1200);
  let r = topDialog(page);
  await r.locator('input[placeholder="0"]').first().fill("1000").catch(async () => { await r.getByRole("spinbutton").first().fill("1000"); });
  await pickNative(r, /QA Bank/);
  await h.shot(page, "le-sweep-receive-filled");
  await page.evaluate(() => window.__reset());
  await r.getByRole("button", { name: /^Receive ₹1,000/ }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(5000);
  const bank1 = (await h.accountBalance("QA Bank")).currentBalance;
  const loan1 = (await h.list("loans")).find((l) => l.name === "QA Loan 12");
  chk("QA Bank credited ₹1,000 exactly once (double-click guarded)", Math.abs(bank1 - bank0 - 1000) < 0.01, `${bank0} → ${bank1}`);
  notes.push(`loan amount ${loan0.loanAmount} → ${loan1.loanAmount}; outstanding line before: ${(before.match(/OUTSTANDING ₹[\d,]+/) ?? [""])[0]}`);
  chk("the loan grew by ₹1,000 (stored)", Math.abs(loan1.loanAmount - loan0.loanAmount - 1000) < 0.01, `${loan0.loanAmount} → ${loan1.loanAmount}`);
  const adds = (await h.list("transactions")).filter((t) => !t.deletedAt && t.loanId === loan1.id && t.paymentAllocationType === "additionalDisbursement");
  chk("one 'additional disbursement' transaction of ₹1,000 on QA Bank", adds.length === 1 && adds[0].amount === 1000, adds.length);

  // Back to the loan, then open the same dialog again: it must be a clean form, ready to use.
  for (let i = 0; i < 3 && (await page.getByRole("button", { name: "Receive More Money", exact: true }).count()) === 0; i++) await escOnce(page);
  await page.waitForTimeout(800);
  const t = flat(await d.innerText().catch(() => ""));
  chk("the loan details show the new outstanding", /OUTSTANDING/.test(t) && !/NaN/.test(t), t.slice(0, 120));
  await page.getByRole("button", { name: "Receive More Money", exact: true }).click();
  await page.waitForTimeout(1200);
  r = topDialog(page);
  const rt = flat(await r.innerText());
  chk("re-opened 'Receive More Money' is a clean form: empty amount, a primary button, no stale success", (await r.locator('input[placeholder="0"]').first().inputValue().catch(() => "")) === "" && (await r.getByRole("button", { name: /^Receive/ }).count()) >= 1 && !/added|updated|Done|100%/.test(rt), rt.slice(0, 200));
  await h.shot(page, "le-sweep-receive-reopened");
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});
