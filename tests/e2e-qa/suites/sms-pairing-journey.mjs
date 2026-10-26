/**
 * SMS Sync pairing journey in the empty Transaction Inbox — layout + honesty sweep (390 and 1366, light + dark).
 * Local emulator only (see tests/e2e-qa/README.md). The QA harness runs Auth + Firestore only, so the pairing Cloud
 * Function is unreachable here: the unpaired view must show its "couldn't create a code" state (and never a QR it
 * didn't get). The paired view is seeded through the emulator's admin REST — exactly the records the pairing function
 * and the phone write — and must follow them. Screenshots: tests/e2e-qa/.results/shots/smsp-*.png.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const DEVICE = "0b5a3f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const s = (v) => ({ stringValue: v });
const b = (v) => ({ booleanValue: v });
const i = (v) => ({ integerValue: String(v) });
const t = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const nul = { nullValue: null };

async function put(path, fields) {
  const r = await fetch(`${FIRESTORE_DOCS}/${path}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${path}: ${r.status} ${await r.text()}`);
}

const FORBIDDEN = /\b(is online|is connected|connected now|currently syncing|syncing now|installed)\b/i;
const VPS = { m390: { width: 390, height: 844 }, l1366: { width: 1366, height: 768 } };

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    scenario(
      `smsp-unpaired-${vpName}-${scheme}`,
      `Pairing journey inside the empty-inbox hero: ${vp.width}px, ${scheme}`,
      async ({ page }, chk) => {
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
        await page.getByText("No SMS candidates").waitFor({ timeout: 60000 });
        const journey = page.getByTestId("sms-setup-journey");
        await journey.waitFor({ timeout: 20000 });
        chk("the hero still shows 'No SMS candidates' exactly once", (await page.getByText("No SMS candidates").count()) === 1);
        chk("the journey is in the pairing phase", (await journey.getAttribute("data-phase")) === "pairing");

        const qr = page.getByTestId("sms-setup-step-qr");
        await page.waitForFunction(() => document.querySelector('[data-testid="sms-setup-step-qr"]')?.getAttribute("data-state") !== "active", null, { timeout: 30000 }).catch(() => {});
        const qrState = await qr.getAttribute("data-state");
        chk("without the pairing function the code step fails honestly", qrState === "failed", qrState);
        chk("…and no QR is drawn for a code that doesn't exist", (await page.getByTestId("sms-pairing-qr").count()) === 0);
        chk("all seven steps are listed", (await page.locator('[data-testid^="sms-setup-step-"]').count()) === 7);
        chk("nothing claims the phone is online/connected/installed/syncing", !FORBIDDEN.test(await journey.innerText()));
        chk("no horizontal page overflow", (await overflow()) <= 1, `${await overflow()}px`);
        const newCode = await page.getByRole("button", { name: /New code/ }).boundingBox();
        chk("New code is a 44px touch target", !!newCode && newCode.height >= 44, newCode ? `${Math.round(newCode.height)}px` : "none");
        await journey.scrollIntoViewIfNeeded();
        await h.shot(page, `smsp-unpaired-${vpName}-${scheme}`);
      },
      { viewport: vp, scheme },
    );

    scenario(
      `smsp-paired-${vpName}-${scheme}`,
      `Paired phone, live setup progress from its own reports: ${vp.width}px, ${scheme}`,
      async ({ page }, chk) => {
        const uid = await h.authUid();
        const pairedAt = Date.now() - 4 * 60_000;
        await put(`users/${uid}/smsSyncConfig/backgroundUpload`, { enabled: b(true), deviceId: s(DEVICE), source: s("pairing") });
        await put(`users/${uid}/smsDevices/${DEVICE}`, { deviceId: s(DEVICE), label: s("Samsung SM-S918B"), status: s("active"), pairedAt: t(pairedAt), platform: s("android") });
        // Permission granted, Auto Sync not yet on.
        await put(`users/${uid}/smsDeviceStatus/${DEVICE}`, {
          deviceId: s(DEVICE),
          smsPermission: s("granted"),
          autoSyncEnabled: b(false),
          cloudSync: nul,
          lastScanAt: nul,
          lastScanOutcome: nul,
          lastUploadAt: nul,
          lastUploadOutcome: nul,
          lastUploadedCount: i(0),
          pendingNotOwnedCount: i(0),
          appVersion: s("1.0.0+1"),
          reportedAt: t(pairedAt + 30_000),
        });
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

        await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
        const standalone = page.getByTestId("sms-setup-standalone");
        await standalone.waitFor({ timeout: 60000 });
        chk("a paired phone gets the standalone journey, not the connect panel", (await page.getByTestId("sms-connect-panel").count()) === 0);
        chk("the paired phone is named", await page.getByTestId("sms-paired-device").getByText("Samsung SM-S918B").isVisible());
        const state = (id) => page.getByTestId(`sms-setup-step-${id}`).getAttribute("data-state");
        chk("paired + permission are done, Auto Sync is the current step", (await state("paired")) === "done" && (await state("permission")) === "done" && (await state("autoSync")) === "active");
        await h.shot(page, `smsp-paired-setup-${vpName}-${scheme}`);

        // The phone reports Auto Sync on and a first scan with 2 unlinked earlier messages — the page follows live.
        await put(`users/${uid}/smsDeviceStatus/${DEVICE}`, {
          deviceId: s(DEVICE),
          smsPermission: s("granted"),
          autoSyncEnabled: b(true),
          cloudSync: s("enabled"),
          lastScanAt: t(Date.now() - 5_000),
          lastScanOutcome: s("ok"),
          lastUploadAt: t(Date.now() - 4_000),
          lastUploadOutcome: s("ok"),
          lastUploadedCount: i(0),
          pendingNotOwnedCount: i(2),
          appVersion: s("1.0.0+1"),
          reportedAt: t(Date.now() - 3_000),
        });
        await page.waitForFunction(() => document.querySelector('[data-testid="sms-setup-journey"]')?.getAttribute("data-phase") === "complete", null, { timeout: 20000 }).catch(() => {});
        chk("setup completes live from the phone's report", (await page.getByTestId("sms-setup-journey").getAttribute("data-phase")) === "complete");
        chk("'No SMS candidates' appears exactly once", (await page.getByText("No SMS candidates").count()) === 1);
        chk("earlier unlinked messages are pointed out, not claimed", /2 earlier messages are still only on your phone/.test(await page.getByTestId("sms-setup-unlinked").innerText()));
        chk("nothing claims the phone is online/connected/installed/syncing", !FORBIDDEN.test(await standalone.innerText()));
        chk("no horizontal page overflow", (await overflow()) <= 1, `${await overflow()}px`);
        const disconnect = await page.getByRole("button", { name: /^Disconnect$/ }).boundingBox();
        chk("Disconnect is a 44px touch target", !!disconnect && disconnect.height >= 44, disconnect ? `${Math.round(disconnect.height)}px` : "none");
        await h.shot(page, `smsp-paired-complete-${vpName}-${scheme}`);

        // Disconnected on another tab/phone: the switch goes off → back to pairing (the function is unreachable here, so its code step fails).
        await put(`users/${uid}/smsSyncConfig/backgroundUpload`, { enabled: b(false), deviceId: s(DEVICE), disabledReason: s("device_revoked") });
        await put(`users/${uid}/smsDevices/${DEVICE}`, { deviceId: s(DEVICE), label: s("Samsung SM-S918B"), status: s("revoked"), pairedAt: t(pairedAt) });
        await page.getByTestId("sms-connect-panel").waitFor({ timeout: 20000 }).catch(() => {});
        chk("a revoked phone returns the inbox to first-time pairing", (await page.getByTestId("sms-connect-panel").count()) === 1 && (await page.getByTestId("sms-paired-device").count()) === 0);
      },
      { viewport: vp, scheme },
    );
  }
}
