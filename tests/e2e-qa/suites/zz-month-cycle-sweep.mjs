/**
 * Month Cycle sweep (testing-phase check): every section renders, no console/page errors, no layout overflow, the figures
 * on one section agree with the other sections that show the same number, and every link / button does what its label says.
 * Read-only (the only write is the local "Cycle starts on" preference in the last scenario). Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const strip = (p) => p.replace(/\/+$/, "") || "/";
const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
/** "−₹1,234" / "-₹1,234" / "₹1,23,456" → number. */
const num = (s) => {
  const neg = /^[\s]*[-−]/.test(s);
  const n = Number(String(s).replace(/[^0-9.]/g, "")) || 0;
  return neg ? -n : n;
};
const flat = (s) => String(s).replace(/\s+/g, " ").trim();

async function openMC(page) {
  await h.go(page, "/month-cycle");
  await page.getByRole("heading", { level: 1, name: "Month Cycle" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(2200); // AnimatedNumber settles
}
/** innerText once it has stopped changing. */
async function stable(locator) {
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const t = await locator.innerText();
    if (t === prev) return t;
    prev = t;
    await locator.page().waitForTimeout(250);
  }
  return prev;
}
const scrollMain = (page, top) => page.evaluate((t) => { document.querySelector("main").scrollTop = t; }, top);

/** The cycle picker's trigger text in the page header (not the compact bar): "<Month Year> cycle <range>". */
const headerPicker = (page) => page.locator("main header").getByRole("button", { name: "Choose cycle" });

async function obligations(page) {
  const cells = await page.locator('section[aria-label="Obligations"] a').evaluateAll((as) =>
    as.map((a) => ({ href: a.getAttribute("href"), lines: a.innerText.split("\n").map((l) => l.trim()).filter(Boolean) })),
  );
  return cells.map((c) => ({ href: c.href, label: c.lines[0], amount: c.lines[1], meta: c.lines.slice(2).join(" ") }));
}

async function tabInfo(page) {
  const tabs = await page.locator('section[aria-label="Upcoming this cycle"] [role="tab"]').evaluateAll((els) =>
    els.map((e) => ({ text: e.innerText.replace(/\s+/g, " ").trim(), selected: e.getAttribute("aria-selected") === "true" })),
  );
  return tabs.map((t) => {
    const m = /^(EMI|Loans|Card bills|Bills)\s*(\d+)\s*(.*)$/.exec(t.text);
    return { title: m?.[1], count: m ? Number(m[2]) : NaN, total: m ? num(m[3]) : NaN, selected: t.selected, raw: t.text };
  });
}

async function activeRows(page) {
  return page.locator('section[aria-label="Upcoming this cycle"] .divide-y > div').evaluateAll((rows) =>
    rows.map((r) => r.innerText.split("\n").map((l) => l.trim()).filter(Boolean)),
  );
}

scenario("mc-sweep-render", "Month Cycle sweep: every section renders, no console errors, no overflow (desktop / laptop / tablet / mobile, light + dark)", async ({ page, logs }, chk) => {
  await openMC(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "mc-sweep-desktop-light");

  for (const [label, sel] of [
    ["Cycle summary", 'section[aria-label="Cycle summary"]'],
    ["Obligations", 'section[aria-label="Obligations"]'],
    ["Upcoming this cycle", 'section[aria-label="Upcoming this cycle"]'],
    ["People ledger", 'section[aria-label="People ledger"]'],
    ["Account spend", 'section[aria-label="Account spend"]'],
    ["Month at a glance", 'section[aria-label="Month at a glance"]'],
    ["Budget overview", 'section[aria-label="Budget overview"]'],
    ["section nav", 'nav[aria-label="Month cycle sections"]'],
  ]) chk(`section present: ${label}`, (await page.locator(sel).count()) === 1, sel);

  chk("six section-nav pills", (await page.locator('nav[aria-label="Month cycle sections"] button').count()) === 6);
  chk("six obligation tiles", (await page.locator('section[aria-label="Obligations"] a').count()) === 6);
  chk("four Due tabs", (await page.locator('section[aria-label="Upcoming this cycle"] [role="tab"]').count()) === 4);
  chk("no 'NaN' / 'undefined' / 'Infinity' / '[object' text", !/NaN|undefined|Infinity|\[object/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity|\[object).{0,30}/) || [""])[0]);
  chk("no skeleton left after load", (await page.locator('main [class*="animate-pulse"]').count()) === 0);
  chk("header shows the cycle name + range", /\w+ \d{4} cycle/.test(flat(await headerPicker(page).innerText())) && /\d{2} \w{3} – \d{2} \w{3}/.test(flat(await headerPicker(page).innerText())), flat(await headerPicker(page).innerText()));

  const overflow = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
  for (const [name, vp] of [["desktop", { width: 1920, height: 1080 }], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(vp);
      await page.waitForTimeout(900);
      const o = await overflow();
      // When it overflows, name the elements poking out past main's right edge (outermost un-clipped ones only).
      const culprits = o.main > 1
        ? await page.evaluate(() => {
            const m = document.querySelector("main");
            const right = m.getBoundingClientRect().right;
            const clipped = (el) => { for (let n = el.parentElement; n && n !== m; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if (ox !== "visible") return true; } return false; };
            return [...m.querySelectorAll("*")]
              .filter((el) => el.getBoundingClientRect().right > right + 1 && el.getBoundingClientRect().width > 0 && !clipped(el))
              .slice(0, 8)
              .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}.${String(el.className).slice(0, 90).replace(/ /g, ".")} right+${Math.round(el.getBoundingClientRect().right - right)} "${el.innerText.slice(0, 30).replace(/\s+/g, " ")}"`);
          })
        : [];
      chk(`${name} ${vp.width}px ${scheme}: no horizontal overflow (page + main)`, o.doc <= 1 && o.main <= 1, JSON.stringify(o) + (culprits.length ? ` culprits: ${culprits.join(" | ")}` : ""));
      await h.shot(page, `mc-sweep-${name}-${scheme}`);
    }
  }

  // A reload lands on the same page with the same figures — nothing depends on in-memory state.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1366, height: 768 });
  const before = flat(await stable(page.locator('section[aria-label="Cycle summary"]')));
  await page.reload();
  await page.getByRole("heading", { level: 1, name: "Month Cycle" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(2200);
  chk("hard reload: summary figures unchanged", flat(await stable(page.locator('section[aria-label="Cycle summary"]'))) === before);

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / warnings / page errors while on Month Cycle", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("mc-sweep-figures", "Month Cycle sweep: figures agree wherever the same number appears (tiles, tabs, people, dialog, glance, budget)", async ({ page, logs }, chk, notes) => {
  await openMC(page);

  // ── Obligations tiles vs Due tabs ──
  const tiles = await obligations(page);
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]));
  const tabs = await tabInfo(page);
  const tab = (t) => tabs.find((x) => x.title === t);
  chk("EMI tile == EMI tab total", num(byLabel["EMI (total)"]?.amount) === tab("EMI")?.total, `${byLabel["EMI (total)"]?.amount} vs ${tab("EMI")?.total}`);
  chk("Loans tile == Loans tab total", num(byLabel["Loans (payable)"]?.amount) === tab("Loans")?.total, `${byLabel["Loans (payable)"]?.amount} vs ${tab("Loans")?.total}`);
  chk("Card tile == Card bills tab total", num(byLabel["Credit card bills"]?.amount) === tab("Card bills")?.total, `${byLabel["Credit card bills"]?.amount} vs ${tab("Card bills")?.total}`);
  chk("Bills tile == Bills tab total", num(byLabel["Bills (utility & others)"]?.amount) === tab("Bills")?.total, `${byLabel["Bills (utility & others)"]?.amount} vs ${tab("Bills")?.total}`);
  chk("EMI tile count text matches EMI tab count", new RegExp(`^${tab("EMI")?.count} due this month`).test(byLabel["EMI (total)"]?.meta ?? ""), byLabel["EMI (total)"]?.meta);
  chk("Card tile count text matches Card bills tab count", new RegExp(`^${tab("Card bills")?.count} bills? due`).test(byLabel["Credit card bills"]?.meta ?? ""), byLabel["Credit card bills"]?.meta);

  // ── Each tab: header total == Σ rows, count == rows ──
  const headerPill = flat(await page.locator('section[aria-label="Upcoming this cycle"] > div').first().innerText());
  const hm = /(\d+) items · (.+)$/.exec(headerPill);
  chk("Due header pill = Σ tab counts and Σ tab totals", !!hm && Number(hm[1]) === tabs.reduce((n, t) => n + t.count, 0) && num(hm[2]) === tabs.reduce((s, t) => s + t.total, 0), `${headerPill} vs ${tabs.map((t) => `${t.title}:${t.count}/${t.total}`).join(",")}`);
  let totalRows = 0;
  for (const t of tabs) {
    await page.locator('section[aria-label="Upcoming this cycle"]').getByRole("tab", { name: new RegExp(`^${t.title}`) }).click();
    await page.waitForTimeout(450);
    const rows = await activeRows(page);
    const amounts = rows.map((r) => num(r.find((l) => /^₹[\d,]+$/.test(l)) ?? "0"));
    const sum = amounts.reduce((s, v) => s + v, 0);
    const emptyShown = rows.length === 1 && /No .* due/.test(rows[0].join(" "));
    totalRows += emptyShown ? 0 : rows.length;
    chk(`${t.title} tab: row count == tab count (${t.count})`, emptyShown ? t.count === 0 : rows.length === t.count, `${rows.length} rows`);
    chk(`${t.title} tab: Σ rows ≈ tab total (±₹${Math.max(1, rows.length)} rounding)`, emptyShown ? t.total === 0 : Math.abs(sum - t.total) <= Math.max(1, rows.length), `Σ ${sum} vs ${t.total}`);
    chk(`${t.title} tab: aria-selected follows the click`, (await tabInfo(page)).find((x) => x.title === t.title)?.selected === true);
    chk(`${t.title} tab: no overdue/"NaN" text`, !/NaN|undefined/.test(rows.flat().join(" ")), rows.flat().join(" ").slice(0, 120));
    await h.shot(page, `mc-sweep-tab-${t.title.replace(/\s+/g, "-").toLowerCase()}`);
  }
  chk("Month-at-a-glance 'Pending actions' == Σ due rows", Number(flat(await page.locator('section[aria-label="Month at a glance"]').innerText()).match(/Pending actions (\d+)/)?.[1]) === totalRows, `rows ${totalRows}`);

  // ── People: tiles == ledger tiles == section headers ──
  const give = num(byLabel["You need to give"]?.amount);
  const recv = num(byLabel["You need to receive"]?.amount);
  const ledger = flat(await page.locator('section[aria-label="People ledger"]').innerText());
  const gotRecv = num(ledger.match(/TO RECEIVE\s*(₹[\d,]+)/i)?.[1] ?? "");
  const gotGive = num(ledger.match(/TO GIVE\s*(₹[\d,]+)/i)?.[1] ?? "");
  chk("'You need to receive' tile == ledger 'To receive'", recv === gotRecv, `${recv} vs ${gotRecv}`);
  chk("'You need to give' tile == ledger 'To give'", give === gotGive, `${give} vs ${gotGive}`);
  const sideHdr = async (title) => num((await page.locator(`section[aria-label="People ledger"] p:text-is("${title}")`).first().locator("xpath=following-sibling::p").first().innerText().catch(() => "0")));
  if (give > 0) chk("ledger 'You need to give' header == tile", (await sideHdr("You need to give")) === give);
  if (recv > 0) chk("ledger 'You need to receive' header == tile", (await sideHdr("You need to receive")) === recv);
  const rowsTxt = await page.locator('section[aria-label="People ledger"] .divide-y > div').evaluateAll((rs) => rs.map((r) => r.innerText.split("\n").map((l) => l.trim()).filter(Boolean)));
  chk("people rows each show a name + an amount", rowsTxt.every((r) => r.length >= 2 && r.some((l) => /^₹[\d,]+$/.test(l))), JSON.stringify(rowsTxt).slice(0, 200));
  chk("empty-side placeholders are not shown next to real rows with amounts", !(give > 0 && /Nothing to give right now/.test(ledger)) && !(recv > 0 && /Nothing to receive right now/.test(ledger)));

  // ── Account outflow rows ──
  const acct = await page.locator('section[aria-label="Account spend"] .divide-y > div').evaluateAll((rs) => rs.map((r) => r.innerText.split("\n").map((l) => l.trim()).filter(Boolean)));
  if (acct.length > 0) {
    const pcts = acct.map((r) => Number((r.find((l) => /^[\d.]+%$/.test(l)) ?? "0").replace("%", "")));
    const sumPct = pcts.reduce((s, v) => s + v, 0);
    chk("account outflow percentages add to ~100% (±0.1 per row)", Math.abs(sumPct - 100) <= 0.1 * pcts.length + 0.01, `${pcts.join("+")} = ${sumPct.toFixed(1)}`);
    const amts = acct.map((r) => num(r.find((l) => /^₹[\d,]+$/.test(l)) ?? "0"));
    chk("account outflow rows sorted high → low", amts.every((v, i) => i === 0 || amts[i - 1] >= v), amts.join(","));
    const figure = num(flat(await page.locator('section[aria-label="Account spend"] > div').first().innerText()).match(/TOTAL\s*(₹[\d,]+)/i)?.[1] ?? "");
    notes.push(`Account outflow header ${figure} vs Σ account rows ${amts.reduce((s, v) => s + v, 0)} (header is the Total-outflow view; rows are posted expenses by account)`);
  } else {
    chk("account outflow empty state shown when no rows", /No spending yet this month/.test(flat(await page.locator('section[aria-label="Account spend"]').innerText())));
  }

  // Documented findings (read-only observation; logic is frozen in this testing phase).
  const sumNow = flat(await stable(page.locator('section[aria-label="Cycle summary"]')));
  const netNow = num(sumNow.match(/NET BALANCE\s*(-?₹[\d,]+)/i)?.[1] ?? "");
  const incNow = num(sumNow.match(/INCOME\s*(₹[\d,]+)/i)?.[1] ?? "");
  const savedNow = Number(sumNow.match(/SAVED\s*(-?\d+)%/i)?.[1]);
  chk.finding("MC-F1", "Mine view: 'Saved %' agrees with the 'Net balance' shown beside it", incNow > 0 && savedNow === Math.round((netNow / incNow) * 100), `net ${netNow}, income ${incNow}, saved ${savedNow}% (consistent would be ${Math.round((netNow / incNow) * 100)}%)`);
  if (acct.length > 0) {
    const rowsSum = acct.map((r) => num(r.find((l) => /^₹[\d,]+$/.test(l)) ?? "0")).reduce((s, v) => s + v, 0);
    const hdr = num(flat(await page.locator('section[aria-label="Account spend"] > div').first().innerText()).match(/TOTAL\s*(₹[\d,]+)/i)?.[1] ?? "");
    chk.finding("MC-F2", "Account outflow header total equals the sum of its account rows", Math.abs(rowsSum - hdr) <= acct.length, `header ${hdr} vs rows ${rowsSum}`);
  }

  // ── Hero ⇄ expense-list dialog ──
  const summary = page.locator('section[aria-label="Cycle summary"]');
  const heroMine = num(await stable(summary.getByRole("button").filter({ hasText: /^₹/ }).first()));
  await summary.getByRole("button", { name: "View list" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  await page.waitForTimeout(900);
  const dlgMineTotal = num(await stable(dlg.locator("p.text-\\[30px\\]")));
  chk("Mine view: dialog headline == hero figure", dlgMineTotal === heroMine, `${dlgMineTotal} vs ${heroMine}`);
  const tableRows = async () => dlg.locator("tbody tr").evaluateAll((rs) => rs.map((r) => [...r.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim())));
  const tr = await tableRows();
  const rowAmt = (r) => num((r[3] ?? "").split(" of ")[0]);
  const countText = flat(await dlg.getByText(/transactions? this cycle/).innerText());
  chk("Mine view: 'N transactions' == rows listed", tr.length === Number(countText.match(/^(\d+)/)?.[1]) || (tr.length === 0 && /^0 /.test(countText)), `${countText}; ${tr.length} rows`);
  chk("Mine view: Σ row amounts == headline (±₹1 per row rounding)", Math.abs(tr.reduce((s, r) => s + Math.abs(rowAmt(r)), 0) - dlgMineTotal) <= Math.max(1, tr.length), `Σ ${tr.reduce((s, r) => s + Math.abs(rowAmt(r)), 0)} vs ${dlgMineTotal}`);
  await h.shot(page, "mc-sweep-dialog-mine");
  await dlg.getByRole("radio", { name: "Combined" }).click();
  await page.waitForTimeout(900);
  const dlgCombTotal = num(await stable(dlg.locator("p.text-\\[30px\\]")));
  const lines = await dlg.locator('section[aria-label="Total outflow breakdown"] dl > div').evaluateAll((ds) => ds.map((d) => [...d.children].map((c) => c.innerText.trim())));
  const parts = lines.filter((l) => l[0] !== "Total outflow");
  const brTotal = num(lines.find((l) => l[0] === "Total outflow")?.[1] ?? "0");
  chk("Combined view: breakdown lines add back to Total outflow (±₹1 per line)", Math.abs(parts.reduce((s, l) => s + num(l[1]), 0) - brTotal) <= Math.max(1, parts.length), JSON.stringify(lines));
  chk("Combined view: breakdown total == dialog headline", brTotal === dlgCombTotal, `${brTotal} vs ${dlgCombTotal}`);
  await dlg.getByRole("button", { name: "Close" }).click();
  await dlg.waitFor({ state: "hidden" });
  const heroCombined = num(await stable(summary.getByRole("button").filter({ hasText: /^₹/ }).first()));
  chk("view toggle in the dialog also switched the hero to Combined (one shared state)", heroCombined === dlgCombTotal, `${heroCombined} vs ${dlgCombTotal}`);

  // ── Summary tiles ──
  const sumTxt = flat(await stable(summary));
  const income = num(sumTxt.match(/INCOME\s*(₹[\d,]+)/i)?.[1] ?? "");
  const netTxt = sumTxt.match(/NET BALANCE\s*(-?₹[\d,]+)/i)?.[1] ?? "";
  chk("Net balance == Income − shown spend", num(netTxt) === income - heroCombined, `${netTxt} vs ${income} − ${heroCombined}`);
  const savedPct = Number(sumTxt.match(/SAVED\s*(-?\d+)%/i)?.[1]);
  chk("Saved % == round(net / income)", income > 0 ? savedPct === Math.round(((income - heroCombined) / income) * 100) : savedPct === 0, `${savedPct}% (income ${income}, spend ${heroCombined})`);
  chk("Saved tile quotes the same income", num(sumTxt.match(/of (₹[\d,]+) income/)?.[1] ?? "") === income);
  notes.push(`budget tile: ${sumTxt.match(/BUDGET.*?(?=SAVED)/i)?.[0] ?? ""}`);

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors while reading the page", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("mc-sweep-links", "Month Cycle sweep: every link on the page opens the page its label promises", async ({ page, logs }, chk) => {
  await openMC(page);
  const collect = async () => page.evaluate(() =>
    [...document.querySelectorAll("main a[href]")]
      .filter((a) => !a.closest("[inert]"))
      .map((a) => ({ href: a.getAttribute("href"), text: ((a.innerText || a.getAttribute("aria-label") || "").trim().split("\n")[0] || "").trim().replace(/\s+/g, " ") })),
  );
  const all = [];
  for (const t of ["EMI", "Loans", "Card bills", "Bills"]) {
    await page.locator('section[aria-label="Upcoming this cycle"]').getByRole("tab", { name: new RegExp(`^${t}`) }).click();
    await page.waitForTimeout(400);
    all.push(...(await collect()));
  }
  const seen = new Set();
  const links = all.filter((l) => l.href && l.href.startsWith("/") && !seen.has(`${l.text}|${l.href}`) && seen.add(`${l.text}|${l.href}`));
  chk("page has links to test", links.length >= 12, `${links.length}: ${links.map((l) => `${l.text}→${l.href}`).join("; ")}`);
  chk("no link is empty / '#'", all.every((l) => l.href && l.href !== "#" && l.text.length > 0), all.filter((l) => !l.href || l.href === "#" || !l.text).map((l) => JSON.stringify(l)).join(","));

  for (const l of links) {
    await openMC(page);
    // The Due-panel links depend on the active tab — click the tab whose footer link this is.
    const tabFor = { "/emi": "EMI", "/loans": "Loans", "/credit-cards": "Card bills", "/bills": "Bills" }[strip(l.href)];
    if (/^(Add (EMI|loan|card bill|bill)|Open )/.test(l.text) && tabFor) await page.locator('section[aria-label="Upcoming this cycle"]').getByRole("tab", { name: new RegExp(`^${tabFor}`) }).click();
    const loc = page.locator(`main a[href="${l.href}"]`).filter({ hasText: l.text.slice(0, 30) }).filter({ visible: true }).first();
    if ((await loc.count()) === 0) { chk(`link "${l.text}" → ${l.href} (locatable)`, false, "not found"); continue; }
    await loc.scrollIntoViewIfNeeded();
    await loc.click();
    const want = strip(l.href.split("?")[0]);
    const ok = await page.waitForFunction((w) => (location.pathname.replace(/\/+$/, "") || "/") === w, want, { timeout: 20000 }).then(() => true, () => false);
    await page.waitForTimeout(1500);
    const body = (await page.locator("body").innerText()).slice(0, 4000);
    const broken = /This page could not be found|Something went wrong|Application error/i.test(body) || /^404\b/.test(body.trim());
    chk(`link "${l.text}" → ${l.href} opens its page`, ok && !broken, ok ? (broken ? "error/404 content" : "") : `landed on ${await page.evaluate(() => location.pathname)}`);
  }
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors during the link sweep", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("mc-sweep-controls", "Month Cycle sweep: cycle navigation, picker, toggles, tabs, section nav, tooltip, compact bar and dialog all respond", async ({ page, logs }, chk) => {
  await openMC(page);
  const summary = page.locator('section[aria-label="Cycle summary"]');
  const hdr = page.locator("main header");
  const label = async () => flat(await headerPicker(page).innerText());
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const now = new Date();
  const expectName = (y, m) => `${MONTHS[((m % 12) + 12) % 12]} ${y + Math.floor(m / 12)}`;

  // ── Current cycle ──
  const base = { label: await label(), summary: flat(await stable(summary)) };
  chk(`current cycle is named after this month (${expectName(now.getFullYear(), now.getMonth())})`, base.label.startsWith(`${expectName(now.getFullYear(), now.getMonth())} cycle`), base.label);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const wantDays = Math.ceil((endOfMonth.getTime() - now.getTime()) / 86_400_000);
  chk(`status chip says "${wantDays} days left"`, new RegExp(`${wantDays} days? left`).test(flat(await hdr.innerText())), flat(await hdr.innerText()).slice(0, 200));
  chk("current cycle: no 'Back to current' button", (await hdr.getByRole("button", { name: "Back to current" }).count()) === 0);

  // ── Previous / Next ──
  await hdr.getByRole("button", { name: "Previous cycle" }).click();
  await page.waitForTimeout(900);
  chk("Previous cycle → previous month", (await label()).startsWith(`${expectName(now.getFullYear(), now.getMonth() - 1)} cycle`), await label());
  chk("past cycle: chip says 'Cycle ended' and 'Back to current' appears", /Cycle ended/.test(flat(await hdr.innerText())) && (await hdr.getByRole("button", { name: "Back to current" }).count()) === 1);
  chk("past cycle: figures changed vs current", flat(await stable(summary)) !== base.summary);
  chk("past cycle: no NaN / undefined anywhere", !/NaN|undefined|Infinity/.test(flat(await page.locator("main").innerText())));
  await h.shot(page, "mc-sweep-controls-past");
  await hdr.getByRole("button", { name: "Next cycle" }).click();
  await hdr.getByRole("button", { name: "Next cycle" }).click();
  await page.waitForTimeout(900);
  chk("Next ×2 from previous → next month", (await label()).startsWith(`${expectName(now.getFullYear(), now.getMonth() + 1)} cycle`), await label());
  chk("future cycle: chip says 'Upcoming cycle'", /Upcoming cycle/.test(flat(await hdr.innerText())));
  chk("future cycle: no NaN / undefined anywhere", !/NaN|undefined|Infinity/.test(flat(await page.locator("main").innerText())));
  await h.shot(page, "mc-sweep-controls-future");
  await hdr.getByRole("button", { name: "Back to current" }).click();
  await page.waitForTimeout(900);
  chk("Back to current restores the label and the exact figures (no drift)", (await label()) === base.label && flat(await stable(summary)) === base.summary);

  // Twelve steps back / forward land on the same month a year away — no cycle skipped or repeated.
  for (let i = 0; i < 12; i++) await hdr.getByRole("button", { name: "Previous cycle" }).click();
  await page.waitForTimeout(600);
  chk("12 × Previous = same month, previous year", (await label()).startsWith(`${expectName(now.getFullYear() - 1, now.getMonth())} cycle`), await label());
  for (let i = 0; i < 24; i++) await hdr.getByRole("button", { name: "Next cycle" }).click();
  await page.waitForTimeout(600);
  chk("24 × Next = same month, next year", (await label()).startsWith(`${expectName(now.getFullYear() + 1, now.getMonth())} cycle`), await label());
  await hdr.getByRole("button", { name: "Back to current" }).click();
  await page.waitForTimeout(600);

  // ── Picker ──
  await headerPicker(page).click();
  await page.getByRole("button", { name: "Current cycle" }).waitFor();
  chk("picker opens on the shown year with the month pressed", (await page.getByRole("button", { name: MONTHS[now.getMonth()].slice(0, 3), exact: true }).getAttribute("aria-pressed")) === "true");
  await page.getByRole("button", { name: "Next year" }).click();
  await page.getByRole("button", { name: "Feb", exact: true }).click();
  await page.waitForTimeout(900);
  chk("picker: next year + Feb jumps to February of that year", (await label()).startsWith(`February ${now.getFullYear() + 1} cycle`), await label());
  chk("picker closes after a pick", (await page.getByRole("button", { name: "Current cycle" }).count()) === 0);
  await headerPicker(page).click();
  await page.getByRole("button", { name: "Previous year" }).click();
  await page.getByRole("button", { name: "Previous year" }).click();
  await page.getByRole("button", { name: "Dec", exact: true }).click();
  await page.waitForTimeout(900);
  // The picker opens on the shown cycle's year (next year's Feb here), so two years back is this year − 1.
  chk("picker: two years back + Dec", (await label()).startsWith(`December ${now.getFullYear() - 1} cycle`), await label());
  await headerPicker(page).click();
  await page.getByRole("button", { name: "Current cycle" }).click();
  await page.waitForTimeout(900);
  chk("picker 'Current cycle' returns to now with identical figures", (await label()) === base.label && flat(await stable(summary)) === base.summary);
  await headerPicker(page).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Current cycle" }).waitFor({ state: "hidden" }).catch(() => {});
  chk("Escape closes the picker without changing the cycle", (await page.getByRole("button", { name: "Current cycle" }).count()) === 0 && (await label()) === base.label);

  // ── Info tooltip ──
  await hdr.getByRole("button", { name: "About this cycle" }).hover();
  const tip = page.getByRole("tooltip");
  await tip.waitFor({ timeout: 5000 }).catch(() => {});
  chk("info tooltip explains the cycle (calendar month)", /calendar month/.test(await tip.first().innerText().catch(() => "")), await tip.first().innerText().catch(() => "no tooltip"));
  await page.mouse.move(5, 5);

  // ── Expense toggle (hero) ──
  const heroBtn = summary.getByRole("button").filter({ hasText: /^₹/ }).first();
  const kicker = async () => flat(await summary.locator("span.uppercase").first().innerText());
  chk("default view is 'My spend'", /My spend/i.test(await kicker()), await kicker());
  const mine = num(await stable(heroBtn));
  await summary.getByRole("radio", { name: "Combined" }).click();
  await page.waitForTimeout(900);
  chk("Combined → label 'Total outflow', radio checked", /Total outflow/i.test(await kicker()) && (await summary.getByRole("radio", { name: "Combined" }).getAttribute("aria-checked")) === "true");
  const combined = num(await stable(heroBtn));
  chk("Combined ≥ Mine (full amounts include other people's shares)", combined >= mine, `${combined} vs ${mine}`);
  await summary.getByRole("radio", { name: "Mine only" }).click();
  await page.waitForTimeout(900);
  chk("Mine only restores 'My spend' and its figure", /My spend/i.test(await kicker()) && num(await stable(heroBtn)) === mine);

  // ── Expense dialog: both openers, Escape, close button ──
  for (const [how, open] of [["hero amount", () => heroBtn.click()], ["View list", () => summary.getByRole("button", { name: "View list" }).click()]]) {
    await open();
    await page.getByRole("dialog").waitFor();
    chk(`dialog opens from ${how}`, (await page.getByRole("dialog").count()) === 1);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    chk(`dialog closes with Escape (${how})`, (await page.getByRole("dialog").count()) === 0);
  }
  await heroBtn.click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" }).catch(() => {});
  chk("dialog closes with the X button", (await page.getByRole("dialog").count()) === 0);

  // ── Due tabs ──
  const dueTabs = page.locator('section[aria-label="Upcoming this cycle"]').getByRole("tab");
  for (let i = 0; i < (await dueTabs.count()); i++) {
    await dueTabs.nth(i).click();
    await page.waitForTimeout(300);
    chk(`Due tab #${i + 1} is exclusively selected`, (await page.locator('section[aria-label="Upcoming this cycle"] [role="tab"][aria-selected="true"]').count()) === 1 && (await dueTabs.nth(i).getAttribute("aria-selected")) === "true");
  }

  // ── Section nav pills scroll to their section and mark themselves current ──
  const nav = page.getByRole("navigation", { name: "Month cycle sections" });
  for (const [name, id] of [["Budget", "mc-budget"], ["At a glance", "mc-glance"], ["People & accounts", "mc-people"], ["Due", "mc-due"], ["Obligations", "mc-obligations"], ["Overview", "mc-overview"]]) {
    await nav.getByRole("button", { name }).click();
    await page.waitForTimeout(1300);
    const top = await page.locator(`#${id}`).evaluate((el) => Math.round(el.getBoundingClientRect().top - document.querySelector("main").getBoundingClientRect().top));
    const mainH = await page.evaluate(() => document.querySelector("main").clientHeight);
    chk(`nav "${name}" brings #${id} into view`, top >= -4 && top < mainH - 60, `top ${top}px of ${mainH}`);
  }

  // ── Compact bar: same handlers ──
  await scrollMain(page, 800);
  await page.waitForTimeout(700);
  const bar = page.getByRole("region", { name: "Month Cycle quick bar" });
  await bar.waitFor({ state: "visible" });
  await bar.getByRole("button", { name: "Previous cycle" }).click();
  await page.waitForTimeout(800);
  chk("bar Previous cycle works", (await bar.getByRole("button", { name: "Back to current" }).count()) === 1);
  await bar.getByRole("button", { name: "Next cycle" }).click();
  await page.waitForTimeout(800);
  chk("bar Next cycle returns to current (Back-to-current gone)", (await bar.getByRole("button", { name: "Back to current" }).count()) === 0);
  await bar.getByRole("button", { name: "Cycle details" }).click();
  chk("bar 'Cycle details' menu explains the cycle", /About this cycle/.test(await page.getByRole("menu").innerText().catch(() => "")));
  await page.keyboard.press("Escape");
  await bar.getByRole("button", { name: "Choose cycle" }).click();
  await page.getByRole("button", { name: "Next year" }).click();
  await page.getByRole("button", { name: "Mar", exact: true }).click();
  await page.waitForTimeout(800);
  await scrollMain(page, 0);
  await page.waitForTimeout(600);
  chk("header + bar agree on the cycle after bar navigation", (await label()).startsWith(`March ${now.getFullYear() + 1} cycle`), await label());
  await hdr.getByRole("button", { name: "Back to current" }).click();
  await page.waitForTimeout(800);

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors during the control sweep", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("mc-sweep-custom-cycle", "Month Cycle sweep: a custom cycle start day (17th) re-windows the page and reverts cleanly, writing no financial data", async ({ page, logs }, chk) => {
  const snapshot = async () => JSON.stringify([await h.list("transactions"), await h.list("loans"), await h.list("emis"), await h.list("accounts")]);
  const before = await snapshot();
  await h.go(page, "/settings");
  await page.getByRole("tab", { name: "Profile" }).waitFor({ timeout: 30000 });
  await page.getByRole("combobox", { name: /Cycle starts on/ }).click();
  await page.getByRole("option", { name: "17th", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Month cycle saved").first().waitFor({ timeout: 15000 });

  await openMC(page);
  const now = new Date();
  const dd = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const cs = new Date(now.getFullYear(), now.getMonth() - (now.getDate() < 17 ? 1 : 0), 17);
  const ce = new Date(cs.getFullYear(), cs.getMonth() + 1, 16);
  const want = `${dd(cs)} – ${dd(ce)}`;
  const pickerText = flat(await headerPicker(page).innerText());
  chk(`custom cycle shows its range as the label (${want})`, pickerText.includes(want), pickerText);
  await page.locator("main header").getByRole("button", { name: "About this cycle" }).hover();
  const tip = await page.getByRole("tooltip").first().innerText().catch(() => "");
  chk("tooltip says 17th → 16th", /17th of each month through the 16th of the next/.test(tip), tip);
  chk("footer note names the 17th → 16th cycle", /17th → 16th monthly cycle/.test(flat(await page.locator("main").innerText())));
  await page.mouse.move(5, 5);
  const summary = page.locator('section[aria-label="Cycle summary"]');
  const custom = flat(await stable(summary));
  await h.shot(page, "mc-sweep-custom-17");

  await page.locator("main header").getByRole("button", { name: "Previous cycle" }).click();
  await page.waitForTimeout(900);
  const ps = new Date(cs.getFullYear(), cs.getMonth() - 1, 17);
  const pe = new Date(cs.getFullYear(), cs.getMonth(), 16);
  chk(`Previous cycle is ${dd(ps)} – ${dd(pe)} (contiguous, no gap)`, flat(await headerPicker(page).innerText()).includes(`${dd(ps)} – ${dd(pe)}`), flat(await headerPicker(page).innerText()));
  await page.locator("main header").getByRole("button", { name: "Next cycle" }).click();
  await page.locator("main header").getByRole("button", { name: "Next cycle" }).click();
  await page.waitForTimeout(900);
  const ns = new Date(ce.getFullYear(), ce.getMonth(), 17);
  const ne = new Date(ns.getFullYear(), ns.getMonth() + 1, 16);
  chk(`Next cycle after current is ${dd(ns)} – ${dd(ne)}`, flat(await headerPicker(page).innerText()).includes(`${dd(ns)} – ${dd(ne)}`), flat(await headerPicker(page).innerText()));
  await page.locator("main header").getByRole("button", { name: "Back to current" }).click();
  await page.waitForTimeout(900);
  chk("custom cycle: Back to current restores the exact figures", flat(await stable(summary)) === custom);
  chk("custom cycle: no NaN / undefined anywhere", !/NaN|undefined|Infinity/.test(flat(await page.locator("main").innerText())));
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("custom cycle: no horizontal overflow", o <= 1, o);

  // Back to day 1.
  await h.go(page, "/settings");
  await page.getByRole("combobox", { name: /Cycle starts on/ }).click();
  await page.getByRole("option", { name: "1st (calendar month)", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Month cycle saved").first().waitFor({ timeout: 15000 });
  await openMC(page);
  chk("day 1 restores the calendar-month name", /\w+ \d{4} cycle/.test(flat(await headerPicker(page).innerText())), flat(await headerPicker(page).innerText()));
  chk("changing the cycle wrote no transactions / loans / EMIs / accounts", (await snapshot()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});


scenario("mc-sweep-bar-widths", "Month Cycle sweep: the compact quick-bar keeps every control inside the bar at tablet / laptop widths (current and browsed cycle)", async ({ page }, chk) => {
  await openMC(page);
  const measure = () => page.evaluate(() => {
    const bar = document.querySelector("[data-compact-bar]");
    const br = bar.getBoundingClientRect();
    const main = document.querySelector("main");
    const out = [];
    for (const el of bar.querySelectorAll("button, a, span")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (r.right > br.right - 1 || r.left < br.left) out.push(`${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") || el.textContent.trim().slice(0, 14)}] right+${Math.round(r.right - br.right)}`);
    }
    return { out, bar: Math.round(br.width), mainOverflow: main.scrollWidth - main.clientWidth, shown: bar.dataset.state };
  });
  for (const w of [640, 700, 768, 820, 900, 1024, 1180, 1280, 1366]) {
    await page.setViewportSize({ width: w, height: 900 });
    await scrollMain(page, 0);
    await page.waitForTimeout(500);
    await scrollMain(page, 800);
    await page.waitForTimeout(700);
    const bar = page.getByRole("region", { name: "Month Cycle quick bar" });
    for (const state of ["current cycle", "browsing another cycle"]) {
      if (state !== "current cycle") {
        await bar.getByRole("button", { name: "Previous cycle" }).click();
        await page.waitForTimeout(700);
      }
      const m = await measure();
      chk(`${w}px, ${state}: bar is shown`, m.shown === "shown", m.shown);
      chk(`${w}px, ${state}: every bar control sits inside the bar (bar ${m.bar}px wide)`, m.out.length === 0, m.out.slice(0, 4).join(" | "));
      chk(`${w}px, ${state}: main has no horizontal overflow`, m.mainOverflow <= 1, m.mainOverflow);
      if (m.out.length > 0 || m.mainOverflow > 1) await h.shot(page, `mc-sweep-bar-${w}-${state.startsWith("cur") ? "current" : "browsing"}`);
      if (state !== "current cycle") {
        await bar.getByRole("button", { name: "Back to current" }).click();
        await page.waitForTimeout(500);
      }
    }
  }
  // The status the chip used to carry at 768–1023px must still be reachable (Cycle details menu).
  await page.setViewportSize({ width: 820, height: 900 });
  await page.waitForTimeout(500);
  const bar = page.getByRole("region", { name: "Month Cycle quick bar" });
  const linkCount = await bar.getByRole("link", { name: "New transaction" }).count();
  await bar.getByRole("button", { name: "Cycle details" }).click();
  const menu = await page.getByRole("menu").innerText();
  chk("820px: 'Cycle details' menu still shows the cycle status (days left) the chip no longer shows", /\d+ days? left/.test(menu), menu.replace(/\s+/g, " ").slice(0, 120));
  chk("820px: the icon-only 'New transaction' link is still reachable by name", linkCount === 1, linkCount);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(600);
  await h.shot(page, "mc-sweep-bar-768");
});

scenario("mc-sweep-clipped-text", "Month Cycle sweep: records where tiles / tabs clip their labels or amounts (documented finding, never fails)", async ({ page }, chk) => {
  await openMC(page);
  for (const w of [390, 640, 768, 820, 900, 1024, 1180, 1280, 1366, 1920]) {
    await page.setViewportSize({ width: w, height: 1000 });
    await scrollMain(page, 0);
    await page.waitForTimeout(700);
    const clipped = await page.evaluate(() => {
      const out = [];
      const scopes = ['section[aria-label="Obligations"]', 'section[aria-label="Upcoming this cycle"] [role="tablist"]', 'section[aria-label="Cycle summary"]'];
      for (const sel of scopes) {
        for (const el of document.querySelectorAll(`${sel} *`)) {
          if (getComputedStyle(el).overflow !== "hidden" && getComputedStyle(el).textOverflow !== "ellipsis") continue;
          if (el.scrollWidth > el.clientWidth + 1 && el.textContent.trim().length > 0 && el.children.length === 0) out.push(`${sel.includes("Obligations") ? "tile" : sel.includes("tablist") ? "tab" : "summary"}: "${el.textContent.trim().slice(0, 26)}"`);
        }
      }
      return out;
    });
    // Design-level (the tiles `truncate` by design and have no tooltip), so a documented finding, not a failure.
    chk.finding("MC-F3", `${w}px: no clipped labels/amounts in obligations, Due tabs or summary`, clipped.length === 0, `${clipped.length} clipped: ${clipped.slice(0, 8).join(" | ")}`);
  }
});
