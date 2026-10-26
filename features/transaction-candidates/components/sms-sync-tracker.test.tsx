// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmsSyncSetup } from "@/hooks/use-sms-sync-setup";
import { summarizePresence, type DevicePresenceView } from "@/lib/sms-pairing/device-presence";
import { deriveSetupProgress, type PairingSessionView, type SetupInput, type SmsDeviceStatusView, type SmsDeviceView } from "@/lib/sms-pairing/setup-progress";
import { SmsPairingGuide } from "./sms-pairing-guide";
import { deriveSyncStages, type StageId } from "./sms-sync-stages";
import { SmsSyncTracker } from "./sms-sync-tracker";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-10-26T10:00:00Z");
const PAIRED_AT = NOW - 3 * 60_000;
const DEVICE_ID = "dev-1";

const session = (over: Partial<PairingSessionView> = {}): PairingSessionView => ({
  status: "pending",
  createdAt: NOW - 60_000,
  expiresAt: NOW + 9 * 60_000,
  openedAt: null,
  approvedAt: null,
  deviceId: null,
  canceledBy: null,
  rejectedAttempts: 0,
  ...over,
});
const device: SmsDeviceView = { deviceId: DEVICE_ID, label: "Samsung SM-S918B", status: "active", pairedAt: PAIRED_AT };
const report = (over: Partial<SmsDeviceStatusView> = {}): SmsDeviceStatusView => ({
  smsPermission: "granted",
  autoSyncEnabled: true,
  cloudSync: "enabled",
  lastScanAt: PAIRED_AT + 10_000,
  lastScanOutcome: "ok",
  lastUploadAt: null,
  lastUploadOutcome: null,
  lastUploadedCount: 0,
  pendingNotOwnedCount: 0,
  reportedAt: PAIRED_AT + 20_000,
  ...over,
});
const presence = (over: Partial<DevicePresenceView> = {}): DevicePresenceView => ({
  deviceId: DEVICE_ID,
  label: "Samsung SM-S918B",
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
  heartbeatAt: NOW - 20_000,
  ...over,
});

function setupOf(input: Partial<SetupInput>, p: DevicePresenceView | null = null): SmsSyncSetup {
  const full: SetupInput = { creating: false, createError: null, session: null, device: null, status: null, config: null, candidateCount: 0, suspended: false, now: NOW, ...input };
  const progress = deriveSetupProgress(full);
  return {
    loaded: true,
    progress,
    legacyConfigured: false,
    hasPairedDevice: progress.paired,
    pairingAnother: false,
    session: full.session,
    device: full.device,
    status: full.status,
    presence: p,
    presenceSummary: p ? summarizePresence(p, NOW) : null,
    pairingUrl: null,
    creating: false,
    createError: full.createError,
    online: true,
    fromCache: false,
    now: NOW,
    newCode: vi.fn(),
    pairAnother: vi.fn(),
    stopPairingAnother: vi.fn(),
    disconnect: vi.fn(async () => ({ ok: true as const })),
  };
}

const states = (setup: SmsSyncSetup) => Object.fromEntries(deriveSyncStages(setup).map((s) => [s.id, s.state])) as Record<StageId, string>;
const paired = (st: Partial<SmsDeviceStatusView> | null, p: DevicePresenceView | null = null) =>
  setupOf(
    {
      session: session({ status: "approved", openedAt: PAIRED_AT - 5000, approvedAt: PAIRED_AT, deviceId: DEVICE_ID }),
      device,
      config: { enabled: true, deviceId: DEVICE_ID },
      status: st === null ? null : report(st),
    },
    p,
  );

