/**
 * Main-thread cost of the pure derived-value engines at synthetic volumes (plain Node, no Firestore).
 * This is CPU time of the calculation only — it excludes React render/commit, so it is a lower bound on
 * what a screen pays per data change, not a browser profile. Results go to PERF_OUT like the other timings.
 */
import { appendFileSync } from "node:fs";
import { describe, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {}, functions: {} }));

import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { income } from "@/lib/engines/dashboard-aggregation";
import { buildMySpendContext, mySpendRows, summarizeMySpend } from "@/lib/engines/my-spend";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { Transaction } from "@/lib/models/transaction";

const OUT = process.env.PERF_OUT;
const TAG = process.env.PERF_TAG ?? "run";
const NOW = new Date(2026, 9, 13, 12);
const MONTH = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31, 23, 59, 59, 999) };

function synthetic(n: number): Transaction[] {
  const out: Transaction[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      TransactionRepository.buildTransaction({
        type: i % 5 === 0 ? "income" : "expense",
        amount: 100 + (i % 900),
        dateTime: new Date(2024, 0, 1 + (i % 1000), 9, i % 60),
        accountId: `acct-${i % 12}`,
        categoryId: `cat-${i % 20}`,
        description: `Synthetic ${i}`,
      }),
    );
  }
  return out;
}

function timeIt(name: string, n: number, fn: () => unknown) {
  const runs: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    fn();
    runs.push(performance.now() - t);
  }
  const s = [...runs.slice(1)].sort((a, b) => a - b);
  const row = { tag: TAG, scenario: `${name} (${n} txns)`, cold: +runs[0].toFixed(2), median: +s[Math.floor(s.length / 2)].toFixed(2), p95: +s[Math.ceil(0.95 * s.length) - 1].toFixed(2) };
  console.log(`[perf] ${JSON.stringify(row)}`);
  if (OUT) appendFileSync(OUT, JSON.stringify(row) + "\n");
}

describe("engine CPU timing (synthetic)", () => {
  for (const n of [5_000, 20_000]) {
    it(`${n} transactions`, () => {
      const transactions = synthetic(n);
      const cardIds = new Set(["acct-3"]);
      timeIt("cash flow this month", n, () =>
        cashFlowThisMonth({ transactions: cashFlowTransactions(transactions, cardIds), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: NOW }),
      );
      timeIt("month-cycle income", n, () => income(monthCycleDashboardTransactions(transactions, cardIds), { kind: "customRange" }, MONTH));
      const ctx = buildMySpendContext({ expenses: [] });
      timeIt("my-spend summary", n, () => summarizeMySpend(mySpendRows({ transactions, ctx, bucketDate: (t) => t.dateTime, range: MONTH })));
    });
  }
});
