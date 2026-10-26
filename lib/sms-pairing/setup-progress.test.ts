import { describe, expect, it } from "vitest";
import {
  deriveSetupProgress,
  formatCountdown,
  formatRelative,
  STALE_REPORT_MS,
  type PairingSessionView,
  type SetupInput,
  type SmsDeviceStatusView,
  type SmsDeviceView,
  type StepState,
} from "./setup-progress";

const NOW = Date.parse("2026-10-25T10:05:00Z");
const PAIRED_AT = Date.parse("2026-10-25T10:02:00Z");
const DEVICE_ID = "0b5a3f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

const session = (over: Partial<PairingSessionView> = {}): PairingSessionView => ({
  status: "pending",
  createdAt: Date.parse("2026-10-25T10:00:00Z"),
  expiresAt: Date.parse("2026-10-25T10:10:00Z"),
  openedAt: null,
  approvedAt: null,
  deviceId: null,
  canceledBy: null,
  rejectedAttempts: 0,
  ...over,
});

const device = (over: Partial<SmsDeviceView> = {}): SmsDeviceView => ({ deviceId: DEVICE_ID, label: "Pixel 8", status: "active", pairedAt: PAIRED_AT, ...over });

const report = (over: Partial<SmsDeviceStatusView> = {}): SmsDeviceStatusView => ({
  smsPermission: "granted",
  autoSyncEnabled: true,
  cloudSync: "enabled",
  lastScanAt: PAIRED_AT + 30_000,
  lastScanOutcome: "ok",
  lastUploadAt: PAIRED_AT + 31_000,
  lastUploadOutcome: "ok",
  lastUploadedCount: 0,
  pendingNotOwnedCount: 0,
  reportedAt: PAIRED_AT + 32_000,
  ...over,
});

const base = (over: Partial<SetupInput> = {}): SetupInput => ({
  creating: false,
  createError: null,
  session: session(),
  device: null,
  status: null,
  config: null,
  candidateCount: 0,
  suspended: false,
  now: NOW,
  ...over,
});

const pairedInput = (over: Partial<SetupInput> = {}) =>
  base({ session: session({ status: "approved", openedAt: PAIRED_AT - 10_000, approvedAt: PAIRED_AT, deviceId: DEVICE_ID }), device: device(), config: { enabled: true, deviceId: DEVICE_ID }, ...over });

const states = (input: SetupInput): StepState[] => deriveSetupProgress(input).steps.map((s) => s.state);

