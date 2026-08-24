/**
 * Pure unit tests for PasswordVault's encrypt/decrypt — no emulator, no
 * live secret binding needed (uses the test-only `keyOverride` seam).
 */

import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/pdf-analyzer/password-vault";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64"); // fixed, synthetic — never a real secret

describe("PasswordVault", () => {
  it("round-trips a plaintext password through encrypt then decrypt", () => {
    const encrypted = encrypt("MySecretStatementPassword123", TEST_KEY);
    expect(decrypt(encrypted, TEST_KEY)).toBe("MySecretStatementPassword123");
  });

  it("produces different ciphertext for the same plaintext on repeated calls (random IV)", () => {
    const first = encrypt("SamePassword", TEST_KEY);
    const second = encrypt("SamePassword", TEST_KEY);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
  });

  it("throws when the auth tag has been tampered with", () => {
    const encrypted = encrypt("AnotherPassword", TEST_KEY);
    const tampered = { ...encrypted, authTag: encrypt("different", TEST_KEY).authTag };
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it("throws when the ciphertext has been tampered with", () => {
    const encrypted = encrypt("AnotherPassword", TEST_KEY);
    const tamperedBytes = Buffer.from(encrypted.ciphertext, "base64");
    tamperedBytes[0] = tamperedBytes[0] ^ 0xff;
    const tampered = { ...encrypted, ciphertext: tamperedBytes.toString("base64") };
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it("throws for a key that doesn't decode to 32 bytes", () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    expect(() => encrypt("x", shortKey)).toThrow();
  });
});
