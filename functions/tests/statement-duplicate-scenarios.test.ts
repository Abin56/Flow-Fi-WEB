/**
 * End-to-end duplicate scenarios for a statement parsed by the generic (unknown-bank) tier: the REAL
 * `MultiBankCreditCardStatementPipeline` against the Firestore Emulator, with transactions seeded in the exact
 * persisted shape (`transactionToFirestore` in lib/models/transaction.ts) — including a credit-card profile id that
 * DIFFERS from its underlying Account id, because that mismatch is what used to make every lookup silently empty.
 *
 * Scenarios: a manual transaction already exists; the same purchase arrived from an SMS import; a soft-deleted twin
 * must not block; a same-text transaction on ANOTHER account must not match; the same PDF uploaded twice; two
 * overlapping statements; a generic statement that prints no billing period.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MultiBankCreditCardStatementPipeline, transactionDateSpan } from "../src/pipeline/multi-bank-credit-card-statement-pipeline";
import type { PdfDocumentHandle, PdfDocumentProvider, PdfPageText } from "../src/pdf/pdf-document-provider";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid-dup-scenarios";
const CARD_PROFILE_ID = "card-profile-1";
const ACCOUNT_ID = "account-behind-card-1"; // intentionally != CARD_PROFILE_ID
const OTHER_ACCOUNT_ID = "some-other-account";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

async function wipe() {
  const user = db.collection("users").doc(UID);
  for (const name of ["transactions", "creditCards", "financialDocuments"]) {
    const snap = await user.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  const imports = await user.collection("documentImports").get();
  for (const imp of imports.docs) {
    await Promise.all((await imp.ref.collection("records").get()).docs.map((r) => r.ref.delete()));
    await imp.ref.delete();
  }
}

afterEach(wipe);
afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

// ─────────────── fixtures

type Row = { date: string; desc: string; debit?: string; credit?: string };

/** A header-bearing generic statement with NO billing period / closing balance anywhere on it. */
function statementPages(rows: Row[]): PdfPageText[] {
  const items: PdfPageText["items"] = [];
  const put = (str: string, x: number, y: number) => items.push({ str, x, y, width: str.length * 5, height: 8 });
  put("Date", 30, 700);
  put("Description", 100, 700);
  put("Debit", 330, 700);
  put("Credit", 400, 700);
  rows.forEach((r, i) => {
    const y = 688 - i * 12;
    put(r.date, 30, y);
    put(r.desc, 100, y);
    if (r.debit) put(r.debit, 330, y);
    if (r.credit) put(r.credit, 400, y);
  });
  return [{ pageNumber: 1, text: items.map((i) => i.str).join(" "), items }];
}

function providerFor(pages: PdfPageText[]): PdfDocumentProvider {
  const handle: PdfDocumentHandle = {
    pageCount: pages.length,
    getPageText: async (n) => pages.find((p) => p.pageNumber === n)!,
    getAllPageText: async () => pages,
    destroy: async () => {},
  };
  return { open: async () => handle };
}

async function seedCardProfile() {
  await db.collection("users").doc(UID).collection("creditCards").doc(CARD_PROFILE_ID).set({ accountId: ACCOUNT_ID });
}

/** The exact persisted shape of a FlowFi transaction. */
async function seedTransaction(
  id: string,
  o: { description: string; amount: number; date: Date; accountId?: string; source?: string; deletedAt?: Date | null },
) {
  await db.collection("users").doc(UID).collection("transactions").doc(id).set({
    type: "expense",
    amount: o.amount,
    dateTime: Timestamp.fromDate(o.date),
    accountId: o.accountId ?? ACCOUNT_ID,
    categoryId: "cat-1",
    description: o.description,
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: Timestamp.now(),
    transferMatchedAt: null,
    status: "completed",
    isBusiness: false,
    source: o.source ?? "manual",
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    deletedAt: o.deletedAt == null ? null : Timestamp.fromDate(o.deletedAt),
    lastEditedAt: null,
    editHistory: [],
  });
}

async function parse(documentId: string, rows: Row[], fileHash: string | null) {
  if (fileHash) await db.collection("users").doc(UID).collection("financialDocuments").doc(documentId).set({ fileHash });
  const pipeline = new MultiBankCreditCardStatementPipeline(providerFor(statementPages(rows)), db);
  const result = await pipeline.run(new Uint8Array(), { uid: UID, documentId, accountId: CARD_PROFILE_ID, fileHash });
  const recs = await db.collection("users").doc(UID).collection("documentImports").doc(documentId).collection("records").get();
  const byDesc = (needle: string) => recs.docs.map((d) => d.data()).find((r) => String(r.counterpartyRaw).includes(needle))!;
  return { result, recs, byDesc };
}

const d = (m: number, day: number) => new Date(Date.UTC(2026, m - 1, day));

const BASE_ROWS: Row[] = [
  { date: "12/07/2026", desc: "AMAZON PAY INDIA", debit: "1,499.00" },
  { date: "13/07/2026", desc: "SWIGGY ORDER 4412", debit: "640.00" },
  { date: "14/07/2026", desc: "UBER TRIP 998", debit: "245.00" },
  { date: "20/07/2026", desc: "MYNTRA DESIGNS", debit: "999.00" },
];

