import { describe, expect, it } from "vitest";
import { differentReferences, parseStatementNarration, rowRrn, rrnsIn, statementDescription } from "./statement-narration";

describe("parseStatementNarration", () => {
  it("reads a BOI UPI credit chain, repairing an OCR word split from the VPA", () => {
    const n = parseStatementNarration("UP1/627481159639/CR/MOH AN /BKID/mohankoda/UPI");
    expect(n).toMatchObject({ rail: "UPI", reference: "627481159639", marker: "credit", name: "MOHAN", vpa: "mohankoda", bank: "BKID" });
  });

  it("reads a UPI debit chain with a truncated merchant field", () => {
    const n = parseStatementNarration("UPI1/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI");
    expect(n).toMatchObject({ rail: "UPI", reference: "627632125367", marker: "debit", name: "Jio Pr", vpa: "paytm-jio", bank: "YESB" });
  });

  it("joins a reference OCR split with a space", () => {
    expect(parseStatementNarration("UPI/62748115 9639/CR/MOHAN/BKID/mohan/UPI")?.reference).toBe("627481159639");
  });

  it("is null for text that is not a rail chain", () => {
    expect(parseStatementNarration("POS 4521 AMAZON RETAIL")).toBeNull();
    expect(parseStatementNarration("")).toBeNull();
  });
});

describe("statementDescription", () => {
  it("names a person-to-person UPI credit without inventing a purpose", () => {
    expect(statementDescription({ description: "UP1/627481159639/CR/MOH AN /BKID/mohankoda/UPI", direction: "credit" })?.text).toBe("Received from Mohan · UPI");
  });

  it("uses the merchant's own wording, expanding only an unambiguous truncated purpose word", () => {
    expect(statementDescription({ description: "UPI1/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI", direction: "debit" })?.text).toBe("Jio Mobile Recharge · UPI");
  });

  it("keeps a plain merchant name when no purpose is stated", () => {
    expect(statementDescription({ description: "UPI/627632125367/DR/JIO/YESB/jio/UPI", direction: "debit" })?.text).toBe("Jio · UPI");
  });

  it("says 'Paid to' for an unknown payee on a debit", () => {
    expect(statementDescription({ description: "UPI/612345678901/DR/RAHUL K/SBIN/rahulk/UPI", direction: "debit" })?.text).toBe("Paid to Rahul K · UPI");
  });

  it("never guesses for a chain with no readable name", () => {
    expect(statementDescription({ description: "UPI/612345678901/DR/SBIN/UPI", direction: "debit" })).toBeNull();
  });

  it("does not suggest for unrecognised free text", () => {
    expect(statementDescription({ description: "CHQ DEP 000123", direction: "credit" })).toBeNull();
  });
});

describe("references", () => {
  it("reads the row's 12-digit RRN", () => {
    expect(rowRrn({ description: "UPI/627481159639/CR/MOHAN/BKID/mohan/UPI", referenceNumber: null })).toBe("627481159639");
    expect(rowRrn({ description: "NEFT/N1234/X", referenceNumber: "9876543210" })).toBeNull(); // 10 digits — a phone, never compared
  });

  it("finds RRNs only in reference positions", () => {
    expect(rrnsIn("Received from Mohan · UPI · Ref 664081439342")).toEqual(["664081439342"]);
    expect(rrnsIn("Paid 2000 to 98765432101234 account")).toEqual([]);
  });

  it("calls two stated, different RRNs different — and proves nothing when one is missing", () => {
    expect(differentReferences("627481159639", "UPI/664081439342/CR/MOHAN/BKID/mohan/UPI")).toBe(true);
    expect(differentReferences("627481159639", "UPI/627481159639/CR/MOHAN/BKID/mohan/UPI")).toBe(false);
    expect(differentReferences("627481159639", "Mohan 2000")).toBe(false);
    expect(differentReferences(null, "UPI/664081439342/CR/MOHAN")).toBe(false);
  });
});

describe("name repair stays conservative", () => {
  it("never joins a real two-word name", () => {
    expect(parseStatementNarration("UPI/612345678901/DR/SURESH KUMAR/SBIN/sureshkumar/UPI")?.name).toBe("SURESH KUMAR");
  });
});
