/**
 * Loan & EMI page evidence shots (loan-emi-ui-shots.mjs) — desktop/mobile × light/dark, synthetic emulator data only.
 * Screenshots only: `LUI_TAG=before|after npm run test:e2e-qa -- lui- --copy`.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const TAG = process.env.LUI_TAG ?? "after";
const VPS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    const id = `lui-${vpName}-${scheme}`;
    scenario(id, `Loan & EMI page shots: ${vpName}, ${scheme}`, async ({ page }, chk) => {
      if (process.env.LUI_TAG !== "before") { await h.addFixture(page, "card-emi"); await h.addFixture(page, "shared-emi"); }
      await page.goto(new URL("/loans", page.url()).toString(), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(8000);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
      await page.screenshot({ path: `${h.SHOTS_DIR}/loan-emi-${TAG}-${vpName}-${scheme}.png`, fullPage: true });
    }, { viewport: vp, scheme });
  }
}
