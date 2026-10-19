/**
 * Monthly Settlement PDF over REAL stored data (Firestore emulator, real repositories, synthetic data). The October
 * statement for SANJU: four Jun–Sep items (₹6,575.52) cleared by ONE Record Payment on 15 Oct together with ₹3,000 of
 * October's Bajaj Finance item; five October obligations (₹19,828.88); Super Money and the interest postponed to the
 * Nov cycle through the real `PaymentDeferralRepository`. The statement is built from what the emulator returns
 * (ledger entries, deferrals) — the same inputs the workspace hooks feed `statementView` — and the PDF is rendered
 * from it. Pins: nothing financial changes by generating the PDF, the figures tie to the People Ledger, the cleared
 * earlier items collapse into one row, postponed ≠ collectible now.
 *
 * Run via `npm run test:integration` (or `firebase emulators:exec --only firestore "cross-env VITEST_INTEGRATION=1 vitest run tests/integration/monthly-settlement-pdf.test.ts"`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, Timestamp, type Firestore } from "firebase/firestore";
import { PDFDocument } from "pdf-lib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { monthlySettlementView } from "@/features/people/lib/monthly-settlement-model";
import { renderMonthlySettlementPdf } from "@/features/people/lib/monthly-settlement-pdf";
import { statementView, type StatementDeferral } from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining, type StatementLedgerEntry } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cycleName, deferralView, type PostponeRequest } from "@/lib/engines/person-payment-deferral";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { installmentFromFirestore, installmentPaymentFromFirestore, installmentPaymentToFirestore, installmentToFirestore } from "@/lib/models/payment-schedule";
import { advanceApplicationFromFirestore, advanceApplicationToFirestore, ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore, type LedgerEntry } from "@/lib/models/person";
import { paymentDeferralFromData } from "@/lib/models/person-payment-deferral";
import { purposeFundFromFirestore, purposeFundToFirestore } from "@/lib/models/purpose-fund";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { PaymentDeferralRepository } from "@/lib/repositories/payment-deferral-repository";
import { InstallmentPaymentRepository, InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { doc } from "firebase/firestore";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const PROJECT_ID = "flowfi-monthly-settlement-pdf";
const UID = "monthly-settlement-owner";
const SD = 1; // calendar-month cycle
const NOW = new Date(2026, 9, 20);
const NOV = cycleContaining(new Date(2026, 10, 1), SD);

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const col = (...path: string[]) => collection(db, "users", UID, ...(path as [string]));
  const accounts = new AccountRepository(col("accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactions = new TransactionRepository(col("transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }), accounts);
  const people = new PersonRepository(col("people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) => new LedgerRepository(col("people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
  const installments = (scheduleId: string) =>
    new InstallmentRepository(col("paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const paymentsFor = (personId: string) =>
    new PersonPaymentRepository({
      personRepository: people,
      ledgerRepository: ledgerFor(personId),
      transactionRepository: transactions,
      advanceApplications: col("people", personId, "advanceApplications").withConverter({ toFirestore: advanceApplicationToFirestore, fromFirestore: advanceApplicationFromFirestore }),
      expenseDocRef: (id) => doc(col("expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore }), id),
      installmentDocRef: (scheduleId, id) => installments(scheduleId).docRef(id),
      installmentPaymentDocRef: (scheduleId, installmentId, paymentId) =>
        new InstallmentPaymentRepository(
          col("paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore }),
          installments(scheduleId),
        ).docRef(paymentId),
      cashLegCategoryId: "personal-loan",
      purposeFunds: col("people", personId, "purposeFunds").withConverter({ toFirestore: purposeFundToFirestore, fromFirestore: purposeFundFromFirestore }),
    });
  return { db, accounts, transactions, people, ledgerFor, paymentsFor, deferrals: new PaymentDeferralRepository(db, UID) };
}
type R = ReturnType<typeof setup>;

const EARLIER = [
  ["b9", 1643.88, new Date(2026, 5, 5, 10), "Bajaj Finance - Jun"],
  ["b10", 1643.88, new Date(2026, 6, 5, 10), "Bajaj Finance - Jul"],
  ["b11", 1643.88, new Date(2026, 7, 5, 10), "Bajaj Finance - Aug"],
  ["b12", 1643.88, new Date(2026, 8, 5, 10), "Bajaj Finance - Sep"],
] as const;
const OCTOBER = [
  ["given", 10000, new Date(2026, 9, 3, 10), "Given to Sanju"],
  ["interest", 1000, new Date(2026, 9, 4, 10), "Interest for ₹10,000"],
  ["bajaj", 3643.88, new Date(2026, 9, 5, 10), "Bajaj Finance - Oct"],
  ["super", 2185, new Date(2026, 9, 8, 10), "Super Money"],
  ["groceries", 3000, new Date(2026, 9, 9, 10), "Groceries"],
] as const;

async function seed(r: R) {
  const bank = await r.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 100_000, colorValue: 0 });
  const sanju = await r.people.createPerson({ name: "SANJU", avatarColorValue: 0, openingBalance: 0 });
  const ids: Record<string, string> = {};
  for (const [name, amount, date, note] of [...EARLIER, ...OCTOBER]) {
    const person = (await r.people.getByKey(sanju.id))!;
    const { entry } = await r.ledgerFor(sanju.id).addEntryWithTransaction(person, { type: "gave", amount, date, note }, { type: "expense", accountId: bank.id, categoryId: "personal-loan" }, r.transactions);
    ids[name] = entry.id;
  }
  return { bank, sanju, ids };
}

const entriesOf = async (r: R, personId: string) => (await getDocs(collection(r.db, "users", UID, "people", personId, "ledger"))).docs.map((s) => ledgerEntryFromFirestore(s)) as LedgerEntry[];

/** Every financial document, serialized — what generating a PDF must never change. */
async function snapshot(r: R, personId: string) {
  const out: Record<string, unknown> = {};
  for (const path of [["accounts"], ["transactions"], ["people"], ["people", personId, "ledger"], ["people", personId, "paymentDeferrals"], ["people", personId, "advanceApplications"]]) {
    for (const s of (await getDocs(collection(r.db, "users", UID, ...(path as [string])))).docs) {
      out[[...path, s.id].join("/")] = JSON.parse(JSON.stringify(s.data(), (_k, v) => (v instanceof Timestamp ? `ts:${v.toMillis()}` : v)));
    }
  }
  return out;
}

