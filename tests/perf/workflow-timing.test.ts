/**
 * Workflow timing against the Firestore emulator, optionally behind a latency-injecting proxy.
 *
 *   PERF_ONE_WAY_MS=0   → talks to the emulator directly (≈ server + SDK cost only)
 *   PERF_ONE_WAY_MS=40  → every network chunk is delayed 40 ms each way (≈ 80 ms RTT)
 *
 * Synthetic data only, in the emulator. Results are printed and appended (JSON lines) to PERF_OUT.
 * Run: `npm run test:perf`.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where } from "firebase/firestore";
import { afterAll, beforeAll, describe, it } from "vitest";

import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type Installment,
} from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { startLatencyProxy, type LatencyProxy } from "./latency-proxy";

const UID = "perf-owner-uid";
const ONE_WAY_MS = Number(process.env.PERF_ONE_WAY_MS ?? 0);
const SAMPLES = Number(process.env.PERF_SAMPLES ?? 12);
const TAG = process.env.PERF_TAG ?? "run";
const OUT = process.env.PERF_OUT;

let setupEnv: RulesTestEnvironment;
let opEnv: RulesTestEnvironment;
let proxy: LatencyProxy | null = null;

beforeAll(async () => {
  const rules = readFileSync("firestore.rules", "utf8");
  setupEnv = await initializeTestEnvironment({ projectId: "flowfi-perf", firestore: { rules, host: "127.0.0.1", port: 8080 } });
  if (ONE_WAY_MS > 0) {
    proxy = await startLatencyProxy(8081, 8080, ONE_WAY_MS);
    opEnv = await initializeTestEnvironment({ projectId: "flowfi-perf", firestore: { rules, host: "127.0.0.1", port: 8081 } });
  } else {
    opEnv = setupEnv;
  }
});

afterAll(async () => {
  if (opEnv !== setupEnv) await opEnv.cleanup();
  await setupEnv.cleanup();
  await proxy?.close();
});

type Db = ReturnType<ReturnType<RulesTestEnvironment["authenticatedContext"]>["firestore"]>;

function repos(db: Db) {
  const accountsCol = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const txCol = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const accounts = new AccountRepository(accountsCol);
  const transactions = new TransactionRepository(txCol, accounts);
  const loanCol = collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore });
  const scheduleCol = collection(db, "users", UID, "paymentSchedules").withConverter({
    toFirestore: paymentScheduleToFirestore,
    fromFirestore: paymentScheduleFromFirestore,
  });
  const installmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(
      collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
        toFirestore: installmentToFirestore,
        fromFirestore: installmentFromFirestore,
      }),
    );
  const loans = new LoanRepository(loanCol, new PaymentScheduleRepository(scheduleCol), installmentRepositoryFor);
  const loanPayments = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);
  return { accounts, transactions, loans, loanPayments };
}

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

describe(`workflow timing (one-way ${ONE_WAY_MS} ms)`, () => {
  it("add expense / income / transfer", async () => {
    const direct = repos(setupEnv.authenticatedContext(UID).firestore());
    const a = await direct.accounts.createAccount({ name: "A", type: "bank", openingBalance: 1_000_000, colorValue: 0 });
    const b = await direct.accounts.createAccount({ name: "B", type: "bank", openingBalance: 1_000_000, colorValue: 0 });
    const r = repos(opEnv.authenticatedContext(UID).firestore());
    const exp: number[] = [];
    const inc: number[] = [];
    const xfer: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      exp.push(
        (await timed(() => r.transactions.createTransaction({ type: "expense", amount: 100 + i, dateTime: new Date(), accountId: a.id, categoryId: "c", idempotencyKey: `exp-${TAG}-${i}-aaaa` })))[1],
      );
      inc.push(
        (await timed(() => r.transactions.createTransaction({ type: "income", amount: 100 + i, dateTime: new Date(), accountId: a.id, categoryId: "c", idempotencyKey: `inc-${TAG}-${i}-aaaa` })))[1],
      );
      xfer.push(
        (
          await timed(() =>
            r.transactions.createTransferPairAtomic({
              amount: 50 + i,
              dateTime: new Date(),
              sourceAccountId: a.id,
              destinationAccountId: b.id,
              categoryId: "c",
              idempotencyKey: `xf-${TAG}-${i}-aaaa`,
            }),
          )
        )[1],
      );
    }
    report("add expense", exp);
    report("add income", inc);
    report("transfer (atomic pair)", xfer);
  }, 300_000);

  for (const count of [12, 60]) {
    it(`loan EMI record + reverse (${count} installments)`, async () => {
      const setupDb = setupEnv.authenticatedContext(UID).firestore();
      const direct = repos(setupDb);
      const acct = await direct.accounts.createAccount({ name: `L${count}`, type: "bank", openingBalance: 10_000_000, colorValue: 0 });
      const loan: Loan = await direct.loans.createLoan({
        loanAmount: 120000,
        loanDate: new Date("2026-01-01T00:00:00Z"),
        repaymentType: "installment",
        direction: "taken",
        category: "institutional",
        institutionName: "Bank",
        interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
        installmentFrequency: "monthly",
        installmentCount: count,
      });
      const snap = await getDocs(
        query(
          collection(setupDb, "users", UID, "paymentSchedules", loan.scheduleId, "installments").withConverter({
            toFirestore: installmentToFirestore,
            fromFirestore: installmentFromFirestore,
          }),
          where("deletedAt", "==", null),
        ),
      );
      const installments: Installment[] = snap.docs.map((d) => d.data()).sort((x, y) => x.sequenceNumber - y.sequenceNumber);
      const r = repos(opEnv.authenticatedContext(UID).firestore());
      const rec: number[] = [];
      const rev: number[] = [];
      const n = Math.min(SAMPLES, count);
      for (let i = 0; i < n; i++) {
        const [res, tRec] = await timed(() =>
          r.loanPayments.record({
            loan,
            scheduleInstallments: installments,
            accountId: acct.id,
            amount: installments[i].amountDue,
            date: new Date("2026-02-01T00:00:00Z"),
            idempotencyKey: `rec-${TAG}-${count}-${i}-aaaa`,
          }),
        );
        rec.push(tRec);
        const [, tRev] = await timed(() =>
          r.loanPayments.reversePayment({
            loan,
            transactionId: res.transactionId,
            paymentIds: res.paymentIds,
            installmentIds: res.installmentIds,
            reversalIdempotencyKey: `rev-${TAG}-${count}-${i}-aaaa`,
          }),
        );
        rev.push(tRev);
      }
      report(`loan EMI record (${count} inst.)`, rec);
      report(`loan payment reverse (${count} inst.)`, rev);
    }, 600_000);
  }
});
