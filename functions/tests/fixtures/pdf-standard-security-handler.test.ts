/**
 * The RC4 primitive is checked against the standard published test vector
 * BEFORE anything trusts it to build encrypted PDF fixtures — same
 * discipline as verifying sha256Hex against NIST vectors in the web app's
 * test suite.
 */

import { describe, expect, it } from "vitest";
import { computeEncryptionKey, computeOwnerEntry, computeUserEntry, padPassword, rc4 } from "./pdf-standard-security-handler";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("rc4 primitive (against the standard published test vector)", () => {
  it("matches the well-known Key/Plaintext -> BBF316E8D940AF0AD3 vector", () => {
    const key = new TextEncoder().encode("Key");
    const plaintext = new TextEncoder().encode("Plaintext");
    expect(hex(rc4(key, plaintext))).toBe("bbf316e8d940af0ad3");
  });

  it("is its own inverse (encrypting the ciphertext with the same key recovers the plaintext)", () => {
    const key = new TextEncoder().encode("some-key");
    const plaintext = new TextEncoder().encode("round trip me");
    const ciphertext = rc4(key, plaintext);
    const roundTripped = rc4(key, ciphertext);
    expect(new TextDecoder().decode(roundTripped)).toBe("round trip me");
  });
});

describe("padPassword", () => {
  it("pads a short password to exactly 32 bytes using the standard padding string", () => {
    const padded = padPassword("abc");
    expect(padded.length).toBe(32);
    expect(padded[0]).toBe("a".charCodeAt(0));
    expect(padded[3]).toBe(0x28); // first padding byte per Table 21
  });

  it("truncates a password longer than 32 bytes", () => {
    const padded = padPassword("x".repeat(40));
    expect(padded.length).toBe(32);
    expect(Array.from(padded).every((b) => b === "x".charCodeAt(0))).toBe(true);
  });

  it("is exactly the padding string for an empty password", () => {
    const padded = padPassword("");
    expect(padded[0]).toBe(0x28);
    expect(padded[31]).toBe(0x7a);
  });
});

describe("key derivation determinism", () => {
  it("computeOwnerEntry/computeEncryptionKey/computeUserEntry are deterministic for the same inputs", () => {
    const fileId = new TextEncoder().encode("0123456789abcdef");
    const params = { userPassword: "Test1234", ownerPassword: "Test1234", permissions: -4, fileIdFirstBytes: fileId };
    const o1 = computeOwnerEntry(params);
    const o2 = computeOwnerEntry(params);
    expect(hex(o1)).toBe(hex(o2));

    const key1 = computeEncryptionKey(params, o1);
    const key2 = computeEncryptionKey(params, o1);
    expect(hex(key1)).toBe(hex(key2));
    expect(key1.length).toBe(5);

    const u1 = computeUserEntry(key1);
    const u2 = computeUserEntry(key1);
    expect(hex(u1)).toBe(hex(u2));
    expect(u1.length).toBe(32);
  });

  it("produces a different owner entry for a different user password", () => {
    const a = computeOwnerEntry({ userPassword: "Test1234", ownerPassword: "Test1234" });
    const b = computeOwnerEntry({ userPassword: "Different", ownerPassword: "Test1234" });
    expect(hex(a)).not.toBe(hex(b));
  });
});
