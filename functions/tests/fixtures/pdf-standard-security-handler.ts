/**
 * TEST-FIXTURE-ONLY implementation of the PDF Standard Security Handler,
 * revision 2 (RC4, 40-bit) — ISO 32000-1 §7.6.3, Algorithms 2/3/4 (the
 * "Algorithm 3.x" numbering from the older PDF 1.4/1.7 reference). This
 * exists solely to produce genuinely password-protected PDF fixtures for
 * functions/tests/pdf-document-provider.test.ts — it is NOT used by any
 * production code path (docs/adr — the production password-verification
 * dependency decision is pdfjs-dist, a mature independent implementation
 * of the *reader* side of this same spec; see functions/src/pdf/).
 *
 * Correctness strategy: rather than trust this against nothing, (1) the
 * RC4 primitive is checked against the standard Wikipedia/Cryptopp test
 * vector before anything else uses it (see the "RC4 primitive" describe
 * block in pdf-document-provider.test.ts's sibling suite), and (2) the
 * fixtures this module produces are validated by actually opening them
 * with pdfjs-dist — an independent, spec-compliant reader — so a wrong
 * password is proven to fail and the right one is proven to succeed
 * against real, external decryption logic, not just against itself.
 */

import { createHash } from "node:crypto";
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString } from "pdf-lib";

/** ISO 32000-1 Table 21 — fixed 32-byte padding string. */
const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** Algorithm 3.2 step (a): pad or truncate a password to exactly 32 bytes. */
export function padPassword(password: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(password, "latin1"));
  const out = new Uint8Array(32);
  const take = Math.min(bytes.length, 32);
  out.set(bytes.subarray(0, take), 0);
  out.set(PADDING.subarray(0, 32 - take), take);
  return out;
}

export function md5(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("md5").update(bytes).digest());
}

/** Pure-JS RC4 (KSA + PRGA) — see the test-vector check before this is trusted anywhere. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    const t = (s[i]! + s[j]!) & 0xff;
    out[k] = data[k]! ^ s[t]!;
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** P as an unsigned 32-bit little-endian byte sequence (two's-complement of the signed permissions int). */
function permissionsBytesLE(p: number): Uint8Array {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(p, 0);
  return Uint8Array.from(buf);
}

export interface StandardSecurityParams {
  userPassword: string;
  ownerPassword: string;
  /** Signed 32-bit permissions integer; -4 (0xFFFFFFFC) = unrestricted, per Table 22 R2 reserved-bit rules. */
  permissions: number;
  fileIdFirstBytes: Uint8Array;
}

/** Algorithm 3.3 (R2): owner password entry. */
export function computeOwnerEntry(params: Pick<StandardSecurityParams, "userPassword" | "ownerPassword">): Uint8Array {
  const paddedOwner = padPassword(params.ownerPassword);
  const ownerKey = md5(paddedOwner).subarray(0, 5); // R2: 40-bit key = first 5 bytes
  const paddedUser = padPassword(params.userPassword);
  return rc4(ownerKey, paddedUser);
}

/** Algorithm 3.2 (R2): the file encryption key, 5 bytes / 40-bit. */
export function computeEncryptionKey(params: StandardSecurityParams, ownerEntry: Uint8Array): Uint8Array {
  const paddedUser = padPassword(params.userPassword);
  const input = concatBytes(paddedUser, ownerEntry, permissionsBytesLE(params.permissions), params.fileIdFirstBytes);
  return md5(input).subarray(0, 5);
}

/** Algorithm 3.4 (R2): user password entry = RC4(encryptionKey, PADDING). */
export function computeUserEntry(encryptionKey: Uint8Array): Uint8Array {
  return rc4(encryptionKey, PADDING);
}

/** Algorithm 3.1: per-object RC4 key = first min(n+5, 16) bytes of MD5(fileKey + low3(objNum) + low2(genNum)). */
export function computeObjectKey(fileEncryptionKey: Uint8Array, objectNumber: number, generationNumber: number): Uint8Array {
  const objBytes = Uint8Array.from([
    objectNumber & 0xff,
    (objectNumber >> 8) & 0xff,
    (objectNumber >> 16) & 0xff,
  ]);
  const genBytes = Uint8Array.from([generationNumber & 0xff, (generationNumber >> 8) & 0xff]);
  const input = concatBytes(fileEncryptionKey, objBytes, genBytes);
  const digest = md5(input);
  const keyLength = Math.min(fileEncryptionKey.length + 5, 16);
  return digest.subarray(0, keyLength);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mutates `pdfDoc`'s trailer to add a valid Standard Security Handler R2
 * /Encrypt dictionary + /ID, computed for the given passwords, AND
 * RC4-encrypts every indirect string/stream object's bytes with its
 * correct per-object key (Algorithm 3.1).
 *
 * An earlier version of this fixture generator only added the /Encrypt
 * dictionary without touching object content, on the assumption that
 * password verification happens before any content decryption. That
 * assumption was WRONG in practice: pdfjs-dist decrypts structural
 * objects (e.g. content streams needed to locate the page tree) as part
 * of opening the document, not lazily on first read — an unencrypted
 * object in a document flagged as encrypted comes out corrupted the
 * moment pdfjs "decrypts" already-plaintext bytes. Caught by
 * functions/tests/pdf-document-provider.test.ts actually failing against
 * real pdfjs-dist, not by inspection — fixed by encrypting every indirect
 * object for real, which is also simply what the spec requires.
 */
export function addPasswordProtection(pdfDoc: PDFDocument, userPassword: string, ownerPassword: string): void {
  const context = pdfDoc.context;

  const fileId = Uint8Array.from(Buffer.from("flowfitestfileid", "latin1")).subarray(0, 16);
  const idHex = PDFHexString.of(bytesToHex(fileId));
  context.trailerInfo.ID = context.obj([idHex, idHex]);

  const permissions = -4; // unrestricted, R2 reserved bits per Table 22
  const params: StandardSecurityParams = { userPassword, ownerPassword, permissions, fileIdFirstBytes: fileId };

  const ownerEntry = computeOwnerEntry(params);
  const encryptionKey = computeEncryptionKey(params, ownerEntry);
  const userEntry = computeUserEntry(encryptionKey);

  // Encrypt every existing indirect object's string/stream content BEFORE
  // registering the /Encrypt dict itself (so the dict's own O/U hex
  // strings — direct values inside it, not separately-registered indirect
  // objects — are never touched by this loop).
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const objectKey = computeObjectKey(encryptionKey, ref.objectNumber, ref.generationNumber);

    if (object instanceof PDFRawStream) {
      const encryptedContents = rc4(objectKey, object.contents);
      context.assign(ref, PDFRawStream.of(object.dict, encryptedContents));
    } else if (object instanceof PDFString) {
      const encryptedBytes = rc4(objectKey, object.asBytes());
      context.assign(ref, PDFHexString.of(bytesToHex(encryptedBytes)));
    } else if (object instanceof PDFHexString) {
      const encryptedBytes = rc4(objectKey, object.asBytes());
      context.assign(ref, PDFHexString.of(bytesToHex(encryptedBytes)));
    }
  }

  const encryptDict = context.obj({
    Filter: PDFName.of("Standard"),
    V: PDFNumber.of(1),
    R: PDFNumber.of(2),
    O: PDFHexString.of(bytesToHex(ownerEntry)),
    U: PDFHexString.of(bytesToHex(userEntry)),
    P: PDFNumber.of(permissions),
  });
  const encryptRef = context.register(encryptDict);
  context.trailerInfo.Encrypt = encryptRef;
}
