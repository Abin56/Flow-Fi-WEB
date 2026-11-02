/**
 * Browser QA (storage-management.mjs). Local emulators only — see tests/e2e-qa/README.md.
 * Settings → Storage: real usage from Storage object metadata (synthetic PDFs seeded into the Storage emulator),
 * per-section breakdown, limit presets/custom limit + persistence, selected-file deletion with confirmation, the
 * guarantee that deleting a file leaves every Firestore record untouched, and per-user isolation.
 * The upload-limit gate itself is proven in tests/integration/storage-management.test.ts (the upload flow needs the
 * Cloud Functions emulator, which this suite does not run).
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS, PORTS, PROJECT_ID } from "../lib/env.mjs";

const MB = 1024 * 1024;
const OWNER = { Authorization: "Bearer owner" };
const BUCKET = `${PROJECT_ID}.appspot.com`;
const STORAGE = `http://127.0.0.1:${PORTS.storage}`;

const pathOf = (uid, name) => `users/${uid}/documents/credit_card_statement/${name}.pdf`;

async function putObject(path, bytes) {
  const r = await fetch(`${STORAGE}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { ...OWNER, "Content-Type": "application/pdf" },
    body: Buffer.alloc(bytes, 1),
  });
  if (!r.ok) throw new Error(`seed object ${path}: ${r.status} ${await r.text()}`);
}

async function objectExists(path) {
  const r = await fetch(`${STORAGE}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(path)}`, { headers: OWNER });
  return r.ok;
}

async function deleteObject(path) {
  await fetch(`${STORAGE}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(path)}`, { method: "DELETE", headers: OWNER });
}

async function seedStatement(uid, name, bytes, extra = {}) {
  const path = pathOf(uid, name);
  await putObject(path, bytes);
  await h.createDocUnderUser(`financialDocuments/${name}`, {
    userId: uid,
    documentType: "credit_card_statement",
    accountId: "qa-card",
    fileHash: name,
    storagePath: path,
    uploadedAt: new Date("2026-10-05T00:00:00Z"),
    status: "parsed",
    bank: "HDFC",
    ...extra,
  });
  return path;
}

async function removeStatement(uid, name) {
  await deleteObject(pathOf(uid, name));
  await fetch(`${FIRESTORE_DOCS}/users/${uid}/financialDocuments/${name}`, { method: "DELETE", headers: OWNER });
}

async function openStorageTab(page) {
  await h.go(page, "/settings");
  await page.getByRole("tab", { name: "Storage" }).click();
  await page.locator('[data-testid="storage-management"]').waitFor({ timeout: 30000 });
  await page.locator('[data-testid="storage-used"]').waitFor({ timeout: 30000 });
}

const text = (page, id) => page.locator(`[data-testid="${id}"]`).innerText();

scenario("storage-usage", "Storage tab: real usage, breakdown, limit presets + custom limit, persistence, isolation", async ({ page }, chk) => {
  await h.openPortalSignedIn(page);
  const uid = await h.authUid();
  const names = ["qa-s1", "qa-s2", "qa-s3"];
  try {
    await seedStatement(uid, "qa-s1", 2 * MB);
    await seedStatement(uid, "qa-s2", 1 * MB);
    await seedStatement(uid, "qa-s3", Math.round(0.5 * MB));
    // Another user's file: must never appear in this user's usage.
    await putObject(pathOf("someone-else", "theirs"), 40 * MB);

    await openStorageTab(page);
    chk("used storage is the sum of the real object sizes (3.5 MB)", (await text(page, "storage-used")) === "3.5 MB", await text(page, "storage-used"));
    chk("default limit is 500 MB", (await text(page, "storage-limit")) === "500 MB");
    chk("remaining = limit − used", (await text(page, "storage-remaining")) === "497 MB", await text(page, "storage-remaining"));
    chk("percent shown", (await text(page, "storage-percent")).startsWith("0.7"), await text(page, "storage-percent"));
    chk("file count is 3", (await text(page, "storage-filecount")).startsWith("3 stored files"));
    chk("section breakdown lists the statements section with size and file count",
      /Imported card statements[\s\S]*3\.5 MB · 3 files · 100%/.test(await text(page, "storage-section-credit_card_statement")));
    chk("each file is listed with type, upload date and size", (await page.locator('[data-testid="storage-file-row"]').count()) === 3
      && (await page.locator('[data-testid="storage-file-row"]').first().innerText()).includes("PDF · uploaded"));
    chk("other user's 40 MB file is not counted or listed", (await text(page, "storage-used")) === "3.5 MB" && (await page.getByText("theirs").count()) === 0);
    chk("honest note: what is not stored", /Smart Capture/.test(await text(page, "storage-not-stored")));

    // Presets + persistence.
    await page.getByRole("button", { name: "700 MB" }).click();
    chk("700 MB preset applies", (await text(page, "storage-limit")) === "700 MB");
    await page.reload();
    await page.getByRole("tab", { name: "Storage" }).click();
    await page.locator('[data-testid="storage-used"]').waitFor({ timeout: 30000 });
    chk("limit persisted across reload", (await text(page, "storage-limit")) === "700 MB");
    chk("usage identical after reload", (await text(page, "storage-used")) === "3.5 MB");

    // Validation.
    const custom = page.getByLabel("Custom storage limit in MB");
    await custom.fill("abc");
    await page.getByRole("button", { name: "Set limit" }).click();
    chk("invalid custom limit shows an error and changes nothing", (await page.locator('[data-testid="storage-limit-error"]').count()) === 1 && (await text(page, "storage-limit")) === "700 MB");
    await custom.fill("0");
    await page.getByRole("button", { name: "Set limit" }).click();
    chk("limit below 1 MB rejected", (await page.locator('[data-testid="storage-limit-error"]').count()) === 1);

    // Warning and over-limit states.
    await custom.fill("4");
    await page.getByRole("button", { name: "Set limit" }).click();
    chk("limit at 4 MB → warning notice (88%)", /88%/.test(await text(page, "storage-notice")), await text(page, "storage-notice"));
    await custom.fill("3");
    await page.getByRole("button", { name: "Set limit" }).click();
    chk("limit below usage → over-limit notice, nothing deleted", /over your 3 MB limit/.test(await text(page, "storage-notice")) && (await objectExists(pathOf(uid, "qa-s1"))));
    await h.shot(page, "storage-over-limit");
    await page.getByRole("button", { name: "500 MB" }).click();
    chk("back to 500 MB → no notice", (await page.locator('[data-testid="storage-notice"]').count()) === 0);
    await h.shot(page, "storage-usage");
  } finally {
    for (const n of names) await removeStatement(uid, n);
    await deleteObject(pathOf("someone-else", "theirs"));
  }
});

scenario("storage-delete", "Storage cleanup: confirm, delete one file, usage updates, records + financial data untouched", async ({ page }, chk) => {
  await h.openPortalSignedIn(page);
  const uid = await h.authUid();
  const names = ["qa-d1", "qa-d2"];
  try {
    await seedStatement(uid, "qa-d1", 3 * MB);
    await seedStatement(uid, "qa-d2", 1 * MB, { status: "parsing" });

    const accountsBefore = JSON.stringify((await h.list("accounts")).map((a) => [a.id, a.currentBalance]).sort());
    const txnsBefore = (await h.list("transactions")).length;
    const docsBefore = JSON.stringify((await h.list("financialDocuments")).sort((a, b) => a.id.localeCompare(b.id)));

    await openStorageTab(page);
    chk("2 files, 4 MB used", (await text(page, "storage-used")) === "4 MB" && (await text(page, "storage-filecount")).startsWith("2 stored files"));
    chk("delete button disabled until something is selected", await page.locator('[data-testid="storage-delete-selected"]').isDisabled());
    chk("a file that is still being processed cannot be selected", await page.getByRole("checkbox", { name: /Select HDFC statement/ }).nth(1).isDisabled().catch(() => false));

    // The 3 MB file is listed first (largest first).
    await page.getByRole("checkbox", { name: /Select HDFC statement/ }).first().click();
    await page.locator('[data-testid="storage-delete-selected"]').click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 10000 });
    const dtext = await dialog.innerText();
    chk("confirmation explains size freed and that records are kept", /3 MB/.test(dtext) && /statement record/.test(dtext) && /transactions/.test(dtext), dtext.slice(0, 200));
    await h.shot(page, "storage-delete-confirm");

    // Cancel: nothing happens.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    chk("cancel keeps the file", (await objectExists(pathOf(uid, "qa-d1"))) && (await text(page, "storage-used")) === "4 MB");

    // Confirm.
    await page.locator('[data-testid="storage-delete-selected"]').click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete files" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="storage-used"]')?.textContent === "1 MB", null, { timeout: 30000 });
    chk("usage drops immediately to 1 MB", (await text(page, "storage-used")) === "1 MB");
    chk("only the selected object was deleted", !(await objectExists(pathOf(uid, "qa-d1"))) && (await objectExists(pathOf(uid, "qa-d2"))));
    chk("1 file left in the list", (await page.locator('[data-testid="storage-file-row"]').count()) === 1);

    const docsAfter = JSON.stringify((await h.list("financialDocuments")).sort((a, b) => a.id.localeCompare(b.id)));
    chk("statement records are untouched (byte-identical)", docsAfter === docsBefore);
    chk("accounts and balances untouched", JSON.stringify((await h.list("accounts")).map((a) => [a.id, a.currentBalance]).sort()) === accountsBefore);
    chk("transactions untouched", (await h.list("transactions")).length === txnsBefore);

    await page.reload();
    await page.getByRole("tab", { name: "Storage" }).click();
    await page.locator('[data-testid="storage-used"]').waitFor({ timeout: 30000 });
    chk("deleted state persists across reload", (await text(page, "storage-used")) === "1 MB" && (await text(page, "storage-filecount")).startsWith("1 stored file"));
    await h.shot(page, "storage-after-delete");
  } finally {
    for (const n of names) await removeStatement(uid, n);
  }
});
