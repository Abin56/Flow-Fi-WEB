/**
 * Transaction Inbox single-screen SMS Sync panel — responsive layout, pairing states and candidate priority.
 * Local emulator only (see tests/e2e-qa/README.md).
 *
 * The QA harness runs Auth + Firestore only, so the pairing Cloud Functions aren't there. These scenarios stand in for
 * exactly what `createSmsPairingSessionCallable` does — return { sessionId, token } and write the session document —
 * by answering that one localhost callable request in the page and writing the same session record through the
 * emulator's admin REST. Every later state change is a record the real function or phone would write; the page is
 * only observed. The release manifest is served from the route with the shape of the real published file.
 * Screenshots: tests/e2e-qa/.results/shots/smsc-*.png.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const DEVICE = "0b5a3f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const s = (v) => ({ stringValue: v });
const b = (v) => ({ booleanValue: v });
const i = (v) => ({ integerValue: String(v) });
const n = (v) => ({ doubleValue: v });
const t = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const nul = { nullValue: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function put(path, fields) {
  const r = await fetch(`${FIRESTORE_DOCS}/${path}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${path}: ${r.status} ${await r.text()}`);
}

// Same shape as https://flowfi.web.app/downloads/flowfi-android.json (v1.0.0).
const MANIFEST = {
  version: "1.0.0",
  versionCode: 1,
  sha256: "087c0c1d74f845b6fb5d4e2e03b7d53ad6fc1f5ed775971f054f8c80f14cc843",
  sizeBytes: 140964073,
  file: "flowfi-android-1.0.0.apk",
  packageName: "com.flowfi.app",
  publishedAt: "2026-10-25T11:56:03.152Z",
};

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

/** Answers the pairing callables the way the functions do, writing each new session record. Returns the sessions created. */
async function stubPairing(page, uid) {
  const created = [];
  await page.route("**/createSmsPairingSessionCallable", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const token = `QaToken${created.length}`.padEnd(43, "x");
    const sessionId = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    await put(`smsPairingSessions/${sessionId}`, {
      uid: s(uid),
      status: s("pending"),
      createdAt: t(now),
      expiresAt: t(now + 10 * 60_000),
      openedAt: nul,
      approvedAt: nul,
      deviceId: nul,
      rejectedAttempts: i(0),
    });
    created.push({ sessionId, token, createdAt: now });
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ result: { sessionId, token, expiresAt: now + 10 * 60_000 } }) });
  });
  await page.route("**/cancelSmsPairingCallable", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ result: { status: "canceled" } }) }),
  );
  return created;
}

async function serveManifest(page, mode = "ready") {
  await page.route("**/downloads/flowfi-android.json", (route) =>
    mode === "ready"
      ? route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(MANIFEST) })
      : mode === "missing"
        ? route.fulfill({ status: 404, contentType: "text/html", body: "<html>404</html>" })
        : route.abort("internetdisconnected"),
  );
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** Elements inside the panel that scroll on their own (nested scrollbars). */
const nestedScrollers = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sms-connect-panel"] *, [data-testid="sms-setup-standalone"] *')].filter((el) => {
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    }).length,
  );

const VPS = {
  w360: { width: 360, height: 780 },
  w390: { width: 390, height: 844 },
  w430: { width: 430, height: 932 },
  w768: { width: 768, height: 1024 },
  w1366: { width: 1366, height: 768 },
  w1920: { width: 1920, height: 1080 },
};