function postpone(personId: string, key: string, title: string, date: Date, left: number, requestId: string): PostponeRequest {
  return { action: "postpone", requestId, expectedRevision: 0, personId, obligationKey: `ledger:${key}`, obligationTitle: title, now: NOW, startDay: SD, obligationDate: date, remaining: left, target: NOV, reason: null, note: null, reminder: null };
}

/** The statement + options exactly as the workspace builds them, from what the emulator returns. */
async function load(r: R, personId: string, cycleOf = NOW) {
  const entries = await entriesOf(r, personId);
  const stored = (await getDocs(collection(r.db, "users", UID, "people", personId, "paymentDeferrals"))).docs.map((s) => paymentDeferralFromData(s.id, s.data()));
  const base = { person: { id: personId, name: "SANJU", openingBalance: 0, createdAt: new Date(2026, 0, 1) }, ledgerEntries: entries as StatementLedgerEntry[], loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
  const statement = buildPersonCycleStatement({ ...base, cycle: cycleContaining(cycleOf, SD) });
  const history = buildPersonCycleStatement({ ...base, cycle: { start: new Date(1970, 0, 1), end: cycleContaining(NOW, SD).end } });
  const remainingByKey = new Map(history.rows.map((x) => [x.key, x.remainingNow ?? 0]));
  // As `DeferralContext` does: the live status of each active deferral, read at today's date.
  const views = new Map(stored.map((d) => [d.obligationKey, deferralView(d, remainingByKey.get(d.obligationKey), SD, NOW)]));
  const lookups = { entriesById: new Map(entries.map((e) => [e.id, e])), expenseByTransactionId: new Map() } as unknown as SettlementLookups;
  const options = {
    entries,
    history,
    lookups,
    now: NOW,
    cycleStartDay: SD,
    ownerName: "Abin John",
    deferralFor: (key: string, date: Date): StatementDeferral | null => {
      const v = views.get(key);
      if (!v || v.status === "resolved") return null;
      return { status: v.status, name: cycleName(v.cycle), from: cycleName(cycleContaining(date, SD)) };
    },
  };
  return { statement, options };
}

describe("SANJU — October monthly settlement from real stored data", () => {
  it("cleared Jun–Sep items collapse; ₹16,828.88 outstanding = ₹13,643.88 due now + ₹3,185 moved to Nov; the PDF changes no stored data", async () => {
    const r = setup();
    const { bank, sanju, ids } = await seed(r);
    const person = (await r.people.getByKey(sanju.id))!;

    // ONE Record Payment (15 Oct): the four earlier items in full + ₹3,000 of October's Bajaj Finance item.
    await r.paymentsFor(sanju.id).recordPayment(person, {
      direction: "theyPaid",
      amount: 9575.52,
      date: new Date(2026, 9, 15, 9),
      accountId: bank.id,
      lines: [
        ...EARLIER.map(([k, amount]) => ({ key: `ledger:${ids[k]}`, amount, route: { kind: "entry" as const, parentEntryId: ids[k] } })),
        { key: `ledger:${ids.bajaj}`, amount: 3000, route: { kind: "entry" as const, parentEntryId: ids.bajaj } },
      ],
      extra: null,
    });
    // Postpone Super Money and the interest to the Nov cycle (the real write path).
    const left = (await load(r, sanju.id)).options.history.rows;
    const remaining = (id: string) => left.find((x) => x.key === `ledger:${id}`)?.remainingNow ?? 0;
    expect((await r.deferrals.apply(postpone(sanju.id, ids.super, "Super Money", OCTOBER[3][2], remaining(ids.super), "req-super"))).outcome).toBe("written");
    expect((await r.deferrals.apply(postpone(sanju.id, ids.interest, "Interest", OCTOBER[1][2], remaining(ids.interest), "req-int"))).outcome).toBe("written");

    const before = await snapshot(r, sanju.id);
    const { statement, options } = await load(r, sanju.id);
    expect(statement.cycleLabel).toBe("01 Oct – 31 Oct 2026");
    expect([statement.previousPending, statement.cycleActivity, statement.cycleSettlements, statement.amount]).toEqual([6575.52, 19828.88, -9575.52, 16828.88]);

    const monthly = monthlySettlementView(statement, options);
    // The shareable table: October's five obligations only — the four cleared Jun–Sep rows are stated in the reconciliation.
    expect(monthly.items.map((i) => [i.group, i.title])).toEqual([
      ["cycle", "Given to Sanju"],
      ["cycle", "Interest for ₹10,000"],
      ["cycle", "Bajaj Finance - Oct"],
      ["cycle", "Super Money"],
      ["cycle", "Groceries"],
    ]);
    expect(monthly.lines.map((l) => [l.key, l.value])).toEqual([["previous", money(6575.52)], ["new", money(19828.88)], ["applied", money(9575.52)], ["outstanding", money(16828.88)]]);
    expect(monthly.lines.find((l) => l.key === "applied")!.note).toBe(`${money(6575.52)} to earlier balance · ${money(3000)} to this cycle`);
    expect(monthly.items.find((i) => i.title === "Bajaj Finance - Oct")).toMatchObject({ paid: money(3000), remaining: money(643.88), status: "Part paid" });
    expect(monthly.split).toEqual({ dueNow: money(13643.88), postponed: money(3185), postponedTo: "Moved to November" });
    expect(monthly.cleared).toEqual({ count: 4, amount: money(6575.52), range: "Jun–Sep" });
    expect(monthly.payments).toHaveLength(1);
    expect(monthly.payments[0].lines.map((l) => [l.label, l.amount, l.tail])).toEqual([["Earlier balance · 4 items", money(6575.52), "cleared"], ["Bajaj Finance - Oct", money(3000), `${money(643.88)} left`]]);
    expect(monthly.checks).toEqual({ reconciles: true, itemsAddUp: true, unitemisedPaise: 0 });

    // Agrees with the People Ledger (same statementView, same cycle, same as-of date) and with the stored person balance.
    const ledger = statementView(statement, options);
    expect(monthly.outstanding).toBe(ledger.amount);
    expect(monthly.asOf).toBe(ledger.asOf);
    expect((await r.people.getByKey(sanju.id))!.currentBalance).toBe(16828.88);

    // The PDF: one A4 portrait page; generating it writes nothing.
    const bytes = await renderMonthlySettlementPdf(statement, options);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(await snapshot(r, sanju.id)).toEqual(before);

    // An earlier cycle selected explicitly stays that cycle (never the generation date's).
    const sep = await load(r, sanju.id, new Date(2026, 8, 15));
    const sepMonthly = monthlySettlementView(sep.statement, sep.options);
    expect(sep.statement.cycleLabel).toBe("01 Sep – 30 Sep 2026");
    expect(sepMonthly.outstanding).toBe(money(6575.52)); // read at 30 Sep: the 15 Oct payment is not in it
    // At 30 Sep nothing was paid yet: Jun–Aug are genuinely open (kept as rows, never hidden), September is new.
    expect(sepMonthly.items.map((i) => [i.group, i.title])).toEqual([
      ["earlier", "Bajaj Finance - Jun"],
      ["earlier", "Bajaj Finance - Jul"],
      ["earlier", "Bajaj Finance - Aug"],
      ["cycle", "Bajaj Finance - Sep"],
    ]);
    expect(sepMonthly.payments).toHaveLength(0);
  });
});