describe("generic-parsed statement vs existing transactions (server-side duplicate lookup)", () => {
  it("flags a manual transaction and an SMS-imported twin; ignores unrelated, soft-deleted, other-account and profile-id-keyed decoys", async () => {
    await seedCardProfile();
    await seedTransaction("manual-amazon", { description: "Amazon Pay India", amount: 1499, date: d(7, 12) });
    await seedTransaction("txn_sms_abc12345", { description: "Swiggy", amount: 640, date: d(7, 13), source: "sms" });
    await seedTransaction("deleted-myntra", { description: "Myntra Designs", amount: 999, date: d(7, 20), deletedAt: d(7, 21) });
    await seedTransaction("other-account-uber", { description: "Uber Trip", amount: 245, date: d(7, 14), accountId: OTHER_ACCOUNT_ID });
    // Keyed by the card PROFILE id — the legacy mismatch. Real transactions never carry it, so it must not be read.
    await seedTransaction("profile-id-decoy", { description: "Uber Trip", amount: 245, date: d(7, 14), accountId: CARD_PROFILE_ID });

    const { result, byDesc } = await parse("doc-1", BASE_ROWS, "hash-1");
    expect(result.outcome).toBe("parsed");
    expect(byDesc("AMAZON").duplicateOfTransactionId).toBe("manual-amazon");
    expect(byDesc("SWIGGY").duplicateOfTransactionId).toBe("txn_sms_abc12345");
    expect(byDesc("UBER").duplicateOfTransactionId).toBeNull();
    expect(byDesc("MYNTRA").duplicateOfTransactionId).toBeNull();
  });

  it("a statement that prints no billing period still gets a comparison window from its own row dates", () => {
    const span = transactionDateSpan(
      [d(7, 12), d(7, 20), d(7, 14)].map((value) => ({ date: { value } }) as never),
    );
    expect(span!.start.toISOString()).toBe(d(7, 12).toISOString());
    expect(span!.end.toISOString()).toBe(d(7, 20).toISOString());
    expect(transactionDateSpan([])).toBeNull();
  });

  it("matches nothing (and nothing blocks) on a user with no prior data", async () => {
    await seedCardProfile();
    const { result, recs } = await parse("doc-empty", BASE_ROWS, "hash-empty");
    expect(result.outcome).toBe("parsed");
    expect(recs.docs.every((r) => r.data().duplicateOfTransactionId == null)).toBe(true);
  });
});

describe("same PDF uploaded twice", () => {
  it("is flagged once the first upload has committed rows, never while it is only staged", async () => {
    await seedCardProfile();
    await parse("doc-first", BASE_ROWS, "same-pdf-hash");

    // Only staged, nothing imported yet → the second upload is NOT a duplicate of it.
    const stagedOnly = await parse("doc-second-a", BASE_ROWS, "same-pdf-hash");
    expect(stagedOnly.recs.docs.every((r) => r.data().duplicateOfTransactionId == null)).toBe(true);

    // The first upload gets (partially) imported: one row carries a committedTransactionId.
    await db.collection("users").doc(UID).collection("documentImports").doc("doc-first").collection("records").doc("1").update({ committedTransactionId: "txn_imp_x_1" });

    const second = await parse("doc-second-b", BASE_ROWS, "same-pdf-hash");
    expect(second.recs.size).toBe(4);
    expect(second.recs.docs.every((r) => r.data().duplicateOfTransactionId === "doc-first")).toBe(true);
  });
});

describe("overlapping statements", () => {
  it("only the overlapping rows are flagged; the new rows stay clean", async () => {
    await seedCardProfile();
    // Statement 1 was imported: its first two rows exist as keyed transactions.
    await seedTransaction("txn_imp_aaaa_1", { description: "AMAZON PAY INDIA", amount: 1499, date: d(7, 12) });
    await seedTransaction("txn_imp_aaaa_2", { description: "SWIGGY ORDER 4412", amount: 640, date: d(7, 13) });

    // Statement 2 (different PDF, different hash) re-lists those two and adds two new rows.
    const rows: Row[] = [
      BASE_ROWS[0]!,
      BASE_ROWS[1]!,
      { date: "25/07/2026", desc: "BIGBASKET GROCERIES", debit: "812.25" },
      { date: "26/07/2026", desc: "ZOMATO ONLINE", debit: "420.00" },
    ];
    const { byDesc } = await parse("doc-overlap", rows, "hash-overlap");
    expect(byDesc("AMAZON").duplicateOfTransactionId).toBe("txn_imp_aaaa_1");
    expect(byDesc("SWIGGY").duplicateOfTransactionId).toBe("txn_imp_aaaa_2");
    expect(byDesc("BIGBASKET").duplicateOfTransactionId).toBeNull();
    expect(byDesc("ZOMATO").duplicateOfTransactionId).toBeNull();
  });
});

describe("scanned PDF", () => {
  it("is reported as needing a text-based PDF and writes no staging data", async () => {
    await seedCardProfile();
    const pages: PdfPageText[] = [{ pageNumber: 1, text: "", items: [] }];
    const pipeline = new MultiBankCreditCardStatementPipeline(providerFor(pages), db);
    const result = await pipeline.run(new Uint8Array(), { uid: UID, documentId: "doc-scan", accountId: CARD_PROFILE_ID });
    expect(result).toEqual({ outcome: "needs_review", reason: "scanned_pdf_no_text_layer" });
    expect((await db.collection("users").doc(UID).collection("documentImports").doc("doc-scan").get()).exists).toBe(false);
  });
});
