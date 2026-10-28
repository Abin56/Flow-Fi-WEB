import { describe, expect, it } from "vitest";
import { internalPaymentVerdict, ownedAccountIdentities, type OwnedAccountIdentity } from "./internal-payment-guard";
import { reconData } from "./test-fixtures";

const OWNED: OwnedAccountIdentity[] = [
  { id: "acc-card", name: "HDFC Millennia", last4: "4821", isCard: true },
  { id: "acc-other", name: "Axis Savings", last4: "9981", isCard: false },
];
const bank = { isCardAccount: false, ownedAccounts: OWNED };
const card = { isCardAccount: true, ownedAccounts: OWNED };
const debit = (description: string) => ({ description, direction: "debit" as const });
const credit = (description: string) => ({ description, direction: "credit" as const });

describe("bank-side internal payments are BLOCKED", () => {
  it.each([
    "CREDIT CARD PAYMENT HDFC BANK",
    "HDFC CC BILL PAY",
    "PAYMENT TO CC 4821",
    "IB BILLPAY DR-HDFCCC CC PAYMENT",
    "BILLDESK*HDFC CARD",
    "CARD DUES ICICI",
    "UPI/CRED/cred.club@axisb/payment",
    "CRED CLUB",
    "cred.club",
    "CC AUTOPAY SI",
    "AUTOPAY CREDIT CARD AMEX",
  ])("card bill payment / CRED / card autopay: %s", (text) => {
    const v = internalPaymentVerdict(debit(text), bank);
    expect(v.block).toMatch(/credit card bill payment/);
    expect(v.confirm).toBeNull();
  });

  it.each(["NEFT TO SELF", "IMPS SELF TRANSFER 99887766", "TRF TO OWN A/C", "SWEEP OUT TO FD", "UPI SELF 1234"])("self-transfer: %s", (text) => {
    expect(internalPaymentVerdict(debit(text), bank).block).toMatch(/transfer between your own accounts/);
  });

  it.each([
    ["NEFT TO A/C XXXX9981 ANJEL", /Axis Savings \(•••• 9981\)/],
    ["IMPS TO ACCT NO 0000009981", /Axis Savings/],
    ["PAYMENT TO CARD XX4821", /HDFC Millennia \(•••• 4821\)/],
    ["UPI ENDING 4821 TRANSFER", /HDFC Millennia/],
  ])("names one of the user's own accounts/cards by masked last four: %s", (text, name) => {
    expect(internalPaymentVerdict(debit(text), bank).block).toMatch(name);
  });

  it("a credit from the user's own account is blocked too (never income)", () => {
    expect(internalPaymentVerdict(credit("NEFT FROM SELF"), bank).block).not.toBeNull();
    expect(internalPaymentVerdict(credit("IMPS FROM A/C XX9981"), bank).block).toMatch(/Axis Savings/);
  });
});

describe("ambiguous rails need the explicit confirmation — never a blanket block", () => {
  it.each(["NEFT-RENT-MR SHARMA OCT", "NEFT DR LANDLORD RENT", "IMPS P2A 445566778899 RAMESH KUMAR", "UPI/ZOMATO/zomato@hdfc", "RTGS ACME SUPPLIERS PVT LTD", "NACH DR SIP MUTUAL FUND"])("%s", (text) => {
    const v = internalPaymentVerdict(debit(text), bank);
    expect(v.block).toBeNull();
    expect(v.confirm).toMatch(/went to someone else/);
  });

  it("an ambiguous credit asks whether it came from someone else", () => {
    expect(internalPaymentVerdict(credit("NEFT SALARY ACME CORP"), bank).confirm).toMatch(/came from someone else/);
  });

  it("a 4-digit run inside a long reference number is not an owned-account mention", () => {
    const v = internalPaymentVerdict(debit("UPI/998149810001/SWIGGY"), bank);
    expect(v.block).toBeNull();
    expect(v.confirm).not.toBeNull();
  });
});

describe("ordinary spending is untouched", () => {
  it.each(["POS AMAZON RETAIL", "DEBIT CARD PURCHASE AMAZON PAY INDIA", "ATM WDL MG ROAD", "SWIGGY BANGALORE", "CREDIT INTEREST", "CARD ANNUAL FEE"])("%s", (text) => {
    expect(internalPaymentVerdict(debit(text), bank)).toEqual({ block: null, confirm: null });
  });
  it("'CREDIT' never reads as CRED", () => {
    expect(internalPaymentVerdict(credit("CREDIT INTEREST CAPITALISED"), bank)).toEqual({ block: null, confirm: null });
  });
});

describe("card statements", () => {
  it("a card-payment-looking CREDIT (CRED, card bill) is blocked as income/refund", () => {
    expect(internalPaymentVerdict(credit("CRED CLUB PAYMENT"), card).block).toMatch(/Pay bill/);
    expect(internalPaymentVerdict(credit("CC BILL PAYMENT RECEIVED"), card).block).toMatch(/Pay bill/);
  });
  it("card purchases and ordinary refunds are untouched; no rail confirmation on card statements", () => {
    expect(internalPaymentVerdict(debit("UPI-AMAZON RUPAY CC"), card)).toEqual({ block: null, confirm: null });
    expect(internalPaymentVerdict(credit("REFUND AMAZON"), card)).toEqual({ block: null, confirm: null });
  });
});

describe("ownedAccountIdentities", () => {
  it("lists the other live accounts with masked last four (card profile first), never the statement account", () => {
    const data = reconData();
    expect(ownedAccountIdentities(data.accounts, data.creditCards, "acc-bank")).toEqual([{ id: "acc-card", name: "HDFC Millennia", last4: "4821", isCard: true }]);
    expect(ownedAccountIdentities(data.accounts, data.creditCards, "acc-card")).toEqual([{ id: "acc-bank", name: "SBI Savings", last4: "9981", isCard: false }]);
  });
});
