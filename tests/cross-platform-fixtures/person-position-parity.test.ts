/**
 * Cross-platform parity for People positions. Finance_App's
 * `test/cross_platform_fixtures/person_position_parity_test.dart` loads a byte-identical copy of
 * `person-position-fixture.json`; both platforms must give identical per-person and total figures.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { peopleTotals, personPosition, type PersonPosition, type PositionLedgerEntry, type PositionLoan } from "@/lib/engines/person-position";

interface Fixture {
  personId: string;
  scenarios: { name: string; currentBalance: number; ledgerEntries: PositionLedgerEntry[]; loans: PositionLoan[]; expected: PersonPosition }[];
  totals: { positions: Pick<PersonPosition, "owesMe" | "iOwe">[]; expected: ReturnType<typeof peopleTotals> };
}

const fixture: Fixture = JSON.parse(readFileSync("tests/cross-platform-fixtures/person-position-fixture.json", "utf8"));

describe("person position golden fixture", () => {
  for (const s of fixture.scenarios) {
    it(s.name, () => {
      expect(
        personPosition({
          personId: fixture.personId,
          currentBalance: s.currentBalance,
          loans: s.loans,
          ledgerEntries: s.ledgerEntries,
          loanIds: new Set(s.loans.map((l) => l.id)),
        }),
      ).toEqual(s.expected);
    });
  }

  it("people totals", () => {
    expect(peopleTotals(fixture.totals.positions as PersonPosition[])).toEqual(fixture.totals.expected);
  });
});
