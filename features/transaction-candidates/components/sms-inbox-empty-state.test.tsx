// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsSyncConfigStatus } from "@/hooks/use-sms-sync-config";
import { SmsInboxEmptyState } from "./sms-inbox-empty-state";

let mockStatus: SmsSyncConfigStatus = "loading";
vi.mock("@/hooks/use-sms-sync-config", () => ({ useSmsSyncConfig: () => mockStatus }));
let mockSetup = { loaded: true, hasPairedDevice: false, pairingAnother: false };
vi.mock("@/hooks/use-sms-sync-setup", () => ({ useSmsSyncSetup: () => mockSetup }));
// The panel itself is covered by sms-setup-journey.test.tsx; only which surface renders matters here.
vi.mock("./sms-setup-journey", () => ({ SmsSetupJourney: () => <div data-testid="sms-journey" /> }));

afterEach(cleanup);
beforeEach(() => {
  mockSetup = { loaded: true, hasPairedDevice: false, pairingAnother: false };
});

describe("SmsInboxEmptyState", () => {
  it("first-time setup: shows the one live SMS Sync panel when Cloud Sync is not configured", () => {
    mockStatus = "not-configured";
    render(<SmsInboxEmptyState />);
    expect(screen.getByTestId("sms-journey")).toBeTruthy();
    expect(screen.queryByTestId("sms-cloud-sync-configured")).toBeNull();
  });

  it("a phone paired through QR pairing gets the live panel, not the legacy compact state", () => {
    mockStatus = "configured";
    mockSetup = { loaded: true, hasPairedDevice: true, pairingAnother: false };
    render(<SmsInboxEmptyState />);
    expect(screen.getByTestId("sms-journey")).toBeTruthy();
    expect(screen.queryByTestId("sms-cloud-sync-configured")).toBeNull();
  });

  it("pairing a different phone keeps the live panel", () => {
    mockStatus = "not-configured";
    mockSetup = { loaded: true, hasPairedDevice: false, pairingAnother: true };
    render(<SmsInboxEmptyState />);
    expect(screen.getByTestId("sms-journey")).toBeTruthy();
  });

  it("waits for the pairing records before choosing, so a paired user never sees the connect panel flash", () => {
    mockStatus = "configured";
    mockSetup = { loaded: false, hasPairedDevice: false, pairingAnother: false };
    render(<SmsInboxEmptyState />);
    expect(screen.getByTestId("sms-sync-config-loading")).toBeTruthy();
  });

  it("falls back to the live panel when the config can't be read (never guesses)", () => {
    mockStatus = "unknown";
    render(<SmsInboxEmptyState />);
    expect(screen.getByTestId("sms-journey")).toBeTruthy();
  });

  it("shows a placeholder, not the panel, while the config is loading", () => {
    mockStatus = "loading";
    render(<SmsInboxEmptyState />);
    expect(screen.getByTestId("sms-sync-config-loading")).toBeTruthy();
    expect(screen.queryByTestId("sms-journey")).toBeNull();
    expect(screen.queryByTestId("sms-cloud-sync-configured")).toBeNull();
  });

  describe("Cloud Sync configured (legacy, no pairing record), no candidates", () => {
    it("shows the compact state and says no candidates", () => {
      mockStatus = "configured";
      render(<SmsInboxEmptyState />);
      expect(screen.getByTestId("sms-cloud-sync-configured")).toBeTruthy();
      expect(screen.queryByTestId("sms-journey")).toBeNull();
      expect(screen.getByText("Cloud Sync configured")).toBeTruthy();
      expect(screen.getByText(/No SMS candidates right now/)).toBeTruthy();
    });

    it("never claims the device is connected, online, active or syncing", () => {
      mockStatus = "configured";
      render(<SmsInboxEmptyState />);
      const text = screen.getByTestId("sms-cloud-sync-configured").textContent ?? "";
      expect(text).not.toMatch(/\b(connected to|device (is )?(connected|online|active)|is online|is active|currently syncing|last synced)\b/i);
      expect(text).toMatch(/can't see whether your phone is connected or syncing/i);
    });

    it("explains that SMS captured before sign-in may stay on Android", () => {
      mockStatus = "configured";
      render(<SmsInboxEmptyState />);
      expect(screen.getByText(/Older messages may stay on your phone/)).toBeTruthy();
      expect(screen.getByText(/before you signed in/i)).toBeTruthy();
    });

    it("offers How syncing works and Troubleshoot SMS sync as accessible disclosures", () => {
      mockStatus = "configured";
      render(<SmsInboxEmptyState />);
      const how = screen.getByRole("button", { name: /How syncing works/ });
      const trouble = screen.getByRole("button", { name: /Troubleshoot SMS sync/ });
      expect(how.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(how);
      expect(how.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText(/stores them there first/)).toBeTruthy();

      fireEvent.click(trouble);
      expect(how.getAttribute("aria-expanded")).toBe("false");
      expect(trouble.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText(/Tap Scan now/)).toBeTruthy();
      expect(screen.queryByText(/stores them there first/)).toBeNull();
    });
  });
});