describe("deriveSyncStages — evidence only", () => {
  it("fresh QR, phone never seen: nothing is done and the device stage is current", () => {
    expect(states(setupOf({ session: session() }))).toEqual({ device: "active", permissions: "upcoming", autoSync: "upcoming", pairing: "upcoming", syncing: "upcoming" });
  });

  it("phone heartbeat with SMS allowed and Auto Sync on, unpaired: pairing is next, never 'connected'", () => {
    expect(states(setupOf({ session: session() }, presence({ autoSyncEnabled: true })))).toEqual({
      device: "done",
      permissions: "done",
      autoSync: "done",
      pairing: "active",
      syncing: "upcoming",
    });
  });

  it("an opened code is real progress: pairing waits for Approve on the phone", () => {
    const stages = deriveSyncStages(setupOf({ session: session({ status: "opened", openedAt: NOW - 1000 }) }));
    expect(stages.find((s) => s.id === "device")!.state).toBe("done");
    expect(stages.find((s) => s.id === "pairing")).toMatchObject({ state: "active", caption: "Approve on the phone" });
  });

  it("declined SMS permission is flagged, not skipped", () => {
    expect(states(setupOf({ session: session() }, presence({ smsPermission: "denied" }))).permissions).toBe("failed");
  });

  it("expired code shows on the pairing stage", () => {
    expect(states(setupOf({ session: session({ expiresAt: NOW - 1 }) })).pairing).toBe("expired");
  });

  it("paired but no report yet: permissions current, syncing waits", () => {
    expect(states(paired(null))).toMatchObject({ device: "done", permissions: "active", pairing: "done", syncing: "upcoming" });
  });

  it("paired with a scan after pairing: every stage done", () => {
    expect(Object.values(states(paired({})))).toEqual(["done", "done", "done", "done", "done"]);
  });

  it("a running sync is shown as the current stage with real counts", () => {
    const stage = deriveSyncStages(paired({}, presence({ autoSyncEnabled: true, syncPhase: "uploading", syncTotal: 40, syncDone: 10, syncUpdatedAt: NOW - 1000 }))).find((s) => s.id === "syncing")!;
    expect(stage).toMatchObject({ state: "active", caption: "Uploading 10/40" });
  });

  it("revoked pairing drops back to pairing — no stale connected stage", () => {
    const revoked = setupOf({ session: session(), device: { ...device, status: "revoked" }, config: { enabled: false, deviceId: DEVICE_ID } }, presence({ autoSyncEnabled: false }));
    expect(states(revoked)).toMatchObject({ autoSync: "active", pairing: "upcoming", syncing: "upcoming" });
  });

  it("exactly one stage is current", () => {
    for (const s of [setupOf({ session: session() }), paired(null), paired({ autoSyncEnabled: false }), setupOf({ session: session({ expiresAt: NOW - 1 }) })]) {
      expect(deriveSyncStages(s).filter((x) => x.state === "active" || x.state === "failed" || x.state === "expired")).toHaveLength(1);
    }
  });
});

describe("SmsSyncTracker", () => {
  it("renders five stages with their state, and announces progress", () => {
    render(<SmsSyncTracker stages={deriveSyncStages(paired({ autoSyncEnabled: false }))} />);
    expect(document.querySelectorAll('[data-testid^="sms-stage-"]:not([data-testid="sms-stage-tracker"])')).toHaveLength(5);
    expect(screen.getByTestId("sms-stage-autoSync").getAttribute("data-state")).toBe("active");
    expect(screen.getByTestId("sms-stage-tracker").getAttribute("data-current")).toBe("autoSync");
    expect(screen.getByRole("list", { name: /SMS Sync progress: 3 of 5 done/ })).toBeTruthy();
  });
});

describe("SmsPairingGuide", () => {
  it("demo walks Web QR → Camera → Open FlowFi → Approve → Connected without ever marking a step done", () => {
    vi.useFakeTimers();
    render(<SmsPairingGuide mode="demo" />);
    for (const label of ["Web QR", "Camera", "Open FlowFi", "Approve", "Connected"]) expect(screen.getByText(label)).toBeTruthy();
    const done = () => document.querySelectorAll('[data-testid="sms-pairing-guide"] .bg-primary.text-primary-foreground').length;
    expect(done()).toBe(0);
    act(() => void vi.advanceTimersByTime(1600));
    expect(done()).toBe(0);
  });

  it("opened mode marks only what the backend recorded (scan + open) and points at Approve", () => {
    render(<SmsPairingGuide mode="opened" />);
    expect(screen.getByTestId("sms-pairing-guide").getAttribute("data-mode")).toBe("opened");
    expect(document.querySelectorAll('[data-testid="sms-pairing-guide"] .bg-primary.text-primary-foreground')).toHaveLength(3);
  });
});