for (const [vpName, vp] of Object.entries(VPS)) {
  for (const scheme of ["light", "dark"]) {
    scenario(
      `smsc-connect-${vpName}-${scheme}`,
      `Connect panel, real QR + published download: ${vp.width}px, ${scheme}`,
      async ({ page }, chk) => {
        const uid = await h.authUid();
        await stubPairing(page, uid);
        await serveManifest(page, "ready");
        await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
        const panel = page.getByTestId("sms-connect-panel");
        await panel.waitFor({ timeout: 60000 });
        const qr = page.getByTestId("sms-pairing-qr");
        await qr.waitFor({ timeout: 30000 });
        await page.getByTestId("sms-download-apk").waitFor({ timeout: 15000 });
        await sleep(900); // let entrance motion settle before measuring

        chk("one panel, in the connect mode", (await page.getByTestId("sms-setup-journey").getAttribute("data-mode")) === "connect");
        chk("'No SMS candidates' appears exactly once", (await page.getByText("No SMS candidates").count()) === 1);
        chk("exactly one QR and one progress strip", (await qr.count()) === 1 && (await page.getByTestId("sms-setup-phases").count()) === 1);
        chk("all seven backend steps are tracked", (await page.locator('[data-testid^="sms-setup-step-"]').count()) === 7);
        chk("the old marketing hero and setup guide are gone", (await page.getByText("Every bank alert.").count()) === 0 && (await page.getByText(/Hide (setup )?guide/).count()) === 0);
        chk("no stale 'isn't published' message", (await page.getByText(/isn't published/).count()) === 0);
        const apk = await page.getByTestId("sms-download-apk").getAttribute("href");
        chk("download links to the APK named in the manifest", apk === `${BASE_URL}/downloads/flowfi-android-1.0.0.apk`, apk);
        chk("no horizontal page overflow", (await overflow(page)) <= 1, `${await overflow(page)}px`);
        chk("no nested scrollbars inside the panel", (await nestedScrollers(page)) === 0);

        const qrBox = await qr.boundingBox();
        if (vp.width >= 1024) {
          const panelBox = await panel.boundingBox();
          chk("desktop: QR visible without scrolling", !!qrBox && qrBox.y + qrBox.height <= vp.height, qrBox ? `qr bottom ${Math.round(qrBox.y + qrBox.height)} / ${vp.height}` : "none");
          chk("desktop: whole panel fits about one viewport", !!panelBox && panelBox.y + panelBox.height <= vp.height * 1.12, panelBox ? `panel bottom ${Math.round(panelBox.y + panelBox.height)} / ${vp.height}` : "none");
        } else {
          chk("mobile/tablet: QR comes before the illustration", !!qrBox && qrBox.y < ((await page.getByLabel(/Illustration with sample data/).boundingBox())?.y ?? 0));
          const open = await page.getByRole("link", { name: /Open in FlowFi app/ }).boundingBox();
          chk("narrow: 'Open in FlowFi app' is offered as a 44px action", !!open && open.height >= 44, open ? `${Math.round(open.height)}px` : "none");
        }
        const newCode = await page.getByRole("button", { name: /New code/ }).boundingBox();
        chk("New code is a 44px touch target", !!newCode && newCode.height >= 44);

        await h.shot(page, `smsc-connect-${vpName}-${scheme}-fold`);
        await page.screenshot({ path: path.join(h.SHOTS_DIR, `smsc-connect-${vpName}-${scheme}-full.png`), fullPage: true });
      },
      { viewport: vp, scheme },
    );
  }

  scenario(
    `smsc-reduced-motion-${vpName}`,
    `Connect panel under prefers-reduced-motion: ${vp.width}px`,
    async ({ page }, chk) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const uid = await h.authUid();
      await stubPairing(page, uid);
      await serveManifest(page, "ready");
      await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("sms-pairing-qr").waitFor({ timeout: 60000 });
      chk("the illustration shows its static final frame", (await page.getByText("Ready for review").count()) >= 1);
      chk("no infinite framer loops are running near the QR (no scan beam)", (await page.locator('[data-testid="sms-qr-card"] .mix-blend-multiply').count()) === 0);
    },
    { viewport: vp, scheme: "light" },
  );
}

for (const scheme of ["light", "dark"]) {
  scenario(
    `smsc-states-${scheme}`,
    `Panel follows real backend records: opened → expired → new code → paired → action required → complete → candidates → revoked (${scheme})`,
    async ({ page }, chk) => {
      const uid = await h.authUid();
      const sessions = await stubPairing(page, uid);
      await serveManifest(page, "ready");
      await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
      const journey = page.getByTestId("sms-setup-journey");
      await page.getByTestId("sms-pairing-qr").waitFor({ timeout: 60000 });
      const first = sessions[0];
      const mode = () => journey.getAttribute("data-mode");
      const step = (id) => page.getByTestId(`sms-setup-step-${id}`).getAttribute("data-state");
      const phase = (id) => page.getByTestId(`sms-phase-${id}`).getAttribute("data-state");

      chk("QR ready: connect phase is in progress, nothing later is done", (await phase("connect")) === "active" && (await phase("approve")) === "upcoming");
      await h.shot(page, `smsc-state-1-qr-${scheme}`);

      // The app opened the code (function sets openedAt).
      await put(`smsPairingSessions/${first.sessionId}?updateMask.fieldPaths=status&updateMask.fieldPaths=openedAt`, { status: s("opened"), openedAt: t(Date.now()) });
      await page.getByText("Approve on your phone").waitFor({ timeout: 15000 });
      chk("opened: asks for approval on the phone", (await page.getByText("Opened on phone").count()) === 1 && (await step("app")) === "done");
      await h.shot(page, `smsc-state-2-opened-${scheme}`);

      // Expiry, as the function would let it lapse.
      await put(`smsPairingSessions/${first.sessionId}?updateMask.fieldPaths=expiresAt`, { expiresAt: t(Date.now() - 1000) });
      await page.getByText("Code expired").waitFor({ timeout: 15000 });
      chk("expired: QR removed and the countdown gone", (await page.getByTestId("sms-pairing-qr").count()) === 0 && (await page.getByText(/expires in/).count()) === 0);
      chk("expired: connect phase shows expired", (await phase("connect")) === "expired");
      await h.shot(page, `smsc-state-3-expired-${scheme}`);

      await page.getByRole("button", { name: /New code/ }).click();
      await page.getByTestId("sms-pairing-qr").waitFor({ timeout: 15000 });
      chk("New code creates exactly one new session and shows its QR", sessions.length === 2 && (await step("qr")) === "done");

      // Approved + registered (what approveSmsPairing writes), permission declined on the phone.
      const second = sessions[1];
      const pairedAt = Date.now() - 60_000;
      await put(`smsPairingSessions/${second.sessionId}?updateMask.fieldPaths=status&updateMask.fieldPaths=openedAt&updateMask.fieldPaths=approvedAt&updateMask.fieldPaths=deviceId`, {
        status: s("approved"),
        openedAt: t(pairedAt - 5000),
        approvedAt: t(pairedAt),
        deviceId: s(DEVICE),
      });
      await put(`users/${uid}/smsDevices/${DEVICE}`, { deviceId: s(DEVICE), label: s("Samsung SM-S918B"), status: s("active"), pairedAt: t(pairedAt), platform: s("android") });
      await put(`users/${uid}/smsSyncConfig/backgroundUpload`, { enabled: b(true), deviceId: s(DEVICE), source: s("pairing") });
      const report = (over) =>
        put(`users/${uid}/smsDeviceStatus/${DEVICE}`, {
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
          reportedAt: t(Date.now() - 2000),
          ...over,
        });
      await report({ smsPermission: s("denied") });
      await page.getByTestId("sms-next-action").waitFor({ timeout: 20000 });
      chk("paired + permission missing: compact action-required state, no QR, no illustration", (await mode()) === "setup" && (await page.getByText("Action required").count()) === 1 && (await page.getByTestId("sms-pairing-qr").count()) === 0 && (await page.getByLabel(/Illustration with sample data/).count()) === 0);
      chk("connect done, approve needs attention", (await phase("connect")) === "done" && (await phase("approve")) === "failed");
      await h.shot(page, `smsc-state-4-permission-${scheme}`);

      await report({ smsPermission: s("granted"), autoSyncEnabled: b(false) });
      await page.getByText("Turn on SMS Auto Sync", { exact: true }).waitFor({ timeout: 15000 });
      chk("Auto Sync off: next action says so", (await page.getByTestId("sms-next-action").getAttribute("data-step")) === "autoSync");
      await h.shot(page, `smsc-state-5-autosync-${scheme}`);

      await report({ autoSyncEnabled: b(true), cloudSync: s("enabled"), lastScanAt: t(Date.now() - 3000), lastScanOutcome: s("ok") });
      await page.waitForFunction(() => document.querySelector('[data-testid="sms-setup-journey"]')?.getAttribute("data-mode") === "complete", null, { timeout: 20000 });
      chk("ready, no candidates: compact empty state, says 'No SMS candidates' once", (await page.getByText("No SMS candidates").count()) === 1);
      chk("Review phase isn't marked done without real candidates", (await phase("review")) === "active" && (await step("candidates")) === "active");
      await h.shot(page, `smsc-state-6-complete-${scheme}`);

      // A real candidate arrives: the inbox list takes over.
      await put(`users/${uid}/smsTransactionCandidates/qa_conn_1`, {
        amount: n(1249),
        direction: s("debit"),
        eventType: s("upiPayment"),
        transactionDate: t(Date.now() - 60_000),
        merchant: s("Blueleaf Cafe"),
        bankName: s("QA Bank"),
        rawLastFour: nul,
        accountId: nul,
        cardId: nul,
        referenceNumber: nul,
        confidenceLevel: s("high"),
        confidenceScore: n(0.9),
        needsReview: b(false),
        needsReviewReasons: { arrayValue: { values: [] } },
        source: s("sms"),
        createdAt: t(Date.now()),
        deletedAt: nul,
      });
      await page.getByTestId("candidates-ledger").waitFor({ timeout: 20000 });
      chk("candidates available: list shown, panel not above it", (await journey.count()) === 0 && (await page.getByTestId("candidate-row").count()) >= 1);
      await h.shot(page, `smsc-state-7-candidates-${scheme}`);
      await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/qa_conn_1`, { method: "DELETE", headers: OWNER });
      await journey.waitFor({ timeout: 20000 });

      // Revoked elsewhere → back to connect, with a recovery message.
      await put(`users/${uid}/smsSyncConfig/backgroundUpload`, { enabled: b(false), deviceId: s(DEVICE), disabledReason: s("device_revoked") });
      await put(`users/${uid}/smsDevices/${DEVICE}`, { deviceId: s(DEVICE), label: s("Samsung SM-S918B"), status: s("revoked"), pairedAt: t(pairedAt) });
      await page.getByTestId("sms-setup-former-device").waitFor({ timeout: 20000 });
      chk("revoked: connect mode with a clear recovery note", (await mode()) === "connect" && /Samsung SM-S918B was disconnected/.test(await page.getByTestId("sms-setup-former-device").innerText()));
      await page.getByTestId("sms-pairing-qr").waitFor({ timeout: 15000 }).catch(() => {});
      await h.shot(page, `smsc-state-8-revoked-${scheme}`);
      chk("no horizontal overflow throughout", (await overflow(page)) <= 1);
    },
    { viewport: { width: 1366, height: 768 }, scheme },
  );
}

scenario(
  "smsc-manifest-states",
  "Android download: missing manifest vs network failure (with retry) are distinct and never contradict a published release",
  async ({ page }, chk) => {
    const uid = await h.authUid();
    await stubPairing(page, uid);
    await serveManifest(page, "missing");
    await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
    const hint = page.getByTestId("sms-download-hint");
    await page.waitForFunction(() => document.querySelector('[data-testid="sms-download-hint"]')?.getAttribute("data-release") === "unavailable", null, { timeout: 60000 });
    chk("missing manifest → 'isn't available', no link", /isn't available/.test(await hint.innerText()) && (await page.getByTestId("sms-download-apk").count()) === 0);

    await page.unroute("**/downloads/flowfi-android.json");
    await serveManifest(page, "offline");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector('[data-testid="sms-download-hint"]')?.getAttribute("data-release") === "error", null, { timeout: 60000 });
    chk("network failure → retry offered, availability not claimed", /Couldn.t check/.test(await hint.innerText()) && !/isn't available/.test(await hint.innerText()));
    await h.shot(page, "smsc-manifest-error");

    await page.unroute("**/downloads/flowfi-android.json");
    await serveManifest(page, "ready");
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByTestId("sms-download-apk").waitFor({ timeout: 15000 });
    chk("retry → published release linked with version and size", /v1\.0\.0 · 134 MB/.test(await hint.innerText()));
  },
);
