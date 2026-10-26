import { describe, expect, it } from "vitest";
import { codeLikelyExpired, formatApkSize, PAIRING_CODE_LIFETIME_MS, parseAndroidRelease } from "./android-release";

const SHA = "a".repeat(64);
const valid = { version: "1.0.0", versionCode: 1, sha256: SHA, sizeBytes: 90 * 1024 * 1024, file: "flowfi-android-1.0.0.apk", publishedAt: "2026-10-25T12:00:00Z" };

describe("android release manifest", () => {
  it("resolves the APK next to the manifest on this site's own origin", () => {
    expect(parseAndroidRelease(valid, "https://flowfi.web.app/")).toEqual({
      version: "1.0.0",
      versionCode: 1,
      sha256: SHA,
      sizeBytes: 90 * 1024 * 1024,
      url: "https://flowfi.web.app/downloads/flowfi-android-1.0.0.apk",
      publishedAt: "2026-10-25T12:00:00Z",
    });
  });

  it("accepts the stable 'latest' file name", () => {
    expect(parseAndroidRelease({ ...valid, file: "flowfi-android.apk" }, "https://x.test")?.url).toBe("https://x.test/downloads/flowfi-android.apk");
  });

  it.each([
    ["not an object", null],
    ["a missing checksum", { ...valid, sha256: undefined }],
    ["a malformed checksum", { ...valid, sha256: "abc" }],
    ["an upper-case/non-hex checksum", { ...valid, sha256: "Z".repeat(64) }],
    ["a zero size", { ...valid, sizeBytes: 0 }],
    ["a bad version code", { ...valid, versionCode: 0 }],
    ["an external URL as the file", { ...valid, file: "https://evil.example/app.apk" }],
    ["a path traversal", { ...valid, file: "../flowfi-android.apk" }],
    ["a non-apk file", { ...valid, file: "flowfi-android.html" }],
  ])("returns null for %s", (_label, raw) => {
    expect(parseAndroidRelease(raw, "https://flowfi.web.app")).toBeNull();
  });

  it("formats the size and estimates code expiry without claiming certainty", () => {
    expect(formatApkSize(90 * 1024 * 1024)).toBe("90 MB");
    expect(codeLikelyExpired(0, PAIRING_CODE_LIFETIME_MS - 1)).toBe(false);
    expect(codeLikelyExpired(0, PAIRING_CODE_LIFETIME_MS)).toBe(true);
  });
});
