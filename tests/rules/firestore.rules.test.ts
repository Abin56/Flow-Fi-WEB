/**
 * Firestore Emulator rules tests — backlog M1-T1 acceptance criteria:
 *   "Rules deny cross-user reads/writes on all three [new] collections in
 *   the Firestore Emulator."
 *   "documentTypeRegistry is client-read-only; writes rejected from client
 *   SDKs."
 * Also exercises the pre-existing schema (accounts, creditCards) to confirm
 * the blanket users/{uid}/** rule didn't regress anything already live
 * (docs/adr/ADR-002's stated risk).
 *
 * Run via `npm run test:rules` (wraps this in `firebase emulators:exec` so
 * a real Firestore emulator backs every assertion — no mocking).
 */

import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  where,
} from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const PROJECT_ID = "flowfi-rules-test";
const OWNER_UID = "owner-uid";
const OTHER_UID = "other-uid";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

describe("pre-existing per-user collections (regression guard, ADR-002)", () => {
  it("owner can read/write their own account", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = doc(ownerDb, "users", OWNER_UID, "accounts", "acc-1");
    await assertSucceeds(setDoc(ref, { name: "Cash", type: "cash" }));
    await assertSucceeds(getDoc(ref));
  });

  it("a different signed-in user cannot read another user's account", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "accounts", "acc-1"), { name: "Cash" });
    });
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, "users", OWNER_UID, "accounts", "acc-1")));
  });

  it("a different signed-in user cannot write another user's creditCards doc", async () => {
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(otherDb, "users", OWNER_UID, "creditCards", "card-1"), { name: "HDFC Regalia" }),
    );
  });

  it("an unauthenticated request cannot read or write any user's data", async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, "users", OWNER_UID, "accounts", "acc-1")));
    await assertFails(setDoc(doc(anonDb, "users", OWNER_UID, "accounts", "acc-1"), { name: "x" }));
  });
});

/**
 * Production-hardening pass: every one of these 13 collections shares the
 * exact same rule shape (`match /users/{uid}/{collection}/{document=**} {
 * allow read, write: if isOwner(uid); }`) and is where real money data
 * lives (balances, transactions, budgets, debts, bills, loans, EMIs,
 * shared expenses, payment schedules, cards, pooled credit limits). Before
 * this block, only `accounts` had both an owner-success and a cross-user-
 * denial test, and `creditCards` had a cross-user write-denial test but no
 * owner test and no cross-user read-denial test — the other 11 collections
 * had no dedicated rules test at all, despite each one gating real
 * financial data behind the identical `isOwner(uid)` check. A single typo
 * in any one collection's rule (e.g. `isOwner(resource.data.uid)` instead
 * of the path segment, or a stray `true`) would have shipped with nothing
 * here to catch it. Parameterized rather than 13 near-duplicate describe
 * blocks, so adding a 14th money-bearing collection later is a one-line
 * addition to this list, not another copy-pasted block.
 */
const MONEY_BEARING_COLLECTIONS = [
  "accounts",
  "transactions",
  "categories",
  "budgets",
  "savingsGoals",
  "people",
  "bills",
  "loans",
  "emis",
  "expenses",
  "paymentSchedules",
  "creditCards",
  "sharedCreditLimits",
] as const;

describe("owner/cross-user coverage for every plain owner-scoped, money-bearing collection", () => {
  it.each(MONEY_BEARING_COLLECTIONS)("owner can read and write their own %s document", async (collectionName) => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = doc(ownerDb, "users", OWNER_UID, collectionName, "doc-1");
    await assertSucceeds(setDoc(ref, { seeded: true }));
    await assertSucceeds(getDoc(ref));
  });

  it.each(MONEY_BEARING_COLLECTIONS)(
    "a different signed-in user cannot read another user's %s document",
    async (collectionName) => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "users", OWNER_UID, collectionName, "doc-1"), { seeded: true });
      });
      const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
      await assertFails(getDoc(doc(otherDb, "users", OWNER_UID, collectionName, "doc-1")));
    },
  );

  it.each(MONEY_BEARING_COLLECTIONS)(
    "a different signed-in user cannot create/overwrite another user's %s document",
    async (collectionName) => {
      const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
      await assertFails(setDoc(doc(otherDb, "users", OWNER_UID, collectionName, "doc-1"), { hacked: true }));
    },
  );

  it.each(MONEY_BEARING_COLLECTIONS)(
    "a different signed-in user cannot delete another user's %s document",
    async (collectionName) => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "users", OWNER_UID, collectionName, "doc-1"), { seeded: true });
      });
      const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
      await assertFails(deleteDoc(doc(otherDb, "users", OWNER_UID, collectionName, "doc-1")));
    },
  );

  it.each(MONEY_BEARING_COLLECTIONS)(
    "an unauthenticated request cannot read or write a %s document",
    async (collectionName) => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "users", OWNER_UID, collectionName, "doc-1"), { seeded: true });
      });
      const anonDb = testEnv.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(anonDb, "users", OWNER_UID, collectionName, "doc-1")));
      await assertFails(setDoc(doc(anonDb, "users", OWNER_UID, collectionName, "doc-1"), { x: 1 }));
    },
  );
});

