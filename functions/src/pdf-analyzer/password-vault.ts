/**
 * PDF Analyzer — PasswordVault. Encrypts/decrypts a card's saved statement
 * password for at-rest storage (`saved-password-store.ts`). AES-256-GCM via
 * Node's built-in `crypto`, keyed by a Cloud Functions v2 secret
 * (`PDF_ANALYZER_VAULT_KEY`, set via `firebase functions:secrets:set`).
 *
 * Intentionally the ONLY file in this codebase that imports `crypto` for
 * this purpose — every caller (the callables in `functions/src/index.ts`)
 * depends on this module's `encrypt`/`decrypt` signatures only, never on
 * AES/GCM specifics directly. A future move to Cloud KMS envelope
 * encryption is a drop-in replacement of this file's internals, not a
 * change to any caller.
 *
 * Never logs plaintext or ciphertext at any point — same discipline
 * `decrypt-document.ts` already establishes for the manual-password path.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { defineSecret } from "firebase-functions/params";

export const PDF_ANALYZER_VAULT_KEY = defineSecret("PDF_ANALYZER_VAULT_KEY");

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const ALGORITHM = "aes-256-gcm";

function resolveKey(keyOverride?: string): Buffer {
  const base64Key = keyOverride ?? PDF_ANALYZER_VAULT_KEY.value();
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("PDF_ANALYZER_VAULT_KEY must decode to exactly 32 bytes (AES-256).");
  }
  return key;
}

/** `keyOverride` exists only for unit tests that can't bind a live Cloud Functions secret — production callers never pass it. */
export function encrypt(plaintext: string, keyOverride?: string): EncryptedValue {
  const key = resolveKey(keyOverride);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/** Throws if the auth tag doesn't verify (tampered/corrupted ciphertext) — never silently returns garbage. */
export function decrypt(value: EncryptedValue, keyOverride?: string): string {
  const key = resolveKey(keyOverride);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
