// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairLanding } from "./pair-landing";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const SHA = "b".repeat(64);
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/130";
let search = "";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const manifest = { version: "1.0.0", versionCode: 1, sha256: SHA, sizeBytes: 95 * 1024 * 1024, file: "flowfi-android-1.0.0.apk", publishedAt: "2026-10-25T12:00:00Z" };

function stubManifest(body: unknown | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body === null
        ? new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } })
        : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
}

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

function open(query: string) {
  search = query;
  window.history.replaceState({}, "", `/pair/?${query}`);
  return render(<PairLanding />);
}

const currentStep = () => screen.getByTestId("pair-steps").querySelector('[aria-current="step"]')?.textContent;

beforeEach(() => {
  window.sessionStorage.clear();
  setUserAgent(ANDROID_UA);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("/pair landing", () => {
  it("offers the published signed download as the primary action, with version, size and checksum", async () => {
    stubManifest(manifest);
    open(`t=${TOKEN}`);

    const download = await screen.findByTestId("pair-download-apk");
    expect(download.getAttribute("href")).toBe(`${window.location.origin}/downloads/flowfi-android-1.0.0.apk`);
    expect(download.textContent).toContain("Download FlowFi");
    expect(download.className).toContain("bg-primary");
    expect(screen.getByTestId("pair-open-app").className).not.toContain("bg-primary ");
    expect(screen.getByRole("heading", { name: "Connect your phone" })).toBeTruthy();
    expect(screen.getByText(/v1\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/95 MB/)).toBeTruthy();

    const checksum = screen.getByRole("button", { name: /SHA-256/ });
    expect(checksum.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(checksum);
    expect(checksum.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("pair-sha256").textContent).toBe(SHA);
  });

  it("keeps the one-time code in both app hand-off links (intent with fallback back to this page)", async () => {
    stubManifest(manifest);
    open(`t=${TOKEN}`);

    const href = (await screen.findByTestId("pair-open-app")).getAttribute("href")!;
    expect(href.startsWith(`intent://app/pair?t=${TOKEN}#Intent;scheme=flowfi;package=com.flowfi.app;`)).toBe(true);
    const fallback = decodeURIComponent(/S\.browser_fallback_url=([^;]+);end$/.exec(href)![1]);
    const back = new URL(fallback);
    expect(back.pathname).toBe("/pair/");
    expect(back.searchParams.get("t")).toBe(TOKEN);
    expect(back.searchParams.get("missing")).toBe("1");
  });

  it("uses the flowfi:// scheme link off Android, and says SMS Sync needs an Android phone", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605");
    stubManifest(manifest);
    open(`t=${TOKEN}`);

    expect((await screen.findByTestId("pair-open-app")).getAttribute("href")).toBe(`flowfi://app/pair?t=${TOKEN}`);
    expect(screen.getByTestId("pair-not-android").textContent).toMatch(/needs an Android phone/);
  });

  it("keeps Download primary when the app didn't open, without claiming it is not installed", async () => {
    stubManifest(manifest);
    open(`t=${TOKEN}&missing=1`);

    const download = await screen.findByTestId("pair-download-apk");
    const open_ = screen.getByTestId("pair-open-app");
    expect(download.className).toContain("bg-primary");
    expect(open_.className).not.toContain("bg-primary ");
    const hint = screen.getByRole("status");
    expect(hint.textContent).toMatch(/didn.t open\. If it isn.t installed/);
    expect(hint.textContent).not.toMatch(/not installed on this phone\./i);
    expect(hint.textContent).not.toMatch(/doesn.t seem to be installed/i);
  });

  it("never invents a download when nothing is published, and makes Open FlowFi the primary action", async () => {
    stubManifest(null);
    open(`t=${TOKEN}&missing=1`);

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/isn.t published on this site yet/));
    expect(screen.queryByTestId("pair-download-apk")).toBeNull();
    expect(screen.queryByTestId("pair-steps")).toBeNull();
    expect(screen.getByTestId("pair-open-app").className).toContain("bg-primary");
  });

  it("ignores a malformed manifest (e.g. an APK path on another host)", async () => {
    stubManifest({ ...manifest, file: "https://evil.example/flowfi.apk" });
    open(`t=${TOKEN}`);

    await waitFor(() => expect(screen.getByText(/isn.t published on this site yet/)).toBeTruthy());
    expect(screen.queryByTestId("pair-download-apk")).toBeNull();
  });

  it("says a download request is not an installation: the step marker moves on, but no step is ticked off", async () => {
    stubManifest(manifest);
    open(`t=${TOKEN}`);

    await screen.findByTestId("pair-download-apk");
    expect(currentStep()).toMatch(/Download/);
    expect(screen.queryByTestId("pair-download-started")).toBeNull();
    fireEvent.click(screen.getByTestId("pair-download-apk"));

    const note = screen.getByTestId("pair-download-started");
    expect(note.textContent).toMatch(/Downloading doesn.t install FlowFi/);
    expect(note.textContent).toMatch(/Open FlowFi/);
    expect(currentStep()).toMatch(/Install/);
    expect(screen.getByTestId("pair-steps").textContent).not.toMatch(/done|complete|installed|✓/i);
  });

  it("keeps install help collapsed until asked, and never coaches anyone past Play Protect", async () => {
    stubManifest(manifest);
    open(`t=${TOKEN}`);

    const toggle = await screen.findByTestId("pair-install-help-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const help = screen.getByTestId("pair-install-help").textContent!;
    expect(help).toMatch(/install unknown apps/i);
    expect(help).toMatch(/Your code is still in/);
    expect(help).toContain(window.location.host);
    expect(screen.getByTestId("pair-play-protect").textContent).toMatch(/keep Play Protect on/);
    expect(help).not.toMatch(/install anyway|download anyway|turn off play protect|disable play protect|ignore/i);
  });

  it("explains SMS use and when anything is shared", async () => {
    stubManifest(manifest);
    open(`t=${TOKEN}`);
    await screen.findByTestId("pair-download-apk");
    expect(screen.getByText(/SMS access is used only to find bank alerts/).textContent).toMatch(/only after you approve pairing/);
  });

  it("flags a code first seen over 10 minutes ago as probably expired, with a way to get a new one", async () => {
    stubManifest(manifest);
    window.sessionStorage.setItem(`flowfi.pair.firstSeen.${TOKEN.slice(0, 12)}`, String(Date.now() - 11 * 60_000));
    open(`t=${TOKEN}`);

    const banner = await screen.findByTestId("pair-likely-expired");
    expect(banner.textContent).toMatch(/probably expired/);
    expect(banner.textContent).toMatch(/New code/);
  });

  it("does not warn about expiry for a fresh code", async () => {
    stubManifest(manifest);
    open(`t=${TOKEN}`);
    await screen.findByTestId("pair-download-apk");
    expect(screen.queryByTestId("pair-likely-expired")).toBeNull();
  });

  it("rejects a link without a well-formed code and offers the inbox instead of an app hand-off", async () => {
    stubManifest(manifest);
    open("t=short");

    expect(screen.getByText(/pairing link isn.t valid/i)).toBeTruthy();
    expect(screen.queryByTestId("pair-open-app")).toBeNull();
    expect(screen.queryByTestId("pair-download-apk")).toBeNull();
    expect(screen.getByRole("link", { name: /Transaction Inbox/ }).getAttribute("href")).toBe("/transaction-candidates/");
  });
});