/**
 * The blanket `{document=**}` on each money-bearing collection's rule also
 * covers its nested subcollections — statements/paymentBreakdowns are
 * already covered above; these are the remaining money-bearing
 * subcollections (ledger entries, bill occurrences/payments, loan/EMI
 * installments) that had no direct test of their own inherited scoping.
 */
describe("nested money-bearing subcollections inherit the same owner-scoping", () => {
  it("owner can read/write their own person's ledger entry", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = doc(ownerDb, "users", OWNER_UID, "people", "person-1", "ledger", "entry-1");
    await assertSucceeds(setDoc(ref, { amount: 500, type: "gave" }));
    await assertSucceeds(getDoc(ref));
  });

  it("a different signed-in user cannot read another user's ledger entry", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "people", "person-1", "ledger", "entry-1"), {
        amount: 500,
      });
    });
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, "users", OWNER_UID, "people", "person-1", "ledger", "entry-1")));
  });

  it("owner can read/write their own bill occurrence", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = doc(ownerDb, "users", OWNER_UID, "bills", "bill-1", "occurrences", "occ-1");
    await assertSucceeds(setDoc(ref, { amountDue: 1200 }));
    await assertSucceeds(getDoc(ref));
  });

  it("a different signed-in user cannot write another user's bill payment record", async () => {
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(setDoc(doc(otherDb, "users", OWNER_UID, "bills", "bill-1", "payments", "pay-1"), { amount: 500 }));
  });

  it("owner can read/write their own loan's payment-schedule installment", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = doc(ownerDb, "users", OWNER_UID, "paymentSchedules", "sched-1", "installments", "inst-1");
    await assertSucceeds(setDoc(ref, { amountDue: 5000 }));
    await assertSucceeds(getDoc(ref));
  });

  it("a different signed-in user cannot read another user's payment-schedule installment", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), "users", OWNER_UID, "paymentSchedules", "sched-1", "installments", "inst-1"),
        { amountDue: 5000 },
      );
    });
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      getDoc(doc(otherDb, "users", OWNER_UID, "paymentSchedules", "sched-1", "installments", "inst-1")),
    );
  });

  it("a different signed-in user cannot write another user's shared-credit-limit document", async () => {
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(otherDb, "users", OWNER_UID, "sharedCreditLimits", "limit-1"), { creditLimit: 100000 }),
    );
  });
});

describe("statements/paymentBreakdowns reads (hooks/use-credit-cards.ts)", () => {
  // A collectionGroup() `list` query cannot be scoped to the signed-in
  // user by security rules — statements/paymentBreakdowns carry no uid
  // field, and path-based rules only apply to single-document `get`, not
  // `list` (confirmed against the Rules emulator: "Variable is not bound
  // in path template. for 'list'"). hooks/use-credit-cards.ts was fixed to
  // fan out one watchAll per card/EMI instead — these tests assert that
  // fallback path is (and stays) covered by the existing owner-scoped
  // creditCards/emis rules, and document why the collectionGroup form is
  // permanently denied rather than something to "fix" in rules.
  it("owner can list their own statements under one card (the fixed client's per-card watchAll path)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), "users", OWNER_UID, "creditCards", "card-1", "statements", "stmt-1"),
        { cardId: "card-1", deletedAt: null },
      );
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = collection(ownerDb, "users", OWNER_UID, "creditCards", "card-1", "statements");
    const snap = await assertSucceeds(getDocs(query(ref, where("deletedAt", "==", null))));
    expect(snap.size).toBe(1);
  });

  it("owner can list their own EMI paymentBreakdowns under one EMI (the fixed client's per-EMI watchAll path)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "emis", "emi-1", "paymentBreakdowns", "pb-1"), {
        deletedAt: null,
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = collection(ownerDb, "users", OWNER_UID, "emis", "emi-1", "paymentBreakdowns");
    const snap = await assertSucceeds(getDocs(query(ref, where("deletedAt", "==", null))));
    expect(snap.size).toBe(1);
  });

  it("a collectionGroup query across statements is denied even for the owner (no uid field to scope on)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), "users", OWNER_UID, "creditCards", "card-1", "statements", "stmt-1"),
        { cardId: "card-1", deletedAt: null },
      );
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(getDocs(query(collectionGroup(ownerDb, "statements"), where("deletedAt", "==", null))));
  });
});

