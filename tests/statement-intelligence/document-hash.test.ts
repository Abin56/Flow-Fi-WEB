/**
 * Verified against the standard SHA-256 test vectors (NIST/FIPS 180-4),
 * not just "the function runs" — backlog M1-T5.
 */

import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexOfFile } from "@/lib/statement-intelligence/document-hash";

describe("sha256Hex", () => {
  it("matches the known SHA-256 digest of the empty input", async () => {
    const hex = await sha256Hex(new Uint8Array([]));
    expect(hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the known SHA-256 digest of 'abc'", async () => {
    const hex = await sha256Hex(new TextEncoder().encode("abc"));
    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is stable across repeated calls with the same bytes", async () => {
    const bytes = new TextEncoder().encode("flowfi statement fixture");
    const first = await sha256Hex(bytes);
    const second = await sha256Hex(bytes);
    expect(first).toBe(second);
  });

  it("differs for different bytes", async () => {
    const a = await sha256Hex(new TextEncoder().encode("statement A"));
    const b = await sha256Hex(new TextEncoder().encode("statement B"));
    expect(a).not.toBe(b);
  });
});

describe("sha256HexOfFile", () => {
  it("hashes a Blob's contents to the same digest as its raw bytes", async () => {
    const bytes = new TextEncoder().encode("abc");
    const blob = new Blob([bytes]);
    const hex = await sha256HexOfFile(blob);
    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
