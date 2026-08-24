/**
 * Client-side SHA-256 hashing — Architecture v1.0 §4.1 Screen 2, §13.1.
 * Backlog M1-T5: "Client computes SHA-256 client-side pre-upload; call a
 * check endpoint; short-circuit with 'already imported' if a match
 * exists."
 *
 * Uses Web Crypto (`crypto.subtle`), available in every modern browser and
 * in Node 20+ (functions/ does NOT need its own copy of this — the check
 * function receives the client-claimed hash as input; see
 * functions/src/ingestion/check-document-exists.ts's module comment for
 * why the server doesn't need to independently recompute it at this
 * pre-upload stage).
 */

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // ArrayBuffer/Uint8Array typing across DOM lib + Node's webcrypto types
  // disagree on SharedArrayBuffer inclusion; a fresh copy sidesteps it and
  // guarantees subtle.digest sees a plain, non-shared buffer either way.
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return toHex(digest);
}

export async function sha256HexOfFile(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return sha256Hex(bytes);
}
