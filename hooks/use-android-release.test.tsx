// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAndroidRelease } from "./use-android-release";

const MANIFEST = {
  version: "1.0.0",
  versionCode: 1,
  sha256: "087c0c1d74f845b6fb5d4e2e03b7d53ad6fc1f5ed775971f054f8c80f14cc843",
  sizeBytes: 140964073,
  file: "flowfi-android-1.0.0.apk",
  publishedAt: "2026-10-25T11:56:03.152Z",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

afterEach(() => vi.unstubAllGlobals());

describe("useAndroidRelease", () => {
  it("reads the published manifest from this site and resolves the APK next to it", async () => {
    const fetchMock = vi.fn(async () => json(MANIFEST));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAndroidRelease());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith("/downloads/flowfi-android.json", expect.objectContaining({ cache: "no-store" }));
    if (result.current.status !== "ready") throw new Error("not ready");
    expect(result.current.release.url).toBe(`${window.location.origin}/downloads/flowfi-android-1.0.0.apk`);
  });

  it("a missing manifest (404 page) is 'unavailable'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } })));
    const { result } = renderHook(() => useAndroidRelease());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("a malformed manifest is 'unavailable', never a guessed link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...MANIFEST, file: "../evil.apk" })));
    const { result } = renderHook(() => useAndroidRelease());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("a network failure is 'error' — distinct from unavailable — and retry fetches again", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(json(MANIFEST));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAndroidRelease());
    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
