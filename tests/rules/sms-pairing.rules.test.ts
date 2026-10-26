/**
 * Firestore Emulator rules tests for SMS Sync pairing (2026-10-25):
 * pairing sessions, paired devices, phone-reported device status, and the
 * operator kill switches as a server-side backstop on candidate uploads.
 *
 * Run via `npm run test:rules`. Own project id so `clearFirestore` here can
 * never race the main rules suite.
 */

import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";

const PROJECT_ID = "flowfi-rules-sms-pairing-test";
const OWNER = "owner-uid";
const OTHER = "other-uid";
const DEVICE = "0b5a3f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

const asUser = (uid: string) => testEnv.authenticatedContext(uid).firestore() as unknown as Firestore;
const seed = (fn: (db: Firestore) => Promise<unknown>) => testEnv.withSecurityRulesDisabled((ctx) => fn(ctx.firestore() as unknown as Firestore).then(() => undefined));

function status(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE,
    smsPermission: "granted",
    autoSyncEnabled: true,
    cloudSync: "enabled",
    lastScanAt: Timestamp.fromDate(new Date("2026-10-25T09:00:00Z")),
    lastScanOutcome: "ok",
    lastUploadAt: null,
    lastUploadOutcome: null,
    lastUploadedCount: 0,
    pendingNotOwnedCount: 3,
    appVersion: "1.0.0+1",
    reportedAt: serverTimestamp(),
    ...overrides,
  };
}

const statusRef = (db: Firestore, uid = OWNER, deviceId = DEVICE) => doc(db, "users", uid, "smsDeviceStatus", deviceId);
const activeDevice = (uid = OWNER, deviceStatus = "active") =>
  seed((db) => setDoc(doc(db, "users", uid, "smsDevices", DEVICE), { deviceId: DEVICE, status: deviceStatus, label: "Pixel" }));

describe("smsPairingSessions", () => {
  const sessionId = "a".repeat(64);

  it("the creating account can read its session; nobody else can; no client can write", async () => {
    await seed((db) => setDoc(doc(db, "smsPairingSessions", sessionId), { uid: OWNER, status: "pending" }));
    await assertSucceeds(getDoc(doc(asUser(OWNER), "smsPairingSessions", sessionId)));
    await assertFails(getDoc(doc(asUser(OTHER), "smsPairingSessions", sessionId)));
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore() as unknown as Firestore, "smsPairingSessions", sessionId)));
    await assertFails(updateDoc(doc(asUser(OWNER), "smsPairingSessions", sessionId), { status: "approved" }));
    await assertFails(setDoc(doc(asUser(OWNER), "smsPairingSessions", "b".repeat(64)), { uid: OWNER, status: "pending" }));
    await assertFails(deleteDoc(doc(asUser(OWNER), "smsPairingSessions", sessionId)));
  });
});

describe("smsDevices", () => {
  it("is owner-readable and never client-writable (a phone can't register or re-activate itself)", async () => {
    await activeDevice(OWNER, "revoked");
    await assertSucceeds(getDoc(doc(asUser(OWNER), "users", OWNER, "smsDevices", DEVICE)));
    await assertFails(getDoc(doc(asUser(OTHER), "users", OWNER, "smsDevices", DEVICE)));
    await assertFails(updateDoc(doc(asUser(OWNER), "users", OWNER, "smsDevices", DEVICE), { status: "active" }));
    await assertFails(setDoc(doc(asUser(OWNER), "users", OWNER, "smsDevices", "new-device"), { status: "active" }));
  });
});

describe("smsSyncConfig stays closed to clients after pairing", () => {
  it("the owner still can't switch backgroundUpload on or clear an operator hold", async () => {
    await assertFails(setDoc(doc(asUser(OWNER), "users", OWNER, "smsSyncConfig", "backgroundUpload"), { enabled: true, deviceId: DEVICE }));
    await seed((db) => setDoc(doc(db, "users", OWNER, "smsSyncConfig", "operatorHold"), { disabled: true }));
    await assertFails(deleteDoc(doc(asUser(OWNER), "users", OWNER, "smsSyncConfig", "operatorHold")));
  });
});

describe("smsSyncControl", () => {
  it("signed-in clients can read the global switch; nobody can write it", async () => {
    await seed((db) => setDoc(doc(db, "smsSyncControl", "global"), { uploadsDisabled: true }));
    await assertSucceeds(getDoc(doc(asUser(OWNER), "smsSyncControl", "global")));
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore() as unknown as Firestore, "smsSyncControl", "global")));
    await assertFails(setDoc(doc(asUser(OWNER), "smsSyncControl", "global"), { uploadsDisabled: false }));
  });
});

