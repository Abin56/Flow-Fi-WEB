/**
 * PDF Analyzer — saves a card's statement password, encrypted, for later
 * automatic unlock. Plain, directly testable, no `firebase-functions`
 * imports — same "thin onCall wrapper around a plain function" convention
 * every other ingestion module uses. The thin `onCall` wrapper
 * (`saveCardPasswordCallable`) lives in `functions/src/index.ts`.
 *
 * Encrypts the password and stores only the ciphertext
 * (`saved-password-store.ts`). There is no "rule" concept — a card either
 * has a saved password or it doesn't.
 *
 * Never logs the password — same discipline as `decrypt-document.ts`.
 */

import type { Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { encrypt, PDF_ANALYZER_VAULT_KEY } from "../pdf-analyzer/password-vault";
import { setSavedPasswordCiphertext } from "../pdf-analyzer/saved-password-store";

export interface SaveCardPasswordInput {
  uid: string;
  accountId: string;
  password: string;
}

/**
 * Tagged, non-sensitive failure codes — TEMPORARY diagnostic instrumentation
 * to isolate a live "could not save the password" bug without Cloud
 * Functions log access. Never carries the password or ciphertext. Remove
 * this class and the try/catch blocks below once the root cause is found
 * and fixed — see functions/src/index.ts's saveCardPasswordCallable for
 * where this surfaces to the client.
 */
export class SaveCardPasswordStepError extends Error {
  constructor(
    public readonly step:
      | "secret_unavailable"
      | "encryption_init_failed"
      | "encryption_failed"
      | "firestore_write_failed",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaveCardPasswordStepError";
  }
}

export async function saveCardPassword(db: Firestore, input: SaveCardPasswordInput): Promise<void> {
  logger.info("saveCardPassword: invoked", { uid: input.uid, accountId: input.accountId });

  // Step 1 — is the secret available at runtime at all?
  let rawKey: string;
  try {
    rawKey = PDF_ANALYZER_VAULT_KEY.value();
  } catch (e) {
    logger.error("saveCardPassword: step 1 failed — PDF_ANALYZER_VAULT_KEY.value() threw", { error: e instanceof Error ? e.stack : e });
    throw new SaveCardPasswordStepError("secret_unavailable", "PDF_ANALYZER_VAULT_KEY.value() threw.", e);
  }
  if (!rawKey) {
    logger.error("saveCardPassword: step 1 failed — PDF_ANALYZER_VAULT_KEY resolved to an empty value at runtime");
    throw new SaveCardPasswordStepError("secret_unavailable", "PDF_ANALYZER_VAULT_KEY is empty at runtime.");
  }
  let keyBuffer: Buffer;
  try {
    keyBuffer = Buffer.from(rawKey, "base64");
  } catch (e) {
    logger.error("saveCardPassword: step 2 failed — key did not decode as base64", { error: e instanceof Error ? e.stack : e });
    throw new SaveCardPasswordStepError("encryption_init_failed", "Vault key is not valid base64.", e);
  }
  if (keyBuffer.length !== 32) {
    logger.error("saveCardPassword: step 2 failed — decoded key is not 32 bytes", { decodedLength: keyBuffer.length });
    throw new SaveCardPasswordStepError(
      "encryption_init_failed",
      `Vault key decoded to ${keyBuffer.length} bytes, expected 32.`,
    );
  }

  // Step 3 — does encryption itself succeed?
  let encrypted: ReturnType<typeof encrypt>;
  try {
    encrypted = encrypt(input.password);
  } catch (e) {
    logger.error("saveCardPassword: step 3 failed — encrypt() threw", { error: e instanceof Error ? e.stack : e });
    throw new SaveCardPasswordStepError("encryption_failed", "Encryption failed.", e);
  }

  // Step 4/5 — does the Firestore write succeed? (Admin SDK — bypasses
  // firestore.rules entirely, so a rules-denial here would indicate the
  // Admin SDK credentials themselves are misconfigured, not a rules bug.)
  try {
    await setSavedPasswordCiphertext(db, input.uid, input.accountId, encrypted);
  } catch (e) {
    logger.error("saveCardPassword: step 4/5 failed — Firestore write threw", {
      error: e instanceof Error ? e.stack : e,
      uid: input.uid,
      accountId: input.accountId,
    });
    throw new SaveCardPasswordStepError("firestore_write_failed", "Firestore write failed.", e);
  }
}