describe("financialDocuments (Architecture §14, backlog M1-T1)", () => {
  it("owner can read their own financialDocuments doc", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "financialDocuments", "doc-1"), {
        userId: OWNER_UID,
        status: "parsed",
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(getDoc(doc(ownerDb, "users", OWNER_UID, "financialDocuments", "doc-1")));
  });

  it("a different signed-in user cannot read another user's financialDocuments doc", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "financialDocuments", "doc-1"), {
        userId: OWNER_UID,
        status: "parsed",
      });
    });
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, "users", OWNER_UID, "financialDocuments", "doc-1")));
  });

  it("even the owner cannot write directly — worker/Import Engine only", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      setDoc(doc(ownerDb, "users", OWNER_UID, "financialDocuments", "doc-1"), {
        userId: OWNER_UID,
        status: "imported", // a client trying to fabricate a completed import
      }),
    );
  });

  it("owner cannot write to the importHistory subcollection", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "financialDocuments", "doc-1"), {
        userId: OWNER_UID,
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      setDoc(doc(ownerDb, "users", OWNER_UID, "financialDocuments", "doc-1", "importHistory", "h-1"), {
        importId: "imp-1",
      }),
    );
  });
});

describe("documentImports staging (Architecture §10.1, backlog M8/M1-T1)", () => {
  it("a client cannot create a documentImports doc directly (worker-only)", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      setDoc(doc(ownerDb, "users", OWNER_UID, "documentImports", "imp-1"), {
        userId: OWNER_UID,
        status: "draft",
      }),
    );
  });

  it("owner CAN update a staged import while it stays in draft/reviewing", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "documentImports", "imp-1"), {
        userId: OWNER_UID,
        status: "draft",
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID, "documentImports", "imp-1"), { status: "reviewing" }),
    );
  });

  it("owner CANNOT self-promote a staged import straight to committed", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "documentImports", "imp-1"), {
        userId: OWNER_UID,
        status: "reviewing",
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID, "documentImports", "imp-1"), { status: "committed" }),
    );
  });

  it("owner can edit staged records directly (Review Workspace)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "documentImports", "imp-1"), {
        userId: OWNER_UID,
        status: "reviewing",
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(
      setDoc(doc(ownerDb, "users", OWNER_UID, "documentImports", "imp-1", "records", "rec-1"), {
        category: "Food",
      }),
    );
  });

  it("owner can delete a draft/reviewing import (discard, non-destructive Review)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "documentImports", "imp-1"), {
        userId: OWNER_UID,
        status: "draft",
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(deleteDoc(doc(ownerDb, "users", OWNER_UID, "documentImports", "imp-1")));
  });
});

