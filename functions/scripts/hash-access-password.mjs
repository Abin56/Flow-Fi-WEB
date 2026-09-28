#!/usr/bin/env node
/**
 * Produces the value for the FLOWFI_ACCESS_PASSWORD_HASH secret — a salted
 * scrypt hash in the exact format functions/src/access/access-gate.ts reads.
 *
 * The password is read from a hidden prompt (or from piped stdin) and is
 * never echoed, logged, or written to disk. Only the hash goes to stdout, so
 * it can be piped straight into Secret Manager:
 *
 *   node functions/scripts/hash-access-password.mjs > hash.tmp
 *   firebase functions:secrets:set FLOWFI_ACCESS_PASSWORD_HASH --data-file hash.tmp
 *   (then delete hash.tmp)
 */

import { randomBytes, scryptSync } from "node:crypto";

const PARAMS = { N: 1 << 15, r: 8, p: 1 };
const MIN_LENGTH = 12;

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (data += c));
      stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
      stdin.on("error", reject);
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\u0003") process.exit(130);
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stderr.write("\n");
        resolve(value);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const password = await readHidden("New FlowFi access password (hidden): ");
if (password.length < MIN_LENGTH || password.length > 256) {
  process.stderr.write(`Password must be ${MIN_LENGTH}-256 characters.\n`);
  process.exit(1);
}
if (process.stdin.isTTY) {
  const confirm = await readHidden("Confirm password: ");
  if (confirm !== password) {
    process.stderr.write("Passwords do not match.\n");
    process.exit(1);
  }
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { ...PARAMS, maxmem: 128 * PARAMS.N * PARAMS.r * 2 });
process.stdout.write(["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$"));
