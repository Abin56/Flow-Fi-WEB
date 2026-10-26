import { describe, expect, it } from "vitest";
import { pickPresence, summarizePresence, type DevicePresenceView } from "./device-presence";

const NOW = Date.parse("2026-10-25T10:00:00Z");
const base: DevicePresenceView = {
  deviceId: "a",
  label: "Phone",
  appVersion: null,
  appState: "foreground",
  smsPermission: "granted",
  notificationAccess: "unknown",
  autoSyncEnabled: true,
  syncPhase: "idle",
  syncTotal: null,
  syncDone: 0,
  syncUploaded: 0,
  syncSkipped: 0,
  syncFailed: 0,
  syncUpdatedAt: null,
  lastSyncAt: null,
  heartbeatAt: NOW - 30_000,
};

describe("summarizePresence", () => {
  it("fresh foreground heartbeat = online; stale = offline; background = background until it ages out", () => {
    expect(summarizePresence(base, NOW).reachability).toBe("online");
    expect(summarizePresence({ ...base, heartbeatAt: NOW - 200_000 }, NOW).reachability).toBe("offline");
    expect(summarizePresence({ ...base, appState: "background", heartbeatAt: NOW - 10 * 60_000 }, NOW).reachability).toBe("background");
    expect(summarizePresence({ ...base, appState: "background", heartbeatAt: NOW - 60 * 60_000 }, NOW).reachability).toBe("offline");
    expect(summarizePresence({ ...base, heartbeatAt: null }, NOW).reachability).toBe("offline");
  });

  it("a running sync that stopped updating is not shown as running; fraction needs a real total", () => {
    expect(summarizePresence({ ...base, syncPhase: "uploading", syncUpdatedAt: NOW - 10 * 60_000 }, NOW)).toMatchObject({ syncRunning: false, syncPhase: "idle" });
    expect(summarizePresence({ ...base, syncPhase: "uploading", syncUpdatedAt: NOW, syncTotal: 4, syncDone: 1 }, NOW).syncFraction).toBe(0.25);
    expect(summarizePresence({ ...base, syncPhase: "uploading", syncUpdatedAt: NOW }, NOW).syncFraction).toBeNull();
  });
});

describe("pickPresence", () => {
  it("prefers the paired device, else the most recently heard-from install", () => {
    const b = { ...base, deviceId: "b", heartbeatAt: NOW };
    expect(pickPresence([base, b], "a")?.deviceId).toBe("a");
    expect(pickPresence([base, b], null)?.deviceId).toBe("b");
    expect(pickPresence([], null)).toBeNull();
  });
});
