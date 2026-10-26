import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_PACKAGE, parseBadging, parseSignerOutput, releaseHashMismatches, sha256File } from "./android-release.mjs";

const debugSigner = `Verifies
Verified using v1 scheme (JAR signing): true
Verified using v2 scheme (APK Signature Scheme v2): true
Number of signers: 1
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
Signer #1 certificate SHA-256 digest: ${"a".repeat(64)}`;
const releaseSigner = debugSigner.replace("CN=Android Debug", "CN=FlowFi, O=FlowFi").replace("a".repeat(64), "c".repeat(64));

describe("android release guard", () => {
  it("recognises the Android debug certificate so it can never be published", () => {
    expect(parseSignerOutput(debugSigner)).toMatchObject({ verified: true, v2plus: true, isDebug: true });
  });

  it("accepts a non-debug v2-signed certificate and reads its fingerprint", () => {
    expect(parseSignerOutput(releaseSigner)).toMatchObject({ verified: true, v2plus: true, isDebug: false, sha256: "c".repeat(64) });
  });

  it("treats a v1-only signature as not good enough", () => {
    expect(parseSignerOutput(debugSigner.replace(/Verified using v2.*\n/, "")).v2plus).toBe(false);
  });

  it("reads package, version and the READ_SMS permission from aapt output", () => {
    const badging = `package: name='com.flowfi.app' versionCode='7' versionName='1.2.0' platformBuildVersionName='16'
uses-permission: name='android.permission.READ_SMS'
uses-permission: name='android.permission.INTERNET'`;
    expect(parseBadging(badging)).toEqual({ packageName: EXPECTED_PACKAGE, versionCode: 7, versionName: "1.2.0", readSms: true });
    expect(parseBadging("package: name='com.other' versionCode='1' versionName='1'").readSms).toBe(false);
  });

  it("refuses a latest-APK alias that is a different build from the manifest's versioned APK", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowfi-release-"));
    try {
      writeFileSync(join(dir, "flowfi-android-1.0.1.apk"), "build-1.0.1");
      writeFileSync(join(dir, "flowfi-android.apk"), "build-1.0.1");
      const manifest = { file: "flowfi-android-1.0.1.apk", sha256: sha256File(join(dir, "flowfi-android-1.0.1.apk")) };
      expect(releaseHashMismatches(dir, manifest)).toEqual([]);

      writeFileSync(join(dir, "flowfi-android.apk"), "build-1.0.0");
      expect(releaseHashMismatches(dir, manifest)).toEqual(["flowfi-android.apk"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
