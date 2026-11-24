/**
 * Scenario-based Net Worth verification (emulator + real browser). Expected figures are written in the scenario
 * BEFORE it runs (independent oracle: the user's inputs), then compared with what the Dashboard hero DISPLAYS and
 * with what People Ledger / the account store hold.
 *   npm run test:e2e-qa -- nw- --copy
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const rupees = (s) => Number(String(s).replace(/[₹,\s−-]/g, ""));

/** What the Net Worth card shows: headline chart label + each bar's label/value. */
async function hero(page) {
  await h.go(page, "/dashboard");
  await page.waitForFunction(() => document.querySelector('main section[aria-label="Net worth"] [role="img"]'), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const sec = document.querySelector('main section[aria-label="Net worth"]');
    const img = sec.querySelector('[role="img"]');
    const label = img.getAttribute("aria-label") ?? "";
    const text = sec.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    return { label, text };
  });
}
const parse = (hr) => {
  const m = hr.label.match(/own ₹([\d,.]+), owe ₹([\d,.]+), net worth (−?)₹([\d,.]+)/) ?? [];
  const after = (name) => {
    const i = hr.text.findIndex((t) => t === name);
    return i >= 0 ? rupees(hr.text[i - 1] ?? "") : NaN; // value is rendered above its label
  };
  return { assets: rupees(m[1]), debt: rupees(m[2]), nw: (m[3] ? -1 : 1) * rupees(m[4]), fromOthers: after("From others"), mine: after("Mine"), raw: hr.text.join(" | ") };
};

scenario("nw-probe", "Probe: print the Net Worth card text", async ({ page }, chk, notes) => {
  const hr = await hero(page);
  notes.push(hr.label, hr.text.join(" | "));
  chk("probe", true, JSON.stringify(parse(hr)));
});
