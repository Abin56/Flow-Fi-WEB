import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPersonCycleStatement, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { allocatePayment, type PaymentObligation } from "@/lib/engines/person-payment";
import type { LedgerEntry } from "@/lib/models/person";

/**
 * Golden People Ledger payment / advance rule — the same fixture Flutter's
 * `person_payment_parity_test.dart` reads (byte-identical copy), so both engines give one answer.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture: Json = JSON.parse(readFileSync(path.join(__dirname, "person-payment-fixture.json"), "utf8"));

const day = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

function ledgerEntry(j: Json): LedgerEntry {
  return {
    id: j.id, personId: fixture.person.id, type: j.type, amount: j.amount, date: day(j.date), createdAt: day(j.createdAt),
    note: j.note ?? "", increasesBalance: true, transactionRef: j.transactionRef ?? null, parentEntryId: j.parentEntryId ?? null,
    sourceKind: j.sourceKind, obligationRef: j.obligationRef ?? null, paymentId: j.paymentId ?? null,
    receivedStatus: "yetToReceive", deletedAt: null, lastEditedAt: null, editHistory: [],
  };
}

const cycles: Record<string, StatementCycle> = Object.fromEntries(
  Object.entries(fixture.cycles as Json).map(([k, v]) => [k, { start: day(v.start), end: day(v.end) }]),
);

describe("person payment parity fixture", () => {
  for (const c of fixture.statementCases as Json[]) {
    for (const [cycleName, expected] of Object.entries(c.expect as Json)) {
      it(`${c.name} — ${cycleName}`, () => {
        const s = buildPersonCycleStatement({
          person: { id: fixture.person.id, name: "Amma", openingBalance: fixture.person.openingBalance, createdAt: day(fixture.person.createdAt) },
          ledgerEntries: (c.ledger as string[]).map((id) => ledgerEntry(fixture.ledger[id])),
          loanIds: new Set(),
          emis: (fixture.emis as Json[]).map((e) => ({ ...e, isClosed: false, deletedAt: null })) as never,
          loans: [],
          installments: (c.installments as string[]).map((id) => {
            const i = fixture.installments[id];
            return { ...i, dueDate: day(i.dueDate), createdAt: day(i.createdAt), isSkipped: false, deletedAt: null };
          }),
          advanceApplications: (c.applications as string[]).map((id) => {
            const a = fixture.applications[id];
            return { ...a, date: day(a.date), createdAt: day(a.createdAt), deletedAt: null };
          }),
          cycle: cycles[cycleName],
          now: day("2026-10-01"),
        });
        const e = expected as Json;
        for (const k of ["previousPending", "cycleActivity", "cycleSettlements", "currentPending", "previousAdvance", "advanceBalance", "cashReceived", "cashPaid"]) {
          expect((s as unknown as Json)[k], k).toBe(e[k]);
        }
        for (const [key, remaining] of Object.entries(e.remainingNow as Json)) {
          expect(s.rows.find((r) => r.key === key)?.remainingNow, key).toBe(remaining);
        }
      });
    }
  }

  const obligations: PaymentObligation[] = (fixture.allocationObligations as Json[]).map((o) => ({
    ...o, date: day(o.date), createdAt: day(o.createdAt),
  })) as PaymentObligation[];
  for (const c of fixture.allocationCases as Json[]) {
    it(`allocation — ${c.name}`, () => {
      const a = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: c.amount, manual: c.manual ?? null });
      expect(a.lines.map((l) => [l.key, l.amount])).toEqual(c.expect.lines);
      for (const k of ["selectedTotal", "allocated", "extra", "unpaid", "outcome"]) expect((a as unknown as Json)[k], k).toBe(c.expect[k]);
      expect(a.error).toBeNull();
    });
  }
});
