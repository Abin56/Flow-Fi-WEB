/**
 * /pair landing (what the phone's camera opens after scanning the pairing QR) — layout + honesty sweep at phone and
 * desktop widths, light + dark. The page is public and reads nothing from Firestore; the dev server doesn't serve
 * out/downloads, so the release manifest (and the APK) are stubbed here with the same shape the release script writes.
 * Screenshots: tests/e2e-qa/.results/shots/pairl-*.png.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL } from "../lib/env.mjs";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 16; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
const MANIFEST = { version: "1.0.0", versionCode: 1, sha256: "0".repeat(63) + "1", sizeBytes: 140964073, file: "flowfi-android-1.0.0.apk", publishedAt: "2026-10-25T11:56:03Z" };
// Anything that would read as a live connection/installation/sync status — the page can know none of these.
const FAKE_STATUS = /\b(is online|is connected|connected now|connecting|syncing now|currently syncing|is installed|installed successfully|paired successfully|pairing complete)\b/i;
const VPS = { m360: { width: 360, height: 740 }, m390: { width: 390, height: 844 }, m430: { width: 430, height: 932 }, l1366: { width: 1366, height: 768 } };

async function openPair(page, query, { published = true } = {}) {
  await page.addInitScript((ua) => Object.defineProperty(navigator, "userAgent", { get: () => ua }), ANDROID_UA);
  await page.route("**/downloads/flowfi-android.json", (route) =>
    published ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MANIFEST) }) : route.fulfill({ status: 404, contentType: "text/html", body: "404" }),
  );
  await page.route("**/downloads/*.apk", (route) => route.fulfill({ status: 200, contentType: "application/vnd.android.package-archive", body: "stub" }));
  // With a mobile user agent, Firebase Auth (initialised app-wide by AppProviders, not by this page) proactively loads
  // Google's gapi script for its popup/redirect resolver (`_shouldInitProactively`). Answered locally so nothing leaves.
  await page.route("https://apis.google.com/js/api.js*", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(`${BASE_URL}/pair/?${query}`, { waitUntil: "domcontentloaded" });
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const settle = (page) => page.waitForTimeout(700); // entrance stagger is < 0.8s

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    scenario(
      `pairl-ready-${vpName}-${scheme}`,
      `/pair with a published build: ${vp.width}px, ${scheme}`,
      async ({ page }, chk) => {
        await openPair(page, `t=${TOKEN}`);
        const download = page.getByTestId("pair-download-apk");
        await download.waitFor({ timeout: 60000 });
        await settle(page);

        chk("heading is 'Connect your phone'", (await page.getByRole("heading", { level: 1 }).innerText()) === "Connect your phone");
        chk("page follows the colour scheme", (await page.evaluate(() => document.documentElement.classList.contains("dark"))) === (scheme === "dark"));
        const open = page.getByTestId("pair-open-app");
        const openHref = await open.getAttribute("href");
        chk("Open FlowFi hands the same token to com.flowfi.app", openHref?.startsWith(`intent://app/pair?t=${TOKEN}#Intent;scheme=flowfi;package=com.flowfi.app;`), openHref?.slice(0, 60));
        chk("Download points at the published APK on this site", (await download.getAttribute("href")) === `${BASE_URL}/downloads/flowfi-android-1.0.0.apk`);
        chk("Download is the primary (lime) action", /\bbg-primary\b/.test((await download.getAttribute("class")) ?? ""));

        const d = await download.boundingBox();
        const o = await open.boundingBox();
        chk("both actions are ≥48px touch targets", d && o && d.height >= 48 && o.height >= 48, `${Math.round(d?.height ?? 0)}/${Math.round(o?.height ?? 0)}px`);
        if (vp.width < 600) chk("both actions sit above the fold", o && o.y + o.height <= vp.height, `${Math.round((o?.y ?? 0) + (o?.height ?? 0))}px of ${vp.height}`);
        chk("version and size shown compactly", /v1\.0\.0/.test(await page.locator("main").innerText()) && /134 MB/.test(await page.locator("main").innerText()));
        chk("install help starts collapsed", (await page.getByTestId("pair-install-help-toggle").getAttribute("aria-expanded")) === "false");
        chk("the Download step is marked current", /Download/.test(await page.locator('[data-testid="pair-steps"] [aria-current="step"]').innerText()));
        chk("nothing claims a live connection/installation", !FAKE_STATUS.test(await page.locator("main").innerText()));
        chk("no horizontal page overflow", (await overflow(page)) <= 1, `${await overflow(page)}px`);
        await h.shot(page, `pairl-ready-${vpName}-${scheme}`);

        // After a download tap + opening help: marker moves to Install, nothing is ticked, Play Protect copy is safe.
        await download.click();
        await page.getByTestId("pair-download-started").waitFor();
        chk("after Download the Install step is current", /Install/.test(await page.locator('[data-testid="pair-steps"] [aria-current="step"]').innerText()));
        await page.getByTestId("pair-install-help-toggle").click();
        await page.waitForTimeout(400);
        const help = page.getByTestId("pair-install-help");
        chk("install help expands and is visible", (await help.boundingBox())?.height > 40);
        const helpText = await help.innerText();
        chk("help says to keep Play Protect on", /keep Play Protect on/.test(helpText));
        chk("help never coaches past a security block", !/install anyway|download anyway|turn off|disable play protect|ignore/i.test(helpText));
        chk("still no horizontal overflow when expanded", (await overflow(page)) <= 1, `${await overflow(page)}px`);
        await page.screenshot({ path: `${h.SHOTS_DIR}/pairl-help-${vpName}-${scheme}.png`, fullPage: true });
      },
      { viewport: vp, scheme, reseed: false },
    );
  }
}

