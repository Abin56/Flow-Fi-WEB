/**
 * Links that hand a pairing token from the `/pair` landing page to the FlowFi Android app.
 *
 * The app registers the `flowfi://app/pair?t=…` custom scheme (Finance_App AndroidManifest). Android Chrome blocks
 * plain custom-scheme navigation in some contexts and gives no "not installed" signal, so on Android the landing page
 * uses an `intent://` URL instead: Chrome opens the app when installed, otherwise follows `S.browser_fallback_url`.
 */

/** Same shape the pairing function issues: 32 random bytes, base64url, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Must match `applicationId` in Finance_App/android/app/build.gradle.kts. */
export const ANDROID_PACKAGE = process.env.NEXT_PUBLIC_ANDROID_PACKAGE || "com.flowfi.app";

export function isPairingToken(token: string | null | undefined): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function buildAppPairingLinks(token: string, currentHref: string): { schemeUrl: string; intentUrl: string } {
  const query = `t=${encodeURIComponent(token)}`;
  const fallback = new URL(currentHref);
  fallback.searchParams.set("missing", "1");
  return {
    schemeUrl: `flowfi://app/pair?${query}`,
    intentUrl: `intent://app/pair?${query}#Intent;scheme=flowfi;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback.toString())};end`,
  };
}
