#!/usr/bin/env node
/**
 * Operator-only SMS Sync emergency switches (docs/sms-sync-pairing.md §Operator controls).
 *
 *   status                         show both switches for the project (and one account with --uid)
 *   global on|off                  smsSyncControl/global.uploadsDisabled — stops uploads AND pairing for every account
 *   hold <uid> on|off              users/{uid}/smsSyncConfig/operatorHold.disabled — the same, for one account
 *
 * "on" means STOPPED. Enforced in three places: Android's F3 gate (fails closed), the pairing Cloud Functions, and
 * firestore.rules on candidate writes. Pairing can never clear either switch.
 *
 * Writes require --confirm; without it the script only prints what it would do. --project is always required, so
 * nothing is ever written to an implicit default project. Uses Application Default Credentials
 * (`gcloud auth application-default login`), or the emulator when FIRESTORE_EMULATOR_HOST is set.
 *
 *   node functions/scripts/sms-sync-kill-switch.mjs --project financeapp-585eb status
 *   node functions/scripts/sms-sync-kill-switch.mjs --project financeapp-585eb global on --reason "parser incident" --confirm
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, value && !value.startsWith("--") ? 2 : 1);
  return value && !value.startsWith("--") ? value : true;
};

const project = flag("project");
const reason = flag("reason");
const confirm = flag("confirm") === true;
const uidFlag = flag("uid");
const [command, ...rest] = args;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: sms-sync-kill-switch.mjs --project <id> (status [--uid <uid>] | global on|off | hold <uid> on|off) [--reason <text>] [--confirm]");
  process.exit(1);
}

if (typeof project !== "string") usage("--project is required");
const db = getFirestore(initializeApp({ projectId: project }));
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : "PRODUCTION";
console.log(`Project: ${project} (${target})`);

const globalRef = db.collection("smsSyncControl").doc("global");
const holdRef = (uid) => db.collection("users").doc(uid).collection("smsSyncConfig").doc("operatorHold");

async function write(ref, field, on) {
  const data = { [field]: on, reason: typeof reason === "string" ? reason : null, updatedAt: FieldValue.serverTimestamp(), updatedBy: "sms-sync-kill-switch script" };
  console.log(`${confirm ? "Writing" : "Would write"} ${ref.path}: ${field}=${on}${data.reason ? ` (reason: ${data.reason})` : ""}`);
  if (!confirm) {
    console.log("Dry run — add --confirm to apply.");
    return;
  }
  await ref.set(data, { merge: true });
  console.log("Done.");
}

const parseOnOff = (v) => (v === "on" ? true : v === "off" ? false : usage("expected on|off"));

switch (command) {
  case "status": {
    const global = await globalRef.get();
    console.log(`global uploadsDisabled: ${global.get("uploadsDisabled") === true ? "ON (stopped)" : "off"}${global.get("reason") ? ` — ${global.get("reason")}` : ""}`);
    if (typeof uidFlag === "string") {
      const hold = await holdRef(uidFlag).get();
      const upload = await db.collection("users").doc(uidFlag).collection("smsSyncConfig").doc("backgroundUpload").get();
      console.log(`hold for ${uidFlag}: ${hold.get("disabled") === true ? "ON (stopped)" : "off"}`);
      console.log(`backgroundUpload: enabled=${upload.get("enabled") === true} deviceId=${upload.get("deviceId") ?? "—"} source=${upload.get("source") ?? "—"}`);
    }
    break;
  }
  case "global":
    await write(globalRef, "uploadsDisabled", parseOnOff(rest[0]));
    break;
  case "hold":
    if (!rest[0]) usage("hold needs a uid");
    await write(holdRef(rest[0]), "disabled", parseOnOff(rest[1]));
    break;
  default:
    usage(command ? `unknown command ${command}` : undefined);
}