describe("deriveSetupProgress — pairing", () => {
  it("shows a loading QR step while the session is being created", () => {
    expect(states(base({ creating: true, session: null }))).toEqual(["active", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });

  it("a fresh QR is ready and waits for the app — a camera scan alone never advances it", () => {
    const progress = deriveSetupProgress(base());
    expect(progress.phase).toBe("pairing");
    expect(progress.steps.map((s) => s.state).slice(0, 3)).toEqual(["done", "active", "upcoming"]);
    expect(progress.steps[1]!.detail).toMatch(/Scanning alone doesn't count/);
  });

  it("marks the app step done only when the function recorded the app opening the code", () => {
    const opened = deriveSetupProgress(base({ session: session({ status: "opened", openedAt: NOW - 5000 }) }));
    expect(opened.steps[1]).toMatchObject({ state: "done", at: NOW - 5000 });
    expect(opened.steps[2]).toMatchObject({ state: "active" });
    expect(opened.steps[2]!.detail).toMatch(/Approve/);
  });

  it("expires an unapproved code at its deadline", () => {
    const s = session({ status: "opened", openedAt: NOW - 60_000 });
    expect(states(base({ session: s, now: s.expiresAt }))[0]).toBe("expired");
    expect(states(base({ session: s, now: s.expiresAt - 1 }))[0]).toBe("done");
  });

  it("reports a phone signed in to the wrong account", () => {
    const progress = deriveSetupProgress(base({ session: session({ rejectedAttempts: 1 }) }));
    expect(progress.steps[1]!.state).toBe("failed");
    expect(progress.steps[1]!.detail).toMatch(/different FlowFi account/);
  });

  it("reports a pairing canceled on the phone, and a superseded code", () => {
    const canceled = deriveSetupProgress(base({ session: session({ status: "canceled", canceledBy: "phone" }) }));
    expect(canceled.steps[0]).toMatchObject({ state: "failed" });
    expect(canceled.steps[0]!.detail).toMatch(/canceled on your phone/);
    expect(states(base({ session: session({ status: "superseded" }) }))[0]).toBe("expired");
  });

  it("maps creation failures to specific messages", () => {
    expect(deriveSetupProgress(base({ session: null, createError: "sync_suspended" })).steps[0]!.detail).toMatch(/paused/);
    expect(deriveSetupProgress(base({ session: null, createError: "offline" })).steps[0]!.detail).toMatch(/offline/);
    expect(deriveSetupProgress(base({ session: null, createError: "weird" })).steps[0]).toMatchObject({ state: "failed" });
  });

  it("an approved session isn't 'paired' until the device record and the upload switch both agree", () => {
    const approvedOnly = base({ session: session({ status: "approved", openedAt: NOW - 9000, approvedAt: NOW - 1000, deviceId: DEVICE_ID }) });
    expect(deriveSetupProgress(approvedOnly).paired).toBe(false);
    expect(states(approvedOnly)[2]).toBe("active");

    const switchOff = pairedInput({ config: { enabled: false, deviceId: DEVICE_ID } });
    expect(deriveSetupProgress(switchOff).paired).toBe(false);

    const otherDevice = pairedInput({ config: { enabled: true, deviceId: "another" } });
    expect(deriveSetupProgress(otherDevice).paired).toBe(false);

    const revoked = pairedInput({ device: device({ status: "revoked" }) });
    expect(deriveSetupProgress(revoked).paired).toBe(false);
  });
});

describe("deriveSetupProgress — after pairing", () => {
  it("waits for the phone's first report", () => {
    const progress = deriveSetupProgress(pairedInput());
    expect(progress.paired).toBe(true);
    expect(progress.phase).toBe("setup");
    expect(progress.steps.map((s) => s.state)).toEqual(["done", "done", "done", "active", "upcoming", "upcoming", "upcoming"]);
  });

  it("ignores a report made before this pairing (it may describe an earlier setup)", () => {
    expect(states(pairedInput({ status: report({ reportedAt: PAIRED_AT - 1 }) }))[3]).toBe("active");
  });

  it("permission denied and permanently denied are failures with a fix", () => {
    const denied = deriveSetupProgress(pairedInput({ status: report({ smsPermission: "denied" }) }));
    expect(denied.steps[3]).toMatchObject({ state: "failed" });
    expect(denied.steps[3]!.detail).toMatch(/Allow SMS access/);
    const blocked = deriveSetupProgress(pairedInput({ status: report({ smsPermission: "permanentlyDenied" }) }));
    expect(blocked.steps[3]!.detail).toMatch(/Settings/);
    expect(deriveSetupProgress(pairedInput({ status: report({ smsPermission: "unsupported" }) })).steps[3]!.state).toBe("failed");
  });

  it("Auto Sync needs both the phone toggle and the phone's gate seeing Cloud Sync enabled", () => {
    expect(states(pairedInput({ status: report({ autoSyncEnabled: false }) }))[4]).toBe("active");
    expect(states(pairedInput({ status: report({ cloudSync: "disabled" }) }))[4]).toBe("active");
    expect(states(pairedInput({ status: report({ cloudSync: null }) }))[4]).toBe("active");
    expect(states(pairedInput({ status: report({ cloudSync: "unverified" }) }))[4]).toBe("failed");
  });

  it("the first scan must be after pairing and successful", () => {
    expect(states(pairedInput({ status: report({ lastScanAt: PAIRED_AT - 1 }) }))[5]).toBe("active");
    expect(states(pairedInput({ status: report({ lastScanOutcome: "failed" }) }))[5]).toBe("failed");
    expect(states(pairedInput({ status: report({ lastScanOutcome: "permission" }) }))[5]).toBe("failed");
  });

  it("is complete once scanned, waiting for alerts when none are eligible yet", () => {
    const progress = deriveSetupProgress(pairedInput({ status: report() }));
    expect(progress.phase).toBe("complete");
    expect(progress.steps[6]).toMatchObject({ state: "active" });
    expect(progress.steps[6]!.detail).toMatch(/no new eligible/);
  });

  it("counts only real candidate documents", () => {
    const progress = deriveSetupProgress(pairedInput({ status: report({ lastUploadedCount: 5 }), candidateCount: 2 }));
    expect(progress.steps[6]).toMatchObject({ state: "done", detail: "2 candidates waiting for your review." });
    expect(progress.currentIndex).toBe(7);
  });

  it("surfaces a failed upload after pairing", () => {
    expect(states(pairedInput({ status: report({ lastUploadOutcome: "failed" }) }))[6]).toBe("failed");
  });

  it("passes through earlier unlinked messages without claiming them", () => {
    expect(deriveSetupProgress(pairedInput({ status: report({ pendingNotOwnedCount: 12 }) })).pendingNotOwnedCount).toBe(12);
  });

  it("flags a stale phone report", () => {
    const reportedAt = PAIRED_AT + 1000;
    expect(deriveSetupProgress(pairedInput({ status: report({ reportedAt }), now: reportedAt + STALE_REPORT_MS + 1 })).staleReport).toBe(true);
    expect(deriveSetupProgress(pairedInput({ status: report({ reportedAt }), now: reportedAt + 60_000 })).staleReport).toBe(false);
  });

  it("an operator suspension overrides every other phase", () => {
    expect(deriveSetupProgress(pairedInput({ status: report(), suspended: true })).phase).toBe("suspended");
    expect(deriveSetupProgress(base({ suspended: true })).phase).toBe("suspended");
  });
});

describe("formatters", () => {
  it("formatRelative", () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 4 * 60_000, NOW)).toBe("4 min ago");
    expect(formatRelative(NOW - 2 * 3_600_000, NOW)).toBe("2 h ago");
    expect(formatRelative(NOW - 26 * 3_600_000, NOW)).toBe("1 day ago");
    expect(formatRelative(NOW + 5000, NOW)).toBe("just now");
  });

  it("formatCountdown", () => {
    expect(formatCountdown(NOW + 9 * 60_000 + 42_000, NOW)).toBe("9:42");
    expect(formatCountdown(NOW + 500, NOW)).toBe("0:01");
    expect(formatCountdown(NOW - 1, NOW)).toBe("0:00");
  });
});