for (const scheme of ["light", "dark"]) {
  scenario(
    `pairl-missing-m390-${scheme}`,
    `/pair after Chrome couldn't open the app (missing=1): 390px, ${scheme}`,
    async ({ page }, chk) => {
      await openPair(page, `t=${TOKEN}&missing=1`);
      await page.getByTestId("pair-download-apk").waitFor({ timeout: 60000 });
      await settle(page);
      const hint = await page.getByRole("status").first().innerText();
      chk("says FlowFi didn't open, only 'if it isn't installed yet'", /didn.t open\. If it isn.t installed yet/.test(hint), hint.slice(0, 80));
      chk("the token is still in the address", new URL(page.url()).searchParams.get("t") === TOKEN);
      chk("no horizontal page overflow", (await overflow(page)) <= 1);
      await h.shot(page, `pairl-missing-m390-${scheme}`);
    },
    { viewport: VPS.m390, scheme, reseed: false },
  );
}

scenario(
  "pairl-unpublished-m390-dark",
  "/pair with no published build: Open FlowFi becomes the only (primary) action",
  async ({ page }, chk) => {
    await openPair(page, `t=${TOKEN}`, { published: false });
    await page.getByText(/isn.t published on this site yet/).waitFor({ timeout: 60000 });
    await settle(page);
    chk("no download link is invented", (await page.getByTestId("pair-download-apk").count()) === 0);
    chk("no step row without a download", (await page.getByTestId("pair-steps").count()) === 0);
    chk("Open FlowFi is primary", /\bbg-primary\b/.test((await page.getByTestId("pair-open-app").getAttribute("class")) ?? ""));
    await h.shot(page, "pairl-unpublished-m390-dark");
  },
  { viewport: VPS.m390, scheme: "dark", reseed: false },
);

scenario(
  "pairl-invalid-m390-light",
  "/pair with a malformed token: no app hand-off, inbox link instead",
  async ({ page }, chk) => {
    await openPair(page, "t=short");
    await page.getByText(/pairing link isn.t valid/i).waitFor({ timeout: 60000 });
    await settle(page);
    chk("no Open FlowFi link", (await page.getByTestId("pair-open-app").count()) === 0);
    chk("no download link", (await page.getByTestId("pair-download-apk").count()) === 0);
    await h.shot(page, "pairl-invalid-m390-light");
  },
  { viewport: VPS.m390, scheme: "light", reseed: false },
);
