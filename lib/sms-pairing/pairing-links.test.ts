import { describe, expect, it } from "vitest";
import { buildAppPairingLinks, isPairingToken } from "./pairing-links";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

describe("pairing links", () => {
  it("accepts only the token shape the pairing function issues", () => {
    expect(TOKEN).toHaveLength(43);
    expect(isPairingToken(TOKEN)).toBe(true);
    expect(isPairingToken(null)).toBe(false);
    expect(isPairingToken("")).toBe(false);
    expect(isPairingToken(`${TOKEN}x`)).toBe(false);
    expect(isPairingToken(TOKEN.replace("A", "/"))).toBe(false);
  });

  it("builds the custom-scheme and Android intent links with a not-installed fallback to the same page", () => {
    const links = buildAppPairingLinks(TOKEN, `https://flowfi.example/pair/?t=${TOKEN}`);
    expect(links.schemeUrl).toBe(`flowfi://app/pair?t=${TOKEN}`);
    expect(links.intentUrl.startsWith(`intent://app/pair?t=${TOKEN}#Intent;scheme=flowfi;package=com.flowfi.app;`)).toBe(true);
    const fallback = decodeURIComponent(/S\.browser_fallback_url=([^;]+)/.exec(links.intentUrl)![1]!);
    expect(new URL(fallback).searchParams.get("missing")).toBe("1");
    expect(new URL(fallback).searchParams.get("t")).toBe(TOKEN);
    expect(links.intentUrl.endsWith(";end")).toBe(true);
  });
});