describe("smsTransactionCandidates (SMS Transaction Intelligence, Phase 3)", () => {
  // Plain owner-scoped CRUD — this must match Finance_App/firestore.rules'
  // `match /users/{uid}/smsTransactionCandidates/{document=**} { allow read, write: if isOwner(uid); }`
  // exactly, since both apps deploy rules to the same Firebase project
  // (financeapp-585eb). Unlike the earlier, incorrect version of this rule
  // (a hand-invented status state machine that doesn't exist on the real
  // Android-written document — see docs/sms-candidate-contract.md), there is
  // no server-enforced field validation here: Android is the sole writer of
  // new candidates and is trusted the same way it's trusted for
  // transactions/accounts. The web app's only write is a full delete, via
  // `SmsTransactionCandidateRepository.deleteById` — see
  // features/transaction-candidates/lib/import-candidate.ts.
  it("owner can create a candidate (Android/dev-fixture write path)", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(
      setDoc(doc(ownerDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), {
        amount: 499,
        direction: "debit",
        eventType: "cardPurchase",
        source: "sms",
      }),
    );
  });

  it("owner can read their own candidates", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), { amount: 499 });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(getDoc(doc(ownerDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1")));
  });

  it("owner can update a candidate (e.g. Android re-syncing the same smsItemId as a full-document overwrite)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), { amount: 499 });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(
      setDoc(doc(ownerDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), { amount: 500, direction: "debit" }),
    );
  });

  it("owner can delete a candidate (the web app's post-import cleanup, or Android's own sync removal)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), { amount: 499 });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(deleteDoc(doc(ownerDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1")));
  });

  it("a different signed-in user cannot read, write, or delete another user's candidates", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), { amount: 499 });
    });
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1")));
    await assertFails(setDoc(doc(otherDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), { amount: 1 }));
    await assertFails(deleteDoc(doc(otherDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1")));
  });

  it("a signed-out client cannot read or write any candidate", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "smsTransactionCandidates", "sms-1"), { amount: 499 });
    });
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthedDb, "users", OWNER_UID, "smsTransactionCandidates", "sms-1")));
  });
});

describe("documentTypeRegistry (Architecture §3, backlog M1-T2)", () => {
  it("any signed-in user can read a registry entry", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "documentTypeRegistry", "credit_card_statement"), {
        displayName: "Credit Card Statement",
      });
    });
    const someDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(someDb, "documentTypeRegistry", "credit_card_statement")));
  });

  it("no client — including an authenticated one — can write to the registry", async () => {
    const someDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      setDoc(doc(someDb, "documentTypeRegistry", "credit_card_statement"), { displayName: "Tampered" }),
    );
  });

  it("an unauthenticated request cannot even read the registry", async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, "documentTypeRegistry", "credit_card_statement")));
  });
});

describe("global merchantMappings (Architecture §11.2, backlog M13-T2)", () => {
  it("any signed-in user can read a global mapping", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "merchantMappings", "amazon"), { canonicalName: "Amazon" });
    });
    const someDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(someDb, "merchantMappings", "amazon")));
  });

  it("no client can write to the global merchant mapping table directly (corroboration gate is server-side only)", async () => {
    const someDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(setDoc(doc(someDb, "merchantMappings", "amazon"), { canonicalName: "Amazon" }));
  });

  it("owner CAN write their own personal merchant mapping (learning loop write-side, M13-T1)", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(
      setDoc(doc(ownerDb, "users", OWNER_UID, "merchantMappings", "swiggy-instamart"), {
        canonicalName: "Groceries",
        userConfirmed: true,
      }),
    );
  });
});

describe("pdfAnalyzerConfig (PDF Analyzer saved password)", () => {
  it("owner can write and read their own card's config", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const ref = doc(ownerDb, "users", OWNER_UID, "pdfAnalyzerConfig", "card-1");
    await assertSucceeds(setDoc(ref, { updatedAt: new Date() }));
    await assertSucceeds(getDoc(ref));
  });

  it("a different signed-in user cannot read or write another user's card config", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "pdfAnalyzerConfig", "card-1"), {
        updatedAt: new Date(),
      });
    });
    const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(otherDb, "users", OWNER_UID, "pdfAnalyzerConfig", "card-1")));
    await assertFails(setDoc(doc(otherDb, "users", OWNER_UID, "pdfAnalyzerConfig", "card-1"), { updatedAt: new Date() }));
  });
});

describe("aiInsights (Architecture §17, backlog M12-T3)", () => {
  it("owner can dismiss an insight (the one client-writable field)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "aiInsights", "insight-1"), {
        userId: OWNER_UID,
        message: "Shopping increased 18%",
        dismissed: false,
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID, "aiInsights", "insight-1"), { dismissed: true }),
    );
  });

  it("owner cannot alter an insight's message (only the engine may compute that)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", OWNER_UID, "aiInsights", "insight-1"), {
        userId: OWNER_UID,
        message: "Shopping increased 18%",
        dismissed: false,
      });
    });
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID, "aiInsights", "insight-1"), {
        message: "Fabricated insight",
      }),
    );
  });

  it("a client cannot create an aiInsights doc directly", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertFails(
      setDoc(doc(ownerDb, "users", OWNER_UID, "aiInsights", "insight-2"), {
        userId: OWNER_UID,
        message: "Fabricated",
      }),
    );
  });
});
