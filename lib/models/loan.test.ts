import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  loanCategoryFromName,
  loanDirectionFromName,
  loanFromFirestore,
  loanToFirestore,
  type Loan,
} from "./loan";

/**
 * Regression coverage for the `direction`/`category` port from the Flutter
 * app's Loans feature. NOTE — the web app's fallback defaults are
 * *web-specific*, not copied from Flutter: every pre-existing web loan is an
 * institutional/bank loan (using the find-or-create-person hack
 * `features/loans/hooks/use-loans-data.ts` used to work around `personId`
 * being required), so a missing `direction`/`category` here means
 * "taken"/"institutional" — the opposite of Flutter's own "given"/"personal"
 * defaults, which are correct for Flutter's own (person-to-person lending)
 * history. See `loanDirectionFromName`/`loanCategoryFromName`'s doc comments.
 */

function fakeSnapshot(data: Record<string, unknown>) {
  return {
    id: "loan-1",
    data: () => data,
  } as unknown as Parameters<typeof loanFromFirestore>[0];
}

const baseFirestoreData = {
  personId: "person-1",
  loanAmount: 2000,
  interest: null,
  loanDate: Timestamp.fromDate(new Date("2025-01-01T00:00:00.000Z")),
  repaymentType: "oneTime",
  dueDate: Timestamp.fromDate(new Date("2025-02-01T00:00:00.000Z")),
  installmentFrequency: null,
  installmentCount: null,
  notes: "",
  scheduleId: "schedule-legacy",
  isClosed: false,
  createdAt: Timestamp.fromDate(new Date("2025-01-01T00:00:00.000Z")),
};

describe("loanDirectionFromName", () => {
  it("passes through a recognized direction", () => {
    expect(loanDirectionFromName("given")).toBe("given");
    expect(loanDirectionFromName("taken")).toBe("taken");
  });

  it("falls back to taken for undefined/unrecognized names — every pre-existing web loan is institutional/borrowed", () => {
    expect(loanDirectionFromName(undefined)).toBe("taken");
    expect(loanDirectionFromName(null)).toBe("taken");
    expect(loanDirectionFromName("garbage")).toBe("taken");
  });
});

describe("loanCategoryFromName", () => {
  it("passes through a recognized category", () => {
    expect(loanCategoryFromName("personal")).toBe("personal");
    expect(loanCategoryFromName("institutional")).toBe("institutional");
  });

  it("falls back to institutional for undefined/unrecognized names", () => {
    expect(loanCategoryFromName(undefined)).toBe("institutional");
    expect(loanCategoryFromName(null)).toBe("institutional");
    expect(loanCategoryFromName("garbage")).toBe("institutional");
  });
});

describe("loanFromFirestore — direction/category backward compatibility", () => {
  it("a legacy document with no direction/category/institution fields loads as taken/institutional, keeping its existing personId", () => {
    const loan = loanFromFirestore(fakeSnapshot(baseFirestoreData));

    expect(loan.direction).toBe("taken");
    expect(loan.category).toBe("institutional");
    expect(loan.personId).toBe("person-1");
    expect(loan.institutionName).toBeNull();
  });

  it("round-trips an explicit given/personal loan", () => {
    const loan = loanFromFirestore(
      fakeSnapshot({ ...baseFirestoreData, direction: "given", category: "personal" }),
    );

    expect(loan.direction).toBe("given");
    expect(loan.category).toBe("personal");
  });
});

describe("Loan.payerPersonId — 'I took a bank loan, a friend pays it' (Case 1)", () => {
  it("a legacy document with no payerPersonId field loads as null", () => {
    const loan = loanFromFirestore(fakeSnapshot(baseFirestoreData));
    expect(loan.payerPersonId).toBeNull();
  });

  it("round-trips an explicit payerPersonId, distinct from personId", () => {
    const loan = loanFromFirestore(
      fakeSnapshot({ ...baseFirestoreData, personId: null, category: "institutional", payerPersonId: "friend-1" }),
    );
    expect(loan.personId).toBeNull();
    expect(loan.payerPersonId).toBe("friend-1");
  });

  it("loanToFirestore writes payerPersonId", () => {
    const loan: Loan = {
      id: "loan-with-payer",
      personId: null,
      direction: "taken",
      category: "institutional",
      institutionName: "HDFC Bank",
      payerPersonId: "friend-1",
      name: null,
      loanAmount: 50000,
      interest: null,
      loanDate: new Date("2026-01-01T00:00:00.000Z"),
      repaymentType: "oneTime",
      dueDate: new Date("2026-02-01T00:00:00.000Z"),
      installmentFrequency: null,
      installmentCount: null,
      notes: "",
      scheduleId: "schedule-with-payer",
      isClosed: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };

    const data = loanToFirestore(loan);
    expect(data.payerPersonId).toBe("friend-1");
  });
});

describe("loanToFirestore — round-trips an institutional loan with null personId", () => {
  it("writes personId null and every institution field", () => {
    const loan: Loan = {
      id: "loan-institutional",
      personId: null,
      direction: "taken",
      category: "institutional",
      institutionName: "HDFC Bank",
      loanType: "Home Loan",
      loanNumber: "HL-12345",
      accountNumber: "AC-98765",
      branch: "MG Road",
      name: null,
      loanAmount: 500000,
      interest: null,
      loanDate: new Date("2026-01-01T00:00:00.000Z"),
      repaymentType: "oneTime",
      dueDate: new Date("2026-02-01T00:00:00.000Z"),
      installmentFrequency: null,
      installmentCount: null,
      notes: "",
      scheduleId: "schedule-institutional",
      isClosed: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };

    const data = loanToFirestore(loan);
    expect(data.personId).toBeNull();
    expect(data.direction).toBe("taken");
    expect(data.category).toBe("institutional");
    expect(data.institutionName).toBe("HDFC Bank");
    expect(data.loanType).toBe("Home Loan");
    expect(data.loanNumber).toBe("HL-12345");
    expect(data.accountNumber).toBe("AC-98765");
    expect(data.branch).toBe("MG Road");

    const fetched = loanFromFirestore(fakeSnapshot(data));
    expect(fetched.personId).toBeNull();
    expect(fetched.institutionName).toBe("HDFC Bank");
  });
});
