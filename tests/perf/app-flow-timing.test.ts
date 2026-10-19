/**
 * App-level workflow timing — goes through `repository-factory` (the same wiring the screens use, including
 * the card-bill People gate on transactions), with the browser Firebase client swapped for the emulator
 * (optionally behind the latency proxy — see workflow-timing.test.ts). Synthetic data only.
 *
 * Covers: People payment record/revert (incl. the category lookup the hook does first), card bill payment,
 * plain delete, and finding the Expense behind a transaction on the delete path (200 expenses on file).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, Timestamp } from "firebase/firestore";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/firebase/client", () => ({
  firebaseApp: {},
  auth: {},
  storage: {},
  functions: {},
  get db() {
    return holder.db;
  },
}));

import {
  createAccountRepository,
  createCategoryRepository,
  createExpenseRepository,
  createLedgerRepositoryFor,
  createPersonPaymentRepository,
  createPersonRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import { startLatencyProxy, type LatencyProxy } from "./latency-proxy";

const UID = "perf-app-uid";
const ONE_WAY_MS = Number(process.env.PERF_ONE_WAY_MS ?? 0);
const SAMPLES = Number(process.env.PERF_SAMPLES ?? 12);
const TAG = process.env.PERF_TAG ?? "run";
const OUT = process.env.PERF_OUT;

let setupEnv: RulesTestEnvironment;
let opEnv: RulesTestEnvironment;
let proxy: LatencyProxy | null = null;

beforeAll(async () => {
  const rules = readFileSync("firestore.rules", "utf8");
  setupEnv = await initializeTestEnvironment({ projectId: "flowfi-perf-app", firestore: { rules, host: "127.0.0.1", port: 8080 } });
  if (ONE_WAY_MS > 0) {
    proxy = await startLatencyProxy(8082, 8080, ONE_WAY_MS);
    opEnv = await initializeTestEnvironment({ projectId: "flowfi-perf-app", firestore: { rules, host: "127.0.0.1", port: 8082 } });
  } else {
    opEnv = setupEnv;
  }
});

afterAll(async () => {
  if (opEnv !== setupEnv) await opEnv.cleanup();
  await setupEnv.cleanup();
  await proxy?.close();
});

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { n: s.length, cold: +ms[0].toFixed(1), median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

function report(name: string, ms: number[]) {
  const row = { tag: TAG, oneWayMs: ONE_WAY_MS, scenario: name, ...stats(ms), warmMedian: ms.length > 1 ? stats(ms.slice(1)).median : null };
  console.log(`[perf] ${JSON.stringify(row)}`);
  if (OUT) appendFileSync(OUT, JSON.stringify(row) + "\n");
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

/** Runs `fn` with the app's `db` pointing at the setup (direct) or operation (maybe delayed) emulator connection. */
async function withDb<T>(env: RulesTestEnvironment, fn: () => Promise<T>): Promise<T> {
  holder.db = env.authenticatedContext(UID).firestore();
  return fn();
}

