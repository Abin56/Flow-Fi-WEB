/**
 * Browser QA scenarios (loan-emi-cards.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Loan & EMI overview cards: column count per width, no horizontal overflow, consistent natural heights,
 * and the card anatomy (header, Outstanding / Next EMI, installment progress, People row). Read-only — no writes.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const VPS = {
  desktop: { vp: { width: 1920, height: 1080 }, cols: 3 },
  tablet: { vp: { width: 1024, height: 768 }, cols: 2 },
  mobile: { vp: { width: 390, height: 844 }, cols: 1 },
};

for (const [name, { vp, cols }] of Object.entries(VPS)) {
  const id = `lecards-${name}`;
  scenario(
    id,
    `Loan & EMI cards: ${name} ${vp.width}x${vp.height}`,
    async ({ page }, chk) => {
      await h.addFixture(page, "shared-emi");
      // Client-side push like `h.go`, but wait for the list itself — this route's "load" event never re-fires.
      await page.evaluate(() => window.next.router.push("/loans"));
      const section = page.locator('section[aria-label="Loans and EMIs"]');
      await section.locator("h3").first().waitFor({ timeout: 30000 });
      // Freshly seeded fixtures refresh the installment queries after first paint — wait for settled figures.
      // If the installment listener stalled after seeding (seen intermittently here), a reload gives fresh listeners.
      const settled = await section.getByText("Next EMI").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      if (!settled) {
        await page.reload();
        await section.getByText("Next EMI").first().waitFor({ timeout: 60000 });
      }
      chk("installment data settled (reload needed: " + !settled + ")", true);
      await page.waitForTimeout(1500);
      // Long-name probe — DOM text only, nothing is written: the name must truncate, not push the status/chevron out.
      await section.locator("h3").last().evaluate((el) => { el.textContent = "Extremely long loan name for a renovation and furniture purchase financed over many years"; });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
      const cards = await section.locator('[role="button"]').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const inner = [...el.querySelectorAll("*")].some((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflowX === "visible" && c.getBoundingClientRect().right > r.right + 1);
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), spill: inner, text: el.textContent };
        }),
      );
      const xs = [...new Set(cards.map((c) => c.x))];
      chk(`${cols} column(s)`, xs.length === Math.min(cols, cards.length), `${xs.length} columns, ${cards.length} cards, widths ${[...new Set(cards.map((c) => c.w))].join("/")}`);
      // Natural heights (no stretched gaps). Without a People row, cards in a row differ by at most one text line
      // (a narrow card stacks "2 days overdue" under the date).
      const rows = Object.values(Object.groupBy(cards.filter((c) => !/Split between|Repays|Your share|Share|For/.test(c.text)), (c) => c.y));
      chk("cards without a People row: heights within one text line per row", rows.every((r) => Math.max(...r.map((c) => c.h)) - Math.min(...r.map((c) => c.h)) <= 20), rows.map((r) => r.map((c) => c.h).join(",")).join(" | "));
      chk("no content spills outside a card", cards.every((c) => !c.spill), cards.filter((c) => c.spill).length);
      chk("every card leads with Outstanding / Still to receive", cards.every((c) => /Outstanding|Still to receive/.test(c.text)));
      chk("installment progress is labelled as installments", cards.filter((c) => /of \d+ ·/.test(c.text)).every((c) => c.text.includes("Installments paid")));
      chk("a multi-person record shows 'Split between'", cards.some((c) => c.text.includes("Split between")), cards.length);
      const focus = section.locator('[role="button"]').first();
      await focus.focus();
      chk("focused card shows a focus indicator", await focus.evaluate((el) => getComputedStyle(el).boxShadow !== "none" || getComputedStyle(el).outlineStyle !== "none"));
      await h.shot(page, `${id}-list`);
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").first().waitFor({ timeout: 15000 });
      chk("Enter on a card opens its details", true);
      await h.shot(page, `${id}-opened`);
    },
    { viewport: vp },
  );
}
