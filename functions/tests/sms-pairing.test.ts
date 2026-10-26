/**
 * Real Firestore Emulator tests for SMS Sync device pairing
 * (src/sms-pairing/sms-pairing.ts): token secrecy, expiry, single use,
 * wrong-account rejection, operator kill switches, multi-device
 * replacement, revocation, cancel, and a genuine concurrent-approve race.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetRateLimit } from "../src/ingestion/rate-limit";
import {
  approvePairing,
  cancelPairing,
  createPairingSession,
  hashPairingToken,
  previewPairing,
  revokeDevice,
  SMS_PAIRING_CLAIM_RATE_NAMESPACE,
  SMS_PAIRING_CREATE_RATE_LIMIT,
  SMS_PAIRING_CREATE_RATE_NAMESPACE,
  SMS_PAIRING_TTL_MS,
  SmsPairingError,
  type SmsPairingErrorCode,
} from "../src/sms-pairing/sms-pairing";

const PROJECT_ID = "flowfi-functions-test";
const OWNER = "pairing-owner";
const OTHER = "pairing-other";
const DEVICE_A = "0b5a3f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const DEVICE_B = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  const sessions = await db.collection("smsPairingSessions").get();
  await Promise.all(sessions.docs.map((d) => d.ref.delete()));
  await db.collection("smsSyncControl").doc("global").delete();
  for (const uid of [OWNER, OTHER]) {
    for (const sub of ["smsDevices", "smsSyncConfig"]) {
      const snap = await db.collection("users").doc(uid).collection(sub).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
    await resetRateLimit(db, SMS_PAIRING_CREATE_RATE_NAMESPACE, uid);
    await resetRateLimit(db, SMS_PAIRING_CLAIM_RATE_NAMESPACE, uid);
  }
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

async function expectRefused(promise: Promise<unknown>, code: SmsPairingErrorCode) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof SmsPairingError && e.code === code);
}

const uploadConfig = (uid = OWNER) => db.collection("users").doc(uid).collection("smsSyncConfig").doc("backgroundUpload").get();
const device = (id: string, uid = OWNER) => db.collection("users").doc(uid).collection("smsDevices").doc(id).get();
const session = (id: string) => db.collection("smsPairingSessions").doc(id).get();

describe("createPairingSession", () => {
  it("returns a one-time token whose SHA-256 is the session id; the token itself is never stored", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.sessionId).toBe(hashPairingToken(created.token));
    const snap = await session(created.sessionId);
    expect(snap.get("uid")).toBe(OWNER);
    expect(snap.get("status")).toBe("pending");
    expect(JSON.stringify(snap.data())).not.toContain(created.token);
    expect(created.expiresAt - (snap.get("createdAt") as Timestamp).toMillis()).toBe(SMS_PAIRING_TTL_MS);
  });

  it("supersedes the account's previous open session so only the newest QR can be claimed", async () => {
    const first = await createPairingSession(db, { uid: OWNER });
    const second = await createPairingSession(db, { uid: OWNER });
    expect((await session(first.sessionId)).get("status")).toBe("superseded");
    await expectRefused(approvePairing(db, { uid: OWNER, token: first.token, deviceId: DEVICE_A }), "superseded");
    await expect(approvePairing(db, { uid: OWNER, token: second.token, deviceId: DEVICE_A })).resolves.toMatchObject({ status: "paired" });
  });

  it("never supersedes another account's sessions", async () => {
    const mine = await createPairingSession(db, { uid: OWNER });
    await createPairingSession(db, { uid: OTHER });
    expect((await session(mine.sessionId)).get("status")).toBe("pending");
  });

  it("is rate limited per account", async () => {
    for (let i = 0; i < SMS_PAIRING_CREATE_RATE_LIMIT.maxAttempts; i++) await createPairingSession(db, { uid: OWNER });
    await expectRefused(createPairingSession(db, { uid: OWNER }), "rate_limited");
  });
});

describe("previewPairing", () => {
  it("marks the session opened (the web's evidence the app reached it) without pairing anything", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    const preview = await previewPairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A });
    expect(preview.activeDevice).toBeNull();
    const snap = await session(created.sessionId);
    expect(snap.get("status")).toBe("opened");
    expect(snap.get("openedAt")).toBeInstanceOf(Timestamp);
    expect((await uploadConfig()).exists).toBe(false);
  });

  it("rejects a different signed-in account and records the attempt on the session", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await expectRefused(previewPairing(db, { uid: OTHER, token: created.token }), "wrong_account");
    const snap = await session(created.sessionId);
    expect(snap.get("status")).toBe("pending");
    expect(snap.get("rejectedAttempts")).toBe(1);
    expect(snap.get("lastRejection.reason")).toBe("wrong_account");
  });

  it("rejects expired, malformed and unknown tokens", async () => {
    const t0 = new Date("2026-10-25T10:00:00Z");
    const created = await createPairingSession(db, { uid: OWNER, now: t0 });
    await expectRefused(previewPairing(db, { uid: OWNER, token: created.token, now: new Date(t0.getTime() + SMS_PAIRING_TTL_MS) }), "expired");
    await expectRefused(previewPairing(db, { uid: OWNER, token: "not-a-token" }), "invalid");
    await expectRefused(previewPairing(db, { uid: OWNER, token: "A".repeat(43) }), "invalid");
    await expectRefused(previewPairing(db, { uid: OWNER, token: 42 }), "invalid");
  });

  it("names the phone this one would replace", async () => {
    const first = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: first.token, deviceId: DEVICE_A, deviceLabel: "Pixel 8" });
    const second = await createPairingSession(db, { uid: OWNER });
    const preview = await previewPairing(db, { uid: OWNER, token: second.token, deviceId: DEVICE_B });
    expect(preview.activeDevice).toMatchObject({ deviceId: DEVICE_A, label: "Pixel 8", isThisDevice: false });
  });
});

describe("approvePairing", () => {
  it("registers the device and writes the F3 upload switch for exactly that device", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    const result = await approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A, deviceLabel: "Galaxy\u0007 S23", appVersion: "1.0.0+1" });
    expect(result).toEqual({ status: "paired", deviceId: DEVICE_A, alreadyPaired: false, replacedDeviceLabel: null });

    const config = await uploadConfig();
    expect(config.data()).toMatchObject({ enabled: true, deviceId: DEVICE_A, source: "pairing", pairedSessionId: created.sessionId });
    const dev = await device(DEVICE_A);
    expect(dev.data()).toMatchObject({ status: "active", platform: "android", label: "Galaxy S23", appVersion: "1.0.0+1" });
    expect((await session(created.sessionId)).get("status")).toBe("approved");
  });

  it("is single use: a second device can't replay an approved token", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A });
    await expectRefused(approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_B }), "used");
    expect((await uploadConfig()).get("deviceId")).toBe(DEVICE_A);
    expect((await device(DEVICE_B)).exists).toBe(false);
  });

  it("treats a retried approval from the same device as success without rewriting anything", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A });
    const before = (await uploadConfig()).updateTime;
    const retry = await approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A });
    expect(retry.alreadyPaired).toBe(true);
    expect((await uploadConfig()).updateTime?.isEqual(before!)).toBe(true);
  });

  it("never pairs a device into the account that created the QR when a different account approves", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await expectRefused(approvePairing(db, { uid: OTHER, token: created.token, deviceId: DEVICE_B }), "wrong_account");
    expect((await uploadConfig(OWNER)).exists).toBe(false);
    expect((await uploadConfig(OTHER)).exists).toBe(false);
    expect((await device(DEVICE_B, OTHER)).exists).toBe(false);
  });

  it("refuses an expired session", async () => {
    const t0 = new Date("2026-10-25T10:00:00Z");
    const created = await createPairingSession(db, { uid: OWNER, now: t0 });
    await expectRefused(approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A, now: new Date(t0.getTime() + SMS_PAIRING_TTL_MS + 1) }), "expired");
    expect((await uploadConfig()).exists).toBe(false);
  });

  it("rejects a device id that isn't an install UUID", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await expectRefused(approvePairing(db, { uid: OWNER, token: created.token, deviceId: "IMEI-356938035643809" }), "invalid_device");
    await expectRefused(approvePairing(db, { uid: OWNER, token: created.token, deviceId: undefined }), "invalid_device");
  });

  it("lets exactly one of two concurrent approvals win", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    const results = await Promise.allSettled([
      approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A }),
      approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_B }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ deviceId: string }>).value.deviceId;
    expect((await uploadConfig()).get("deviceId")).toBe(winner);
  });
});

describe("multi-device", () => {
  it("pairing a second phone makes it the only uploader and marks the first replaced", async () => {
    const first = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: first.token, deviceId: DEVICE_A, deviceLabel: "Old phone" });
    const second = await createPairingSession(db, { uid: OWNER });
    const result = await approvePairing(db, { uid: OWNER, token: second.token, deviceId: DEVICE_B, deviceLabel: "New phone" });

    expect(result.replacedDeviceLabel).toBe("Old phone");
    expect((await uploadConfig()).get("deviceId")).toBe(DEVICE_B);
    expect((await device(DEVICE_A)).get("status")).toBe("replaced");
    expect((await device(DEVICE_B)).get("status")).toBe("active");
  });
});

describe("operator kill switches", () => {
  it("the global switch blocks creating, previewing and approving — and pairing can't clear it", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await db.collection("smsSyncControl").doc("global").set({ uploadsDisabled: true, reason: "incident" });

    await expectRefused(createPairingSession(db, { uid: OWNER }), "sync_suspended");
    await expectRefused(previewPairing(db, { uid: OWNER, token: created.token }), "sync_suspended");
    await expectRefused(approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A }), "sync_suspended");
    expect((await uploadConfig()).exists).toBe(false);
    expect((await db.collection("smsSyncControl").doc("global").get()).get("uploadsDisabled")).toBe(true);
  });

  it("a per-account operator hold blocks only that account", async () => {
    await db.collection("users").doc(OWNER).collection("smsSyncConfig").doc("operatorHold").set({ disabled: true });
    await expectRefused(createPairingSession(db, { uid: OWNER }), "sync_suspended");
    await expect(createPairingSession(db, { uid: OTHER })).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it("a hold set after the QR was shown still blocks the approval", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await db.collection("users").doc(OWNER).collection("smsSyncConfig").doc("operatorHold").set({ disabled: true });
    await expectRefused(approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A }), "sync_suspended");
    expect((await session(created.sessionId)).get("status")).toBe("pending");
  });
});

describe("cancelPairing", () => {
  it("the phone's 'Not now' cancels the session, after which it can't be approved", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await expect(cancelPairing(db, { uid: OWNER, token: created.token, by: "phone" })).resolves.toEqual({ status: "canceled" });
    expect((await session(created.sessionId)).get("canceledBy")).toBe("phone");
    await expectRefused(approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A }), "canceled");
  });

  it("web cancels by session id; another account can't cancel or probe it", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await expectRefused(cancelPairing(db, { uid: OTHER, sessionId: created.sessionId, by: "web" }), "invalid");
    await expect(cancelPairing(db, { uid: OWNER, sessionId: created.sessionId, by: "web" })).resolves.toEqual({ status: "canceled" });
  });

  it("leaves an approved session alone", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A });
    await expect(cancelPairing(db, { uid: OWNER, sessionId: created.sessionId, by: "web" })).resolves.toEqual({ status: "approved" });
    expect((await uploadConfig()).get("enabled")).toBe(true);
  });
});

describe("revokeDevice", () => {
  it("disconnecting the active phone switches uploads off for it", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A });
    await expect(revokeDevice(db, { uid: OWNER, deviceId: DEVICE_A })).resolves.toEqual({ status: "revoked", uploadsStopped: true });
    expect((await uploadConfig()).data()).toMatchObject({ enabled: false, deviceId: DEVICE_A, disabledReason: "device_revoked" });
    expect((await device(DEVICE_A)).get("status")).toBe("revoked");
  });

  it("disconnecting a replaced phone leaves the active one uploading", async () => {
    const first = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: first.token, deviceId: DEVICE_A });
    const second = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: second.token, deviceId: DEVICE_B });
    await expect(revokeDevice(db, { uid: OWNER, deviceId: DEVICE_A })).resolves.toEqual({ status: "revoked", uploadsStopped: false });
    expect((await uploadConfig()).data()).toMatchObject({ enabled: true, deviceId: DEVICE_B });
  });

  it("can't revoke another account's device", async () => {
    const created = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: created.token, deviceId: DEVICE_A });
    await expectRefused(revokeDevice(db, { uid: OTHER, deviceId: DEVICE_A }), "not_found");
    expect((await uploadConfig()).get("enabled")).toBe(true);
  });

  it("a revoked phone can be paired again with a fresh QR", async () => {
    const first = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: first.token, deviceId: DEVICE_A });
    await revokeDevice(db, { uid: OWNER, deviceId: DEVICE_A });
    const second = await createPairingSession(db, { uid: OWNER });
    await approvePairing(db, { uid: OWNER, token: second.token, deviceId: DEVICE_A });
    expect((await uploadConfig()).data()).toMatchObject({ enabled: true, deviceId: DEVICE_A });
    expect((await device(DEVICE_A)).get("status")).toBe("active");
  });
});
