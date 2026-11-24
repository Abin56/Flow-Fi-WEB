import { describe, expect, it } from "vitest";
import { matchRows } from "./match-engine";
import { record, reconRow } from "./test-fixtures";

/**
 * Matching runs on every decision and edit, so it must stay cheap on a real ledger. Measured 2026-11-24 on synthetic data:
 * the old per-row scan of every record took ~3.0 s for 1,000 statement rows × 50,000 transactions (and ~0.7 s for 500 × 20,000);
 * with records bucketed by day it takes ~0.25 s. The bound below is deliberately loose (CI machines vary) — it only catches
 * a return to the quadratic scan, not small slowdowns.
 */
describe("matchRows at ledger scale", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => reconRow({ id: `r${i}`, day: [2026, 10, 1 + (i % 28)], description: `SHOP ${i % 97} BANGALORE`, amount: 100 + ((i * 7) % 900), referenceNumber: i % 3 === 0 ? `${600000000000 + i}` : null }));
  const records = Array.from({ length: 50000 }, (_, i) =>
    record({ id: `t${i}`, iso: new Date(Date.UTC(2025, 0, 1 + (i % 700), 4)).toISOString(), amount: 100 + ((i * 13) % 900), description: `Shop ${i % 89} ref ${i}`, accountId: i % 3 === 0 ? "acc-card" : "acc-bank" } as never),
  );

  it("1,000 rows × 50,000 transactions finish well under the old quadratic cost", () => {
    const t0 = performance.now();
    const result = matchRows(rows, { accountId: "acc-card", records, decisions: {} });
    const ms = performance.now() - t0;
    expect(result).toHaveLength(1000);
    expect(ms).toBeLessThan(2500);
  });

  it("a record the user linked by hand outside the ±3-day window is still evaluated (manual-link window), and nothing else outside it is", () => {
    const far = record({ id: "far", iso: "2026-10-15T10:00:00+05:30", amount: 100, description: "Zomato", accountId: "acc-card" } as never);
    const row = reconRow({ id: "r1", day: [2026, 10, 24], description: "ZOMATO", amount: 100 });
    const unlinked = matchRows([row], { accountId: "acc-card", records: [far], decisions: {} })[0]!;
    expect(unlinked.candidates).toHaveLength(0); // 9 days away: not a candidate on its own
    const linked = matchRows([row], { accountId: "acc-card", records: [far], decisions: { r1: { kind: "link", linkedRecordId: "far", notSameAck: false, rejectedRecordIds: [], category: null, notes: "", bulkId: null } } })[0]!;
    expect(linked.candidates.map((c) => c.recordId)).toEqual(["far"]); // the user's own link may reach further
  });
});