describe("smsDeviceStatus", () => {
  it("an active paired phone can report its status with a server timestamp", async () => {
    await activeDevice();
    await assertSucceeds(setDoc(statusRef(asUser(OWNER)), status()));
    await assertSucceeds(setDoc(statusRef(asUser(OWNER)), status({ lastUploadAt: Timestamp.now(), lastUploadOutcome: "ok", lastUploadedCount: 4 })));
    await assertSucceeds(getDoc(statusRef(asUser(OWNER))));
  });

  it("refuses an unregistered, revoked or replaced device", async () => {
    await assertFails(setDoc(statusRef(asUser(OWNER)), status()));
    await activeDevice(OWNER, "revoked");
    await assertFails(setDoc(statusRef(asUser(OWNER)), status()));
    await activeDevice(OWNER, "replaced");
    await assertFails(setDoc(statusRef(asUser(OWNER)), status()));
  });

  it("refuses another account, and another account can't read it", async () => {
    await activeDevice();
    await assertFails(setDoc(statusRef(asUser(OTHER)), status()));
    await assertFails(getDoc(statusRef(asUser(OTHER))));
  });

  it("refuses a forged or backdated reportedAt", async () => {
    await activeDevice();
    await assertFails(setDoc(statusRef(asUser(OWNER)), status({ reportedAt: Timestamp.fromDate(new Date("2030-01-01T00:00:00Z")) })));
    await assertFails(setDoc(statusRef(asUser(OWNER)), status({ reportedAt: Timestamp.fromDate(new Date("2020-01-01T00:00:00Z")) })));
  });

  it("refuses unknown keys, missing keys, wrong types and a mismatched device id", async () => {
    await activeDevice();
    await assertFails(setDoc(statusRef(asUser(OWNER)), { ...status(), smsBody: "Rs 500 debited" }));
    const { pendingNotOwnedCount: _omit, ...missing } = status();
    await assertFails(setDoc(statusRef(asUser(OWNER)), missing));
    await assertFails(setDoc(statusRef(asUser(OWNER)), status({ autoSyncEnabled: "yes" })));
    await assertFails(setDoc(statusRef(asUser(OWNER)), status({ smsPermission: "always" })));
    await assertFails(setDoc(statusRef(asUser(OWNER)), status({ lastUploadedCount: -1 })));
    await assertFails(setDoc(statusRef(asUser(OWNER)), status({ deviceId: "someone-else" })));
  });

  it("can never be deleted by a client", async () => {
    await activeDevice();
    await assertSucceeds(setDoc(statusRef(asUser(OWNER)), status()));
    await assertFails(deleteDoc(statusRef(asUser(OWNER))));
  });
});

describe("operator kill switches backstop candidate uploads", () => {
  const candidate = (db: Firestore, id = "cand-1") => doc(db, "users", OWNER, "smsTransactionCandidates", id);
  const payload = { amount: 100, direction: "debit" };
  const paired = (uid = OWNER) => seed((db) => setDoc(doc(db, "users", uid, "smsSyncConfig", "backgroundUpload"), { enabled: true, deviceId: DEVICE, source: "pairing" }));

  beforeEach(async () => {
    await paired(OWNER);
    await paired(OTHER);
  });

  it("uploads work for a paired account with no switch documents present (the normal state)", async () => {
    await assertSucceeds(setDoc(candidate(asUser(OWNER)), payload));
  });

  it("the global switch blocks creating and updating candidates, but not reading or dismissing them", async () => {
    await seed((db) => setDoc(candidate(db, "existing"), payload));
    await seed((db) => setDoc(doc(db, "smsSyncControl", "global"), { uploadsDisabled: true }));
    await assertFails(setDoc(candidate(asUser(OWNER)), payload));
    await assertFails(setDoc(candidate(asUser(OWNER), "existing"), { ...payload, amount: 200 }));
    await assertSucceeds(getDoc(candidate(asUser(OWNER), "existing")));
    await assertSucceeds(deleteDoc(candidate(asUser(OWNER), "existing")));
  });

  it("a global document with uploadsDisabled false (or absent) does not block", async () => {
    await seed((db) => setDoc(doc(db, "smsSyncControl", "global"), { uploadsDisabled: false }));
    await assertSucceeds(setDoc(candidate(asUser(OWNER)), payload));
    await seed((db) => setDoc(doc(db, "smsSyncControl", "global"), { note: "no flag" }));
    await assertSucceeds(setDoc(candidate(asUser(OWNER), "cand-2"), payload));
  });

  it("a per-account hold blocks only that account", async () => {
    await seed((db) => setDoc(doc(db, "users", OWNER, "smsSyncConfig", "operatorHold"), { disabled: true }));
    await assertFails(setDoc(candidate(asUser(OWNER)), payload));
    await assertSucceeds(setDoc(doc(asUser(OTHER), "users", OTHER, "smsTransactionCandidates", "cand-1"), payload));
  });

  it("the tombstone guard still applies alongside the switches", async () => {
    await seed((db) => setDoc(doc(db, "users", OWNER, "smsCandidateTombstones", "cand-1"), { outcome: "dismissed" }));
    await assertFails(setDoc(candidate(asUser(OWNER)), payload));
  });
});

