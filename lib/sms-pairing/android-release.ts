/**
 * The published Android sideload build, described by `/downloads/flowfi-android.json` on this site's own Firebase
 * Hosting (written by `scripts/android-release.mjs`, which also signs-off the APK: release certificate only, package id
 * check, SHA-256). The pairing page reads it at run time, so publishing a new APK never needs a web rebuild, and the
 * download button only appears when a real file is described — nothing here ever invents a URL.
 *
 * `NEXT_PUBLIC_ANDROID_APK_URL` stays a build-time override/fallback for the other onboarding surfaces.
 */

export const ANDROID_RELEASE_MANIFEST_PATH = "/downloads/flowfi-android.json";

export interface AndroidRelease {
  version: string;
  versionCode: number;
  /** Lower-case hex SHA-256 of the APK file. */
  sha256: string;
  sizeBytes: number;
  /** Absolute HTTPS (or same-origin) URL of the APK. */
  url: string;
  publishedAt: string | null;
}

const SAFE_FILE = /^flowfi-android(?:-[0-9A-Za-z.+_-]{1,40})?\.apk$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Returns null for anything that isn't a complete, well-formed manifest — the page then simply offers no download. */
export function parseAndroidRelease(raw: unknown, origin: string): AndroidRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string" || !/^[0-9A-Za-z.+_-]{1,40}$/.test(r.version)) return null;
  if (typeof r.versionCode !== "number" || !Number.isInteger(r.versionCode) || r.versionCode < 1) return null;
  if (typeof r.sha256 !== "string" || !SHA256.test(r.sha256)) return null;
  if (typeof r.sizeBytes !== "number" || !Number.isFinite(r.sizeBytes) || r.sizeBytes <= 0) return null;
  // A bare file name only: the APK must live next to the manifest, never at an arbitrary path or host.
  if (typeof r.file !== "string" || !SAFE_FILE.test(r.file)) return null;
  return {
    version: r.version,
    versionCode: r.versionCode,
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    url: `${origin.replace(/\/+$/, "")}/downloads/${r.file}`,
    publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : null,
  };
}

export function formatApkSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Pairing codes live 10 minutes (functions/src/sms-pairing). The landing page can't read the session, so it estimates. */
export const PAIRING_CODE_LIFETIME_MS = 10 * 60 * 1000;

export function codeLikelyExpired(firstSeenAt: number, now: number): boolean {
  return now - firstSeenAt >= PAIRING_CODE_LIFETIME_MS;
}
