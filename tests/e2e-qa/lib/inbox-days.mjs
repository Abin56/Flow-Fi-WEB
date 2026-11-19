/**
 * Helpers for browser scenarios that drive the Transaction Inbox, which is browsed ONE DAY AT A TIME (month control + day dock; Grid and
 * List alike). Rows of other days are not on the page, so a scenario either seeds its candidates on one day (`sameDayIso`) or walks the
 * days with these helpers. Local emulator only; nothing here writes anything.
 */

/**
 * A timestamp on YESTERDAY at noon, `minutesOlder` minutes earlier (0 = newest). Every candidate seeded this way lands on the same local
 * calendar day whatever the clock says (no midnight flake), and a larger `minutesOlder` sorts lower under "Newest first" — so the old
 * "daysAgo: 1, 2, 3" ordering is kept without spreading the rows over several days.
 */
export function sameDayIso(minutesOlder = 0) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return new Date(d.getTime() - minutesOlder * 60_000).toISOString();
}

const isDisabled = async (locator) => (await locator.getAttribute("aria-disabled")) === "true";

/** The number of candidates the current filters list across ALL days ("N in your inbox" / "Showing N of M"). 0 when nothing is listed. */
export async function shownTotal(page) {
  const el = page.getByTestId("candidates-shown");
  if ((await el.count()) === 0) return 0;
  const text = (await el.innerText()).replace(/\s+/g, " ");
  const m = text.match(/Showing\s*(\d+)\s*of/) ?? text.match(/^\s*(\d+)\s*in your inbox/);
  return m ? Number(m[1]) : 0;
}

/** Walks to the newest day (Next day until it is disabled). */
export async function goToNewestDay(page) {
  const next = page.getByTestId("candidate-day-next");
  for (let i = 0; i < 400 && (await next.count()) > 0 && !(await isDisabled(next)); i++) {
    await next.click();
    await page.waitForTimeout(60);
  }
}

/**
 * Makes sure the row (or card) of `candidateId` is on screen by opening its day: starts at the newest day and steps back day by day
 * until the row appears. Returns true when found.
 */
export async function showCandidate(page, candidateId) {
  const row = page.locator(`[data-testid="candidate-row"][data-candidate-id="${candidateId}"]`);
  if ((await row.count()) > 0) return true;
  await goToNewestDay(page);
  const prev = page.getByTestId("candidate-day-prev");
  for (let i = 0; i < 400; i++) {
    if ((await row.count()) > 0) return true;
    if ((await prev.count()) === 0 || (await isDisabled(prev))) return (await row.count()) > 0;
    await prev.click();
    await page.waitForTimeout(80);
  }
  return false;
}

/**
 * Ticks "Select all eligible on this day" on EVERY day, newest to oldest — what a single whole-list select-all used to do. Each day's
 * select-all follows the same bulk rules (one account, one direction), so a day with nothing eligible is simply skipped.
 */
export async function selectAllDays(page) {
  await goToNewestDay(page);
  const box = page.getByRole("checkbox", { name: /Select all visible candidates on this day/ });
  const prev = page.getByTestId("candidate-day-prev");
  for (let i = 0; i < 400; i++) {
    if (!(await box.isDisabled())) {
      const checked = (await box.getAttribute("aria-checked")) === "true";
      if (!checked) await box.click();
    }
    if ((await prev.count()) === 0 || (await isDisabled(prev))) break;
    await prev.click();
    await page.waitForTimeout(80);
  }
}