describe("pairing backstop: candidate writes need backgroundUpload enabled (Auto Sync OFF / Disconnect)", () => {
  const candidate = (db: Firestore, id = "cand-1") => doc(db, "users", OWNER, "smsTransactionCandidates", id);
  const payload = { amount: 100, direction: "debit" };
  const config = (data: Record<string, unknown>) => seed((db) => setDoc(doc(db, "users", OWNER, "smsSyncConfig", "backgroundUpload"), data));

  it("an account that was never paired cannot create candidates", async () => {
    await assertFails(setDoc(candidate(asUser(OWNER)), payload));
  });

  it("after revocation (enabled false) a queued upload can neither create nor overwrite, but the web can still read and dismiss", async () => {
    await seed((db) => setDoc(candidate(db, "existing"), payload));
    await config({ enabled: false, deviceId: DEVICE, source: "pairing" });
    await assertFails(setDoc(candidate(asUser(OWNER)), payload));
    await assertFails(setDoc(candidate(asUser(OWNER), "existing"), { ...payload, amount: 200 }));
    await assertSucceeds(getDoc(candidate(asUser(OWNER), "existing")));
    await assertSucceeds(deleteDoc(candidate(asUser(OWNER), "existing")));
  });

  it("fresh pairing (enabled true again) allows uploads", async () => {
    await config({ enabled: true, deviceId: DEVICE, source: "pairing" });
    await assertSucceeds(setDoc(candidate(asUser(OWNER)), payload));
  });
});

describe("smsDevicePresence — live heartbeat, before or after pairing", () => {
  const presenceRef = (db: Firestore, uid = OWNER, deviceId = DEVICE) => doc(db, "users", uid, "smsDevicePresence", deviceId);
  const presence = (overrides: Record<string, unknown> = {}) => ({
    deviceId: DEVICE,
    label: "Samsung SM-S918B",
    platform: "android",
    appVersion: "1.0.1",
    appState: "foreground",
    smsPermission: "granted",
    notificationAccess: "unknown",
    autoSyncEnabled: false,
    syncPhase: "idle",
    syncTotal: null,
    syncDone: 0,
    syncUploaded: 0,
    syncSkipped: 0,
    syncFailed: 0,
    syncUpdatedAt: null,
    lastSyncAt: null,
    heartbeatAt: serverTimestamp(),
    ...overrides,
  });

  it("an unpaired install of the owner can report and read its presence", async () => {
    await assertSucceeds(setDoc(presenceRef(asUser(OWNER)), presence()));
    await assertSucceeds(setDoc(presenceRef(asUser(OWNER)), presence({ syncPhase: "uploading", syncTotal: 40, syncDone: 12, syncUploaded: 10, syncSkipped: 2, syncUpdatedAt: serverTimestamp() })));
    await assertSucceeds(getDoc(presenceRef(asUser(OWNER))));
  });

  it("another account can neither read nor write it", async () => {
    await seed((db) => setDoc(presenceRef(db), { ...presence(), heartbeatAt: Timestamp.now() }));
    await assertFails(getDoc(presenceRef(asUser(OTHER))));
    await assertFails(setDoc(presenceRef(asUser(OTHER)), presence()));
  });

  it("a forged heartbeat time, extra fields (e.g. SMS text) or bad enums are refused", async () => {
    await assertFails(setDoc(presenceRef(asUser(OWNER)), presence({ heartbeatAt: Timestamp.fromDate(new Date("2030-01-01T00:00:00Z")) })));
    await assertFails(setDoc(presenceRef(asUser(OWNER)), { ...presence(), body: "Your OTP is 123456" }));
    await assertFails(setDoc(presenceRef(asUser(OWNER)), presence({ appState: "connected" })));
    await assertFails(setDoc(presenceRef(asUser(OWNER)), presence({ syncDone: -1 })));
    await assertFails(setDoc(presenceRef(asUser(OWNER), OWNER, "some-other-device"), presence()));
    const { label: _label, ...missing } = presence();
    await assertFails(setDoc(presenceRef(asUser(OWNER)), missing));
  });

  it("presence grants nothing: it cannot be deleted and does not authorize uploads", async () => {
    await assertSucceeds(setDoc(presenceRef(asUser(OWNER)), presence({ autoSyncEnabled: true })));
    await assertFails(deleteDoc(presenceRef(asUser(OWNER))));
    await assertFails(setDoc(doc(asUser(OWNER), "users", OWNER, "smsTransactionCandidates", "cand-1"), { amount: 1 }));
  });
});
