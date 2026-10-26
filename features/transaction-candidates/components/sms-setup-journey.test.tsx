// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmsSyncSetup } from "@/hooks/use-sms-sync-setup";
import {
  deriveSetupProgress,
  type PairingSessionView,
  type SetupInput,
  type SmsDeviceStatusView,
  type SmsDeviceView,
} from "@/lib/sms-pairing/setup-progress";
import { summarizePresence, type DevicePresenceView } from "@/lib/sms-pairing/device-presence";
import { SmsSetupJourney } from "./sms-setup-journey";

vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
type ReleaseMock = { status: "loading" | "unavailable" | "error" } | { status: "ready"; release: { version: string; sizeBytes: number; url: string } };
let mockRelease: ReleaseMock = { status: "unavailable" };
const retryRelease = vi.fn();
vi.mock("@/hooks/use-android-release", () => ({ useAndroidRelease: () => ({ ...mockRelease, retry: retryRelease }) }));
// The illustration is decorative and loops on timers; its own markup isn't under test.
vi.mock("./sms-flow-illustration", () => ({ SmsFlowIllustration: () => <div data-testid="sms-flow-illustration" /> }));
// Plain markup stand-in for the Radix dialog — this suite is about the journey, not the dialog.
vi.mock("@/components/finance", () => ({
  ConfirmDialog: ({ open, title, onConfirm, confirmLabel }: { open: boolean; title: string; onConfirm: () => void; confirmLabel: string }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

afterEach(() => {
  cleanup();
  mockRelease = { status: "unavailable" };
});

const NOW = Date.parse("2026-10-25T10:05:00Z");
const PAIRED_AT = NOW - 3 * 60_000;
const DEVICE_ID = "0b5a3f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

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
const device: SmsDeviceView = { deviceId: DEVICE_ID, label: "Pixel 8", status: "active", pairedAt: PAIRED_AT };
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

function fakeSetup(input: Partial<SetupInput>, over: Partial<SmsSyncSetup> = {}): SmsSyncSetup {
  const full: SetupInput = { creating: false, createError: null, session: null, device: null, status: null, config: null, candidateCount: 0, suspended: false, now: NOW, ...input };
  const progress = deriveSetupProgress(full);
  const open = full.session && (full.session.status === "pending" || full.session.status === "opened") && NOW < full.session.expiresAt;
  return {
    loaded: true,
    progress,
    legacyConfigured: false,
    hasPairedDevice: progress.paired,
    pairingAnother: false,
    session: full.session,
    presence: null,
    presenceSummary: null,
    device: full.device,
    status: full.status,
    pairingUrl: open ? `https://flowfi.example/pair/?t=${TOKEN}` : null,
    creating: full.creating,
    createError: full.createError,
    online: true,
    fromCache: false,
    now: NOW,
    newCode: vi.fn(),
    pairAnother: vi.fn(),
    stopPairingAnother: vi.fn(),
    disconnect: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

const paired = (statusOver?: Partial<SmsDeviceStatusView> | null, over: Partial<SmsSyncSetup> = {}) =>
  fakeSetup(
    {
      session: session({ status: "approved", openedAt: PAIRED_AT - 5000, approvedAt: PAIRED_AT, deviceId: DEVICE_ID }),
      device,
      config: { enabled: true, deviceId: DEVICE_ID },
      status: statusOver === null ? null : report(statusOver),
    },
    over,
  );

const stepState = (id: string) => screen.getByTestId(`sms-setup-step-${id}`).getAttribute("data-state");
const phaseState = (id: string) => screen.getByTestId(`sms-phase-${id}`).getAttribute("data-state");
const FORBIDDEN = /\b(is online|is connected|connected now|currently syncing|syncing now|installed)\b/i;

describe("SmsSetupJourney — pairing", () => {
  it("one panel: intro, illustration and the single-use QR with a live countdown; all seven steps tracked under three phases", () => {
    render(<SmsSetupJourney setup={fakeSetup({ session: session() })} />);
    expect(screen.getByTestId("sms-connect-panel")).toBeTruthy();
    expect(screen.getByTestId("sms-setup-journey").getAttribute("data-mode")).toBe("connect");
    expect(screen.getByRole("heading", { name: "Connect your phone" })).toBeTruthy();
    expect(screen.getByTestId("sms-flow-illustration")).toBeTruthy();
    expect(screen.getByTestId("sms-pairing-qr")).toBeTruthy();
    expect(screen.getByText("Scan with your phone")).toBeTruthy();
    expect(screen.getByText("9:00")).toBeTruthy();
    expect(document.querySelectorAll('[data-testid^="sms-setup-step-"]')).toHaveLength(7);
    expect(document.querySelectorAll('[data-testid^="sms-phase-"]')).toHaveLength(3);
    expect(stepState("qr")).toBe("done");
    expect(stepState("app")).toBe("active");
    expect(phaseState("connect")).toBe("active");
    expect(phaseState("approve")).toBe("upcoming");
    expect(screen.getByTestId("sms-live-status").textContent).toMatch(/Scanning alone doesn't count/);
  });

  it("has no duplicated setup sections: one QR, one progress strip, one help disclosure", () => {
    render(<SmsSetupJourney setup={fakeSetup({ session: session() })} />);
    expect(screen.getAllByTestId("sms-pairing-qr")).toHaveLength(1);
    expect(screen.getAllByTestId("sms-setup-phases")).toHaveLength(1);
    const help = screen.getByRole("button", { name: /How pairing works/ });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking New code never advances any phase by itself", () => {
    const setup = fakeSetup({ session: session() });
    render(<SmsSetupJourney setup={setup} />);
    const before = [...document.querySelectorAll("[data-state]")].map((el) => el.getAttribute("data-state"));
    fireEvent.click(screen.getByRole("button", { name: /New code/ }));
    expect(setup.newCode).toHaveBeenCalledOnce();
    expect([...document.querySelectorAll("[data-state]")].map((el) => el.getAttribute("data-state"))).toEqual(before);
  });

  it("a revoked previous phone gets a clear recovery message alongside a fresh code", () => {
    const setup = fakeSetup({ session: session(), device: { ...device, status: "revoked" }, config: { enabled: false, deviceId: DEVICE_ID } });
    render(<SmsSetupJourney setup={setup} />);
    expect(screen.getByTestId("sms-setup-journey").getAttribute("data-mode")).toBe("connect");
    expect(screen.getByTestId("sms-setup-former-device").textContent).toMatch(/Pixel 8 was disconnected.*Scan a new code/);
    expect(screen.getByTestId("sms-pairing-qr")).toBeTruthy();
  });

  it("marks the QR as opened on the phone once the backend recorded it", () => {
    render(<SmsSetupJourney setup={fakeSetup({ session: session({ status: "opened", openedAt: NOW - 2000 }) })} />);
    expect(screen.getByText("Opened on phone")).toBeTruthy();
    expect(stepState("app")).toBe("done");
    expect(stepState("paired")).toBe("active");
  });

  it("an expired code removes the QR and offers a new one", () => {
    const setup = fakeSetup({ session: session({ expiresAt: NOW - 1 }) });
    render(<SmsSetupJourney setup={setup} />);
    expect(screen.queryByTestId("sms-pairing-qr")).toBeNull();
    expect(screen.getByText("Code expired")).toBeTruthy();
    expect(stepState("qr")).toBe("expired");
    expect(phaseState("connect")).toBe("expired");
    expect(screen.queryByText(/expires in/)).toBeNull();
    const newCode = screen.getByRole("button", { name: /New code/ });
    expect(newCode.className).toMatch(/bg-primary/);
    fireEvent.click(newCode);
    expect(setup.newCode).toHaveBeenCalledOnce();
  });

  it("an opened code asks for approval on the phone", () => {
    render(<SmsSetupJourney setup={fakeSetup({ session: session({ status: "opened", openedAt: NOW - 2000 }) })} />);
    expect(screen.getByText("Approve on your phone")).toBeTruthy();
    expect(screen.getByTestId("sms-live-status").textContent).toMatch(/tap Approve/);
  });

  describe("Android download comes from the published manifest", () => {
    it("ready: links to the real APK with its version and size", () => {
      mockRelease = { status: "ready", release: { version: "1.0.0", sizeBytes: 140964073, url: "https://flowfi.example/downloads/flowfi-android-1.0.0.apk" } };
      render(<SmsSetupJourney setup={fakeSetup({ session: session() })} />);
      const link = screen.getByTestId("sms-download-apk");
      expect(link.getAttribute("href")).toBe("https://flowfi.example/downloads/flowfi-android-1.0.0.apk");
      expect(screen.getByTestId("sms-download-hint").textContent).toMatch(/v1\.0\.0 · 134 MB/);
      expect(screen.getByTestId("sms-setup-journey").textContent).not.toMatch(/isn't published/);
    });

    it("loading: says it's checking, with no link and no 'unavailable' claim", () => {
      mockRelease = { status: "loading" };
      render(<SmsSetupJourney setup={fakeSetup({ session: session() })} />);
      expect(screen.getByTestId("sms-download-hint").textContent).toMatch(/Checking for the Android app/);
      expect(screen.queryByTestId("sms-download-apk")).toBeNull();
    });

    it("network error: offers a retry instead of claiming the release is missing", () => {
      mockRelease = { status: "error" };
      render(<SmsSetupJourney setup={fakeSetup({ session: session() })} />);
      expect(screen.getByTestId("sms-download-hint").textContent).not.toMatch(/isn't available/);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(retryRelease).toHaveBeenCalled();
    });

    it("unavailable: says so, and that an installed app still opens from the code", () => {
      mockRelease = { status: "unavailable" };
      render(<SmsSetupJourney setup={fakeSetup({ session: session() })} />);
      expect(screen.getByTestId("sms-download-hint").textContent).toMatch(/isn't available.*scanning opens it/);
    });

    it("isn't offered once a phone is paired and set up", () => {
      mockRelease = { status: "ready", release: { version: "1.0.0", sizeBytes: 1, url: "https://flowfi.example/downloads/flowfi-android.apk" } };
      render(<SmsSetupJourney setup={paired({})} />);
      expect(screen.queryByTestId("sms-download-hint")).toBeNull();
    });
  });

  it("shows a creation failure and the paused state", () => {
    render(<SmsSetupJourney setup={fakeSetup({ createError: "sync_suspended", suspended: true })} />);
    expect(stepState("qr")).toBe("failed");
    expect(screen.getByTestId("sms-setup-suspended")).toBeTruthy();
  });

  it("warns about offline and disables creating a new code", () => {
    render(<SmsSetupJourney setup={fakeSetup({ session: session() }, { online: false })} />);
    expect(screen.getByTestId("sms-setup-offline")).toBeTruthy();
    expect((screen.getByRole("button", { name: /New code/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says 'No SMS candidates' exactly once while connecting", () => {
    render(<SmsSetupJourney setup={fakeSetup({ session: session() })} />);
    expect(screen.getAllByText(/No SMS candidates/)).toHaveLength(1);
  });
});

describe("SmsSetupJourney — paired", () => {
  it("names the paired phone with when it paired and last reported, and follows the phone's reports", () => {
    render(<SmsSetupJourney setup={paired({ autoSyncEnabled: false })} />);
    const card = screen.getByTestId("sms-paired-device");
    expect(within(card).getByText("Pixel 8")).toBeTruthy();
    expect(within(card).getByText("Paired 3 min ago")).toBeTruthy();
    expect(within(card).getByText(/Last report from the phone/)).toBeTruthy();
    expect(stepState("permission")).toBe("done");
    expect(stepState("autoSync")).toBe("active");
    expect(screen.queryByTestId("sms-pairing-qr")).toBeNull();
  });

  it("before any report it says so instead of guessing", () => {
    render(<SmsSetupJourney setup={paired(null)} />);
    expect(screen.getByText("No report from the phone yet")).toBeTruthy();
    expect(stepState("permission")).toBe("active");
  });

  it("paired but waiting on the phone: compact device + next action, no QR and no intro illustration", () => {
    render(<SmsSetupJourney setup={paired({ autoSyncEnabled: false })} />);
    expect(screen.getByTestId("sms-setup-journey").getAttribute("data-mode")).toBe("setup");
    expect(screen.queryByTestId("sms-flow-illustration")).toBeNull();
    expect(screen.getByTestId("sms-next-action").getAttribute("data-step")).toBe("autoSync");
    expect(screen.getByText("Turn on SMS Auto Sync")).toBeTruthy();
    expect(phaseState("connect")).toBe("done");
    expect(phaseState("approve")).toBe("active");
    expect(phaseState("review")).toBe("upcoming");
  });

  it("a declined SMS permission is shown as action required with the fix", () => {
    render(<SmsSetupJourney setup={paired({ smsPermission: "denied" })} />);
    expect(stepState("permission")).toBe("failed");
    expect(phaseState("approve")).toBe("failed");
    expect(screen.getByText("Action required")).toBeTruthy();
    expect(screen.getByText("SMS access needs your attention")).toBeTruthy();
    expect(screen.getByText(/declined on the phone/)).toBeTruthy();
  });

  it("an unsupported build points at the published Android download", () => {
    mockRelease = { status: "ready", release: { version: "1.0.0", sizeBytes: 1, url: "https://flowfi.example/downloads/flowfi-android.apk" } };
    render(<SmsSetupJourney setup={paired({ smsPermission: "unsupported" })} />);
    expect(within(screen.getByTestId("sms-next-action")).getByTestId("sms-download-apk")).toBeTruthy();
  });

  it("complete setup says there are no candidates yet, and points at unlinked earlier messages without claiming them", () => {
    render(<SmsSetupJourney setup={paired({ pendingNotOwnedCount: 4 })} />);
    expect(screen.getByTestId("sms-setup-journey").getAttribute("data-phase")).toBe("complete");
    expect(screen.getByTestId("sms-setup-journey").getAttribute("data-mode")).toBe("complete");
    expect(screen.getAllByText(/No SMS candidates/)).toHaveLength(1);
    expect(screen.queryByTestId("sms-pairing-qr")).toBeNull();
    // The last step waits for real candidate documents, so Review is never shown as done without them.
    expect(stepState("candidates")).toBe("active");
    expect(phaseState("review")).toBe("active");
    expect(screen.getByTestId("sms-setup-unlinked").textContent).toMatch(/4 earlier messages are still only on your phone/);
    expect(screen.getByTestId("sms-setup-unlinked").textContent).toMatch(/Link earlier messages/);
  });

  it("flags a stale report", () => {
    // A report from before pairing is ignored entirely, so pairing here is older than the report.
    const old = fakeSetup({
      session: null,
      device: { ...device, pairedAt: NOW - 5 * 3_600_000 },
      config: { enabled: true, deviceId: DEVICE_ID },
      status: report({ reportedAt: NOW - 3 * 3_600_000, lastScanAt: NOW - 3 * 3_600_000 }),
    });
    render(<SmsSetupJourney setup={old} />);
    expect(screen.getByTestId("sms-setup-stale").textContent).toMatch(/3 h ago/);
  });

  it("disconnect asks for confirmation, then revokes", async () => {
    const setup = paired({});
    render(<SmsSetupJourney setup={setup} />);
    fireEvent.click(screen.getByRole("button", { name: /^Disconnect$/ }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Pixel 8?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await vi.waitFor(() => expect(setup.disconnect).toHaveBeenCalledOnce());
  });

  it("offers pairing a different phone", () => {
    const setup = paired({});
    render(<SmsSetupJourney setup={setup} />);
    fireEvent.click(screen.getByRole("button", { name: /Pair a different phone/ }));
    expect(setup.pairAnother).toHaveBeenCalledOnce();
  });

  it("never claims the phone is online, connected, installed or syncing — in any state", () => {
    const states = [fakeSetup({ session: session() }), fakeSetup({ session: session({ status: "opened", openedAt: NOW }) }), paired(null), paired({}), paired({ cloudSync: "unverified" })];
    for (const setup of states) {
      const { unmount } = render(<SmsSetupJourney setup={setup} />);
      expect(screen.getByTestId("sms-setup-journey").textContent).not.toMatch(FORBIDDEN);
      unmount();
    }
  });
});

describe("live phone presence", () => {
  const presence = (over: Partial<DevicePresenceView> = {}): DevicePresenceView => ({
    deviceId: "dev-1",
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
  const withPresence = (p: DevicePresenceView, over: Partial<SmsSyncSetup> = {}) => fakeSetup({}, { presence: p, presenceSummary: summarizePresence(p, NOW), ...over });

  it("before pairing, shows the real phone with separate online / permission / Auto Sync / pairing facts", () => {
    render(<SmsSetupJourney setup={withPresence(presence())} />);
    expect(screen.getByTestId("sms-live-reachability").textContent).toBe("Online");
    expect(screen.getByTestId("sms-live-sms").getAttribute("data-tone")).toBe("ok");
    expect(screen.getByTestId("sms-live-autoSync").textContent).toContain("Off");
    expect(screen.getByTestId("sms-live-paired").textContent).toContain("Not paired");
    expect(screen.queryByTestId("sms-flow-illustration")).toBeNull();
  });

  it("an old foreground heartbeat is offline, not online", () => {
    render(<SmsSetupJourney setup={withPresence(presence({ heartbeatAt: NOW - 10 * 60_000 }))} />);
    expect(screen.getByTestId("sms-live-device").getAttribute("data-reachability")).toBe("offline");
    expect(screen.getByTestId("sms-live-reachability").textContent).toContain("last seen 10 min ago");
  });

  it("shows a determinate bar only when the phone reported a total", () => {
    const { unmount } = render(<SmsSetupJourney setup={withPresence(presence({ syncPhase: "uploading", syncTotal: 40, syncDone: 10, syncUploaded: 9, syncSkipped: 1, syncUpdatedAt: NOW - 1000 }))} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByTestId("sms-live-sync").textContent).toContain("Uploading 10/40");
    unmount();
    render(<SmsSetupJourney setup={withPresence(presence({ syncPhase: "scanning", syncUpdatedAt: NOW - 1000 }))} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });
});