describe(`app-flow timing (one-way ${ONE_WAY_MS} ms)`, () => {
  it("People payment record + revert (with the hook's category lookup)", async () => {
    const entryIds: string[] = [];
    let personId = "";
    await withDb(setupEnv, async () => {
      const personRepo = createPersonRepository(UID);
      const person = await personRepo.createPerson({ name: "Amma", avatarColorValue: 0, openingBalance: 0 });
      personId = person.id;
      const ledger = createLedgerRepositoryFor(UID, person.id, personRepo);
      for (let i = 0; i < SAMPLES; i++) {
        const fresh = (await personRepo.getByKey(person.id))!;
        const entry = await ledger.addEntry(fresh, { type: "gave", amount: 1000, date: new Date(2026, 8, 20), note: `Loan ${i}` });
        entryIds.push(entry.id);
      }
      await createAccountRepository(UID).createAccount({ name: "Recv", type: "bank", openingBalance: 0, colorValue: 0 });
      await createCategoryRepository(UID).getOrCreatePersonalLoanCategory();
    });
    const accountId = await withDb(setupEnv, async () => (await createAccountRepository(UID).getAll())[0].id);

    const catOnly: number[] = [];
    const record: number[] = [];
    const flow: number[] = [];
    const revert: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const person = await withDb(setupEnv, async () => (await createPersonRepository(UID).getByKey(personId))!);
      await withDb(opEnv, async () => {
        const [category, tCat] = await timed(() => createCategoryRepository(UID).getOrCreatePersonalLoanCategory());
        catOnly.push(tCat);
        const repo = createPersonPaymentRepository(UID, personId, category.id);
        const [paymentId, tRec] = await timed(() =>
          repo.recordPayment(person, {
            direction: "theyPaid",
            amount: 1000,
            date: new Date(2026, 9, 1),
            accountId,
            lines: [{ key: entryIds[i], amount: 1000, route: { kind: "entry", parentEntryId: entryIds[i] } }],
            extra: null,
            idempotencyKey: `pp-${TAG}-${i}-aaaaaaaa`,
          }),
        );
        record.push(tRec);
        flow.push(tCat + tRec);
        const afterPerson = await withDb(setupEnv, async () => (await createPersonRepository(UID).getByKey(personId))!);
        holder.db = opEnv.authenticatedContext(UID).firestore();
        const [, tRev] = await timed(() => repo.revertPayment(afterPerson, paymentId, { blockIfAdvanceUsed: true }));
        revert.push(tRev);
      });
    }
    report("People: category lookup alone", catOnly);
    report("People: record payment (write only)", record);
    report("People: record payment (hook flow: lookup + write)", flow);
    report("People: revert payment", revert);
  }, 600_000);

  it("card bill payment + plain delete + find-expense-on-delete (200 expenses)", async () => {
    const ids = await withDb(setupEnv, async () => {
      const accounts = createAccountRepository(UID);
      const bank = await accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 1_000_000, colorValue: 0 });
      const card = await accounts.createAccount({ name: "Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
      const tx = createTransactionRepository(UID, accounts);
      // Card spend to pay off.
      for (let i = 0; i < 3; i++) {
        await tx.createTransaction({ type: "expense", amount: 5000, dateTime: new Date(2026, 8, 5 + i), accountId: card.id, categoryId: "c" });
      }
      // 200 stored expenses so the full-collection read has realistic weight (stored shape, synthetic values).
      const col = setupEnv.authenticatedContext(UID).firestore();
      for (let i = 0; i < 200; i++) {
        await setDoc(doc(col, "users", UID, "expenses", `exp-${i}`), {
          description: `Dinner ${i}`,
          totalAmount: 900,
          date: Timestamp.fromDate(new Date(2026, 8, 1)),
          categoryId: "c",
          accountId: bank.id,
          transactionId: `txn-seed-${i}`,
          splitType: "equal",
          participants: [],
          scheduleId: null,
          notes: "",
          createdAt: Timestamp.fromDate(new Date(2026, 8, 1)),
          deletedAt: null,
          lastEditedAt: null,
          editHistory: [],
        });
      }
      return { bank: bank.id, card: card.id };
    });

    const pay: number[] = [];
    const del: number[] = [];
    const find: number[] = [];
    await withDb(opEnv, async () => {
      const accounts = createAccountRepository(UID);
      const tx = createTransactionRepository(UID, accounts);
      const expenses = createExpenseRepository(UID, accounts);
      for (let i = 0; i < SAMPLES; i++) {
        pay.push(
          (
            await timed(() =>
              tx.createTransferPairAtomic({
                amount: 100 + i,
                dateTime: new Date(2026, 9, 10),
                sourceAccountId: ids.bank,
                destinationAccountId: ids.card,
                categoryId: "c",
                idempotencyKey: `cardpay-${TAG}-${i}-aaaa`,
              }),
            )
          )[1],
        );
        const created = await tx.createTransaction({ type: "expense", amount: 10, dateTime: new Date(2026, 9, 11), accountId: ids.bank, categoryId: "c" });
        del.push((await timed(() => tx.softDeleteTransaction(created)))[1]);
        // The lookup `deleteTransactionWithLinkedEffects` does when the caller doesn't already hold the Expense.
        const lookup = async () => {
          const repo = expenses as unknown as { findActiveByTransactionId?: (id: string) => Promise<unknown> };
          if (typeof repo.findActiveByTransactionId === "function") return repo.findActiveByTransactionId(created.id);
          return (await expenses.getAll()).find((e) => e.transactionId === created.id && e.deletedAt == null) ?? null;
        };
        find.push((await timed(lookup))[1]);
      }
    });
    report("card bill payment (transfer bank→card, gated)", pay);
    report("delete plain transaction", del);
    report("find expense behind a transaction (200 expenses)", find);
  }, 600_000);
});

describe(`post-write derived refresh (one-way ${ONE_WAY_MS} ms)`, () => {
  it("loanPrincipalPrepaid refresh across 5 loans x 24 installments", async () => {
    const { createInstallmentPaymentRepositoryFor, createInstallmentRepositoryFor, createLoanRepository } = await import("@/lib/repositories/repository-factory");
    const { principalPrepaidFor } = await import("@/lib/engines/loan-outstanding");
    const { fetchPrincipalPrepaidByLoan } = await import("@/hooks/use-loan-principal-prepaid");
    type LoanT = Awaited<ReturnType<ReturnType<typeof createLoanRepository>["createLoan"]>>;
    const loans: LoanT[] = [];
    await withDb(setupEnv, async () => {
      for (let i = 0; i < 5; i++) {
        loans.push(
          await createLoanRepository(UID).createLoan({
            loanAmount: 240000,
            loanDate: new Date("2026-01-01T00:00:00Z"),
            repaymentType: "installment",
            direction: "taken",
            category: "institutional",
            institutionName: `Bank ${i}`,
            interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
            installmentFrequency: "monthly",
            installmentCount: 24,
          }),
        );
      }
    });
    // The query function as it was before the active/retired reads were issued together (kept as the "before" reference).
    const legacy = async () => {
      const result = new Map<string, number>();
      await Promise.all(
        loans.map(async (loan) => {
          const installmentRepository = createInstallmentRepositoryFor(UID, loan.scheduleId);
          const all = [...(await installmentRepository.getAll()), ...(await installmentRepository.getTrash())];
          const payments = await Promise.all(all.map((i) => createInstallmentPaymentRepositoryFor(UID, loan.scheduleId, i.id, installmentRepository).getAll()));
          result.set(loan.id, principalPrepaidFor(payments.flat()));
        }),
      );
      return result;
    };
    const before: number[] = [];
    const after: number[] = [];
    await withDb(opEnv, async () => {
      for (let i = 0; i < SAMPLES; i++) {
        before.push((await timed(legacy))[1]);
        after.push((await timed(() => fetchPrincipalPrepaidByLoan(UID, loans)))[1]);
      }
    });
    report("derived refresh: prepaid, legacy (5 loans x 24)", before);
    report("derived refresh: prepaid, current (5 loans x 24)", after);
  }, 600_000);
});
