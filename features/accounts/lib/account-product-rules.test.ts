import { describe, expect, it } from "vitest";
import {
  availableCredit,
  buildSaveAction,
  fieldVisibilityFor,
  isBalanceHoldingCardSubtype,
  isCreditCardSubtype,
  isDebitCardSubtype,
  isDepositSubtype,
  supportsMinimumBalance,
  validateAccountForm,
  type AccountFormInput,
} from "./account-product-rules";

function baseForm(overrides: Partial<AccountFormInput> = {}): AccountFormInput {
  return {
    name: "My Account",
    type: "bank",
    bankAccountSubtype: "savings",
    cardSubtype: "credit",
    bankId: null,
    linkedAccountId: null,
    openingBalance: "1000",
    creditLimit: "",
    currentUsed: "",
    statementDay: "1",
    paymentDueDay: "15",
    minimumBalance: "",
    interestRatePercent: "",
    maturityDate: "",
    tenureMonths: "",
    accountHolderName: "",
    accountNumberLast4: "",
    cardProvider: "",
    reloadable: true,
    currency: "USD",
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof validateAccountForm>): asserts result is Extract<typeof result, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok:true, got error: ${result.error}`);
}

function expectErr(result: ReturnType<typeof validateAccountForm>): asserts result is Extract<typeof result, { ok: false }> {
  if (result.ok) throw new Error("expected ok:false, got ok:true");
}

describe("account-product-rules — 1. Savings Account", () => {
  it("shows opening balance, account holder, last4, minimum balance; no credit/card fields", () => {
    const v = fieldVisibilityFor("bank", "savings", "credit", false);
    expect(v.openingBalance).toBe(true);
    expect(v.accountHolderOrCardholder).toBe(true);
    expect(v.last4Digits).toBe(true);
    expect(v.minimumBalance).toBe(true);
    expect(v.depositFields).toBe(false);
    expect(v.creditLimit).toBe(false);
    expect(v.currentUsedOutstanding).toBe(false);
    expect(v.cardSubtypeSelector).toBe(false);
  });

  it("minimum balance is never forced — omitting it is valid", () => {
    const result = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "savings", minimumBalance: "", accountHolderName: "Jane Doe", accountNumberLast4: "1234" }),
      false,
    );
    expectOk(result);
    expect(result.minimumBalance).toBeNull();
  });

  it("rejects a negative minimum balance when one is provided", () => {
    const result = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "savings", minimumBalance: "-5", accountHolderName: "Jane Doe", accountNumberLast4: "1234" }),
      false,
    );
    expectErr(result);
    expect(result.error).toMatch(/minimum balance/i);
  });

  it("requires an account holder name and last 4 digits", () => {
    const missingHolder = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "savings", accountHolderName: "", accountNumberLast4: "1234" }),
      false,
    );
    expectErr(missingHolder);
    expect(missingHolder.error).toMatch(/account holder/i);

    const missingLast4 = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "savings", accountHolderName: "Jane Doe", accountNumberLast4: "" }),
      false,
    );
    expectErr(missingLast4);
    expect(missingLast4.error).toMatch(/last 4 digits/i);
  });

  it("creates a plain Account with the savings subtype, no CreditCardProfile involved", () => {
    const form = baseForm({
      type: "bank",
      bankAccountSubtype: "savings",
      minimumBalance: "5000",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "1234",
    });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    const action = buildSaveAction(form, validated, false, { colorValue: 3 });
    expect(action.kind).toBe("createAccount");
    if (action.kind !== "createAccount") throw new Error("unreachable");
    expect(action.params.type).toBe("bank");
    expect((action.params as unknown as Record<string, unknown>).bankAccountSubtype).toBe("savings");
    expect((action.params as unknown as Record<string, unknown>).minimumBalance).toBe(5000);
  });
});

describe("account-product-rules — 2. Current Account", () => {
  it("shows minimum balance (optional), no deposit fields", () => {
    const v = fieldVisibilityFor("bank", "current", "credit", false);
    expect(v.minimumBalance).toBe(true);
    expect(v.depositFields).toBe(false);
  });

  it("saves without a minimum balance when left blank", () => {
    const form = baseForm({
      type: "bank",
      bankAccountSubtype: "current",
      minimumBalance: "",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "1234",
    });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    expect(validated.minimumBalance).toBeNull();
  });
});

describe("account-product-rules — 3. Salary Account", () => {
  it("shows minimum balance only optionally — never required", () => {
    const v = fieldVisibilityFor("bank", "salary", "credit", false);
    expect(v.minimumBalance).toBe(true); // shown, but...
    const form = baseForm({
      type: "bank",
      bankAccountSubtype: "salary",
      minimumBalance: "",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "1234",
    });
    const validated = validateAccountForm(form, false); // ...never forced to a value
    expectOk(validated);
    expect(validated.minimumBalance).toBeNull();
  });

  it("does not show FD/RD deposit fields for a salary account", () => {
    const v = fieldVisibilityFor("bank", "salary", "credit", false);
    expect(v.depositFields).toBe(false);
  });
});

describe("account-product-rules — 4. Fixed Deposit", () => {
  it("hides opening-balance-as-such fields and shows deposit fields instead, hides account holder/last4", () => {
    const v = fieldVisibilityFor("bank", "fixedDeposit", "credit", false);
    expect(v.depositFields).toBe(true);
    expect(v.minimumBalance).toBe(false);
    expect(v.accountHolderOrCardholder).toBe(false);
    expect(v.last4Digits).toBe(false);
  });

  it("requires interest rate, tenure, and maturity date", () => {
    const missingInterest = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "fixedDeposit", interestRatePercent: "", tenureMonths: "12", maturityDate: "2027-01-01" }),
      false,
    );
    expectErr(missingInterest);
    expect(missingInterest.error).toMatch(/interest rate/i);

    const missingTenure = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "fixedDeposit", interestRatePercent: "7.1", tenureMonths: "", maturityDate: "2027-01-01" }),
      false,
    );
    expectErr(missingTenure);
    expect(missingTenure.error).toMatch(/tenure/i);

    const missingMaturity = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "fixedDeposit", interestRatePercent: "7.1", tenureMonths: "12", maturityDate: "" }),
      false,
    );
    expectErr(missingMaturity);
    expect(missingMaturity.error).toMatch(/maturity date/i);
  });

  it("accepts a complete FD and carries interest/tenure/maturity through to the create params", () => {
    const form = baseForm({
      type: "bank",
      bankAccountSubtype: "fixedDeposit",
      interestRatePercent: "7.25",
      tenureMonths: "24",
      maturityDate: "2027-06-01",
      openingBalance: "100000",
    });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    expect(validated.interestRatePercent).toBe(7.25);
    expect(validated.tenureMonths).toBe(24);
    expect(validated.maturityDate?.toISOString().slice(0, 10)).toBe("2027-06-01");

    const action = buildSaveAction(form, validated, false, { colorValue: 0 });
    expect(action.kind).toBe("createAccount");
    if (action.kind !== "createAccount") throw new Error("unreachable");
    const params = action.params as unknown as Record<string, unknown>;
    expect(params.interestRatePercent).toBe(7.25);
    expect(params.tenureMonths).toBe(24);
    expect(params.maturityDate).toBeInstanceOf(Date);
  });

  it("rejects a non-integer or zero tenure", () => {
    const zero = validateAccountForm(
      baseForm({ type: "bank", bankAccountSubtype: "fixedDeposit", interestRatePercent: "7", tenureMonths: "0", maturityDate: "2027-01-01" }),
      false,
    );
    expectErr(zero);
    expect(zero.error).toMatch(/tenure/i);
  });
});

describe("account-product-rules — 5. Cash", () => {
  it("shows opening balance and account holder, no bank-only or card-only fields", () => {
    const v = fieldVisibilityFor("cash", null, "credit", false);
    expect(v.openingBalance).toBe(true);
    expect(v.accountHolderOrCardholder).toBe(true);
    expect(v.bankAccountSubtypeSelector).toBe(false);
    expect(v.cardSubtypeSelector).toBe(false);
    expect(v.minimumBalance).toBe(false);
    expect(v.creditLimit).toBe(false);
  });

  it("creates a plain Account of type cash with no card/bank subtype fields", () => {
    const form = baseForm({ type: "cash", openingBalance: "500" });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    const action = buildSaveAction(form, validated, false, { colorValue: 1 });
    expect(action.kind).toBe("createAccount");
    if (action.kind !== "createAccount") throw new Error("unreachable");
    expect(action.params.type).toBe("cash");
    expect(action.params.bankId).toBeNull();
  });
});

describe("account-product-rules — 6. Wallet", () => {
  it("behaves like Cash for field visibility", () => {
    const v = fieldVisibilityFor("wallet", null, "credit", false);
    expect(v.openingBalance).toBe(true);
    expect(v.creditLimit).toBe(false);
    expect(v.minimumBalance).toBe(false);
  });
});

describe("account-product-rules — 7. Credit Card", () => {
  it("shows credit limit, used/outstanding, computed available credit, statement/due dates; no linked-account/reloadable/currency fields", () => {
    const v = fieldVisibilityFor("card", null, "credit", false);
    expect(v.creditLimit).toBe(true);
    expect(v.currentUsedOutstanding).toBe(true);
    expect(v.availableCredit).toBe(true);
    expect(v.statementDate).toBe(true);
    expect(v.paymentDueDate).toBe(true);
    expect(v.linkedBankAccount).toBe(false);
    expect(v.reloadable).toBe(false);
    expect(v.currency).toBe(false);
    expect(v.cardProvider).toBe(false);
    expect(v.bankCombobox).toBe(true); // issuing bank
  });

  it("requires credit limit greater than 0", () => {
    const result = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "credit", accountHolderName: "Jane Doe", accountNumberLast4: "1234", creditLimit: "0" }),
      false,
    );
    expectErr(result);
    expect(result.error).toMatch(/credit limit/i);
  });

  it("rejects used/outstanding greater than the credit limit", () => {
    const result = validateAccountForm(
      baseForm({
        type: "card",
        cardSubtype: "credit",
        accountHolderName: "Jane Doe",
        accountNumberLast4: "1234",
        creditLimit: "10000",
        currentUsed: "15000",
      }),
      false,
    );
    expectErr(result);
    expect(result.error).toMatch(/cannot exceed the credit limit/i);
  });

  it("allows used/outstanding equal to the credit limit (fully utilized is not an error)", () => {
    const result = validateAccountForm(
      baseForm({
        type: "card",
        cardSubtype: "credit",
        accountHolderName: "Jane Doe",
        accountNumberLast4: "1234",
        creditLimit: "10000",
        currentUsed: "10000",
      }),
      false,
    );
    expectOk(result);
    expect(result.currentUsed).toBe(10000);
  });

  it("computes available credit as creditLimit - currentUsed, clamped at 0", () => {
    expect(availableCredit(10000, 4000)).toBe(6000);
    expect(availableCredit(10000, 10000)).toBe(0);
    expect(availableCredit(10000, 15000)).toBe(0); // never negative, even if callers allow over-limit input upstream
  });

  it("requires last 4 digits to be exactly 4 numeric digits — never asks for a full card number", () => {
    const tooShort = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "credit", accountHolderName: "Jane Doe", accountNumberLast4: "12", creditLimit: "5000" }),
      false,
    );
    expectErr(tooShort);
    expect(tooShort.error).toMatch(/last 4 digits/i);

    const tooLong = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "credit", accountHolderName: "Jane Doe", accountNumberLast4: "1234567890123456", creditLimit: "5000" }),
      false,
    );
    expectErr(tooLong);

    const nonDigits = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "credit", accountHolderName: "Jane Doe", accountNumberLast4: "12ab", creditLimit: "5000" }),
      false,
    );
    expectErr(nonDigits);

    const exact = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "credit", accountHolderName: "Jane Doe", accountNumberLast4: "4021", creditLimit: "5000" }),
      false,
    );
    expectOk(exact);
  });

  it("validates statement day and payment due day are within 1-31", () => {
    const badStatement = validateAccountForm(
      baseForm({
        type: "card",
        cardSubtype: "credit",
        accountHolderName: "Jane Doe",
        accountNumberLast4: "1234",
        creditLimit: "5000",
        statementDay: "32",
      }),
      false,
    );
    expectErr(badStatement);
    expect(badStatement.error).toMatch(/statement date/i);

    const badDue = validateAccountForm(
      baseForm({
        type: "card",
        cardSubtype: "credit",
        accountHolderName: "Jane Doe",
        accountNumberLast4: "1234",
        creditLimit: "5000",
        paymentDueDay: "0",
      }),
      false,
    );
    expectErr(badDue);
    expect(badDue.error).toMatch(/payment due date/i);
  });

  it("builds a createCreditCard save action carrying the credit-card-specific fields", () => {
    const form = baseForm({
      type: "card",
      cardSubtype: "credit",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "4021",
      creditLimit: "50000",
      currentUsed: "12000",
      statementDay: "5",
      paymentDueDay: "20",
      bankId: "hdfc",
    });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    expect(validated.isCreditCard).toBe(true);

    const action = buildSaveAction(form, validated, false, { colorValue: 2 });
    expect(action.kind).toBe("createCreditCard");
    if (action.kind !== "createCreditCard") throw new Error("unreachable");
    expect(action.params.cardHolderName).toBe("Jane Doe");
    expect(action.params.lastFourDigits).toBe("4021");
    expect(action.params.creditLimit).toBe(50000);
    expect(action.params.statementDay).toBe(5);
    expect(action.params.paymentDueDay).toBe(20);
    expect(action.params.bankId).toBe("hdfc");
  });

  it("classifies cardSubtype 'credit' as a credit card and nothing else", () => {
    expect(isCreditCardSubtype("credit")).toBe(true);
    expect(isCreditCardSubtype("debit")).toBe(false);
    expect(isCreditCardSubtype("prepaid")).toBe(false);
    expect(isCreditCardSubtype("forex")).toBe(false);
    expect(isCreditCardSubtype("gift")).toBe(false);
    expect(isCreditCardSubtype("other")).toBe(false);
    expect(isCreditCardSubtype(null)).toBe(false);
  });
});

describe("account-product-rules — 8. Debit Card", () => {
  it("shows a linked-bank-account field, hides every credit-only field", () => {
    const v = fieldVisibilityFor("card", null, "debit", false);
    expect(v.linkedBankAccount).toBe(true);
    expect(v.creditLimit).toBe(false);
    expect(v.currentUsedOutstanding).toBe(false);
    expect(v.availableCredit).toBe(false);
    expect(v.statementDate).toBe(false);
    expect(v.paymentDueDate).toBe(false);
    expect(v.cardProvider).toBe(false);
    expect(v.reloadable).toBe(false);
    expect(v.currency).toBe(false);
  });

  it("requires a linked bank account to be chosen", () => {
    const result = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "debit", accountHolderName: "Jane Doe", accountNumberLast4: "1234", linkedAccountId: null }),
      false,
    );
    expectErr(result);
    expect(result.error).toMatch(/linked to/i);
  });

  it("builds a createAccount action — never createCreditCard — for a debit card", () => {
    const form = baseForm({
      type: "card",
      cardSubtype: "debit",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "5566",
      linkedAccountId: "acc-savings-1",
      bankId: "sbi",
    });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    expect(validated.isDebitCard).toBe(true);
    expect(validated.isCreditCard).toBe(false);

    const action = buildSaveAction(form, validated, false, { colorValue: 4 });
    expect(action.kind).toBe("createAccount");
    if (action.kind !== "createAccount") throw new Error("unreachable");
    const params = action.params as unknown as Record<string, unknown>;
    expect(params.type).toBe("card");
    expect(params.cardSubtype).toBe("debit");
    expect(params.linkedAccountId).toBe("acc-savings-1");
    // No CreditCardProfile-only fields exist on CreateAccountParams at all — the type system
    // itself enforces "Account/card record is created; CreditCardProfile is NOT created" here,
    // since createAccount() writes only to the accounts collection (see account-repository.ts).
  });

  it("classifies cardSubtype 'debit' as a debit card, never a credit card", () => {
    expect(isDebitCardSubtype("debit")).toBe(true);
    expect(isCreditCardSubtype("debit")).toBe(false);
  });
});

describe("account-product-rules — 9. Prepaid Card", () => {
  it("shows initial balance and reloadable, hides credit-limit and linked-account fields", () => {
    const v = fieldVisibilityFor("card", null, "prepaid", false);
    expect(v.openingBalance).toBe(true);
    expect(v.reloadable).toBe(true);
    expect(v.cardProvider).toBe(true);
    expect(v.creditLimit).toBe(false);
    expect(v.currentUsedOutstanding).toBe(false);
    expect(v.availableCredit).toBe(false);
    expect(v.statementDate).toBe(false);
    expect(v.paymentDueDate).toBe(false);
    expect(v.linkedBankAccount).toBe(false);
    expect(v.currency).toBe(false);
  });

  it("shows Current Balance read-only in edit mode instead of Initial Balance", () => {
    const addVisibility = fieldVisibilityFor("card", null, "prepaid", false);
    const editVisibility = fieldVisibilityFor("card", null, "prepaid", true);
    expect(addVisibility.openingBalance).toBe(true);
    expect(addVisibility.currentBalanceReadOnly).toBe(false);
    expect(editVisibility.openingBalance).toBe(false);
    expect(editVisibility.currentBalanceReadOnly).toBe(true);
  });

  it("requires a non-negative opening balance", () => {
    const result = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "prepaid", accountHolderName: "Jane Doe", accountNumberLast4: "1234", openingBalance: "-100" }),
      false,
    );
    expectErr(result);
    expect(result.error).toMatch(/opening balance/i);
  });

  it("builds a createAccount action carrying provider/reloadable, never createCreditCard", () => {
    const form = baseForm({
      type: "card",
      cardSubtype: "prepaid",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "7788",
      openingBalance: "2000",
      cardProvider: "Amazon Pay",
      reloadable: true,
    });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    expect(validated.isCreditCard).toBe(false);
    expect(validated.isBalanceHoldingCard).toBe(true);

    const action = buildSaveAction(form, validated, false, { colorValue: 5 });
    expect(action.kind).toBe("createAccount");
    if (action.kind !== "createAccount") throw new Error("unreachable");
    const params = action.params as unknown as Record<string, unknown>;
    expect(params.cardSubtype).toBe("prepaid");
    expect(params.cardProvider).toBe("Amazon Pay");
    expect(params.reloadable).toBe(true);
    expect(params.currency).toBeNull();
  });
});

describe("account-product-rules — 10. Forex Card", () => {
  it("shows currency, hides reloadable and every credit-only field", () => {
    const v = fieldVisibilityFor("card", null, "forex", false);
    expect(v.currency).toBe(true);
    expect(v.reloadable).toBe(false);
    expect(v.creditLimit).toBe(false);
    expect(v.currentUsedOutstanding).toBe(false);
    expect(v.availableCredit).toBe(false);
    expect(v.statementDate).toBe(false);
    expect(v.paymentDueDate).toBe(false);
    expect(v.linkedBankAccount).toBe(false);
  });

  it("builds a createAccount action carrying currency, never createCreditCard", () => {
    const form = baseForm({
      type: "card",
      cardSubtype: "forex",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "9012",
      openingBalance: "500",
      currency: "USD",
    });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    expect(validated.isCreditCard).toBe(false);

    const action = buildSaveAction(form, validated, false, { colorValue: 0 });
    expect(action.kind).toBe("createAccount");
    if (action.kind !== "createAccount") throw new Error("unreachable");
    const params = action.params as unknown as Record<string, unknown>;
    expect(params.cardSubtype).toBe("forex");
    expect(params.currency).toBe("USD");
    expect(params.reloadable).toBeNull();
  });

  it("classifies forex as a balance-holding card, not a credit or debit card", () => {
    expect(isBalanceHoldingCardSubtype("forex")).toBe(true);
    expect(isCreditCardSubtype("forex")).toBe(false);
    expect(isDebitCardSubtype("forex")).toBe(false);
  });
});

describe("account-product-rules — 11. Other Card", () => {
  it("behaves like a balance-holding card (Prepaid/Forex/Gift/Other share the same shape)", () => {
    const v = fieldVisibilityFor("card", null, "other", false);
    expect(v.openingBalance).toBe(true);
    expect(v.cardProvider).toBe(true);
    expect(v.creditLimit).toBe(false);
    expect(v.reloadable).toBe(false); // reloadable is prepaid-only, "other" doesn't get it
    expect(v.currency).toBe(false); // currency is forex-only
  });

  it("never creates a CreditCardProfile for an Other Card", () => {
    const form = baseForm({ type: "card", cardSubtype: "other", accountHolderName: "Jane Doe", accountNumberLast4: "1111", openingBalance: "0" });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    const action = buildSaveAction(form, validated, false, { colorValue: 1 });
    expect(action.kind).toBe("createAccount");
  });
});

describe("account-product-rules — 12. Other Account", () => {
  it("has no bank/card subtype selectors and no financial-product-specific fields", () => {
    const v = fieldVisibilityFor("other", null, null, false);
    expect(v.bankAccountSubtypeSelector).toBe(false);
    expect(v.cardSubtypeSelector).toBe(false);
    expect(v.minimumBalance).toBe(false);
    expect(v.depositFields).toBe(false);
    expect(v.creditLimit).toBe(false);
    expect(v.openingBalance).toBe(true);
  });

  it("creates a plain Account of type other", () => {
    const form = baseForm({ type: "other", openingBalance: "0" });
    const validated = validateAccountForm(form, false);
    expectOk(validated);
    const action = buildSaveAction(form, validated, false, { colorValue: 2 });
    expect(action.kind).toBe("createAccount");
    if (action.kind !== "createAccount") throw new Error("unreachable");
    expect(action.params.type).toBe("other");
  });
});

describe("account-product-rules — cross-cutting: only Credit Card ever produces createCreditCard", () => {
  const subtypesAndExpectedKind: Array<{ subtype: AccountFormInput["cardSubtype"]; kind: "createCreditCard" | "createAccount" }> = [
    { subtype: "credit", kind: "createCreditCard" },
    { subtype: "debit", kind: "createAccount" },
    { subtype: "prepaid", kind: "createAccount" },
    { subtype: "forex", kind: "createAccount" },
    { subtype: "gift", kind: "createAccount" },
    { subtype: "other", kind: "createAccount" },
  ];

  for (const { subtype, kind } of subtypesAndExpectedKind) {
    it(`cardSubtype "${subtype}" -> ${kind}`, () => {
      const form = baseForm({
        type: "card",
        cardSubtype: subtype,
        accountHolderName: "Jane Doe",
        accountNumberLast4: "1234",
        creditLimit: "5000",
        linkedAccountId: subtype === "debit" ? "acc-1" : null,
        openingBalance: "0",
      });
      const validated = validateAccountForm(form, false);
      expectOk(validated);
      const action = buildSaveAction(form, validated, false, { colorValue: 0 });
      expect(action.kind).toBe(kind);
    });
  }

  it("selecting Card alone (no subtype resolved) never implies credit — classification always requires the explicit subtype", () => {
    // type === "card" with an unresolved/null subtype must never be treated as credit.
    expect(isCreditCardSubtype(null)).toBe(false);
  });
});

describe("account-product-rules — cardholder/last4 are never a full card number", () => {
  it("the model only ever asks for last 4 digits (validated to exactly 4 digits), not a full PAN", () => {
    // A full 16-digit card number must fail the same validation a real last-4 field enforces.
    const fullNumber = validateAccountForm(
      baseForm({ type: "card", cardSubtype: "credit", accountHolderName: "Jane Doe", accountNumberLast4: "4111111111111111", creditLimit: "5000" }),
      false,
    );
    expectErr(fullNumber);
  });
});

describe("account-product-rules — progressive disclosure across every type", () => {
  it("Bank/Cash/Wallet/Business/Other never show card-subtype or card-only fields", () => {
    for (const type of ["bank", "cash", "wallet", "business", "other"] as const) {
      const v = fieldVisibilityFor(type, "savings", "credit", false);
      expect(v.cardSubtypeSelector).toBe(false);
      expect(v.creditLimit).toBe(false);
      expect(v.linkedBankAccount).toBe(false);
      expect(v.reloadable).toBe(false);
      expect(v.currency).toBe(false);
    }
  });

  it("Card type never shows bank-subtype or deposit-only fields", () => {
    for (const subtype of ["credit", "debit", "prepaid", "forex", "gift", "other"] as const) {
      const v = fieldVisibilityFor("card", "savings", subtype, false);
      expect(v.bankAccountSubtypeSelector).toBe(false);
      expect(v.depositFields).toBe(false);
      expect(v.minimumBalance).toBe(false);
    }
  });

  it("only one card-money-shape is active per subtype (credit vs. debit vs. balance-holding are mutually exclusive)", () => {
    const shapes = ["credit", "debit", "prepaid", "forex", "gift", "other"] as const;
    for (const subtype of shapes) {
      const v = fieldVisibilityFor("card", null, subtype, false);
      const activeShapes = [v.creditLimit, v.linkedBankAccount, v.openingBalance && v.cardProvider].filter(Boolean).length;
      expect(activeShapes).toBeLessThanOrEqual(1);
    }
  });
});

describe("account-product-rules — supportsMinimumBalance / isDepositSubtype helpers", () => {
  it("minimum balance applies to savings/current/salary only", () => {
    expect(supportsMinimumBalance("savings")).toBe(true);
    expect(supportsMinimumBalance("current")).toBe(true);
    expect(supportsMinimumBalance("salary")).toBe(true);
    expect(supportsMinimumBalance("fixedDeposit")).toBe(false);
    expect(supportsMinimumBalance("recurringDeposit")).toBe(false);
    expect(supportsMinimumBalance("nre")).toBe(false);
    expect(supportsMinimumBalance("nro")).toBe(false);
    expect(supportsMinimumBalance("other")).toBe(false);
    expect(supportsMinimumBalance(null)).toBe(false);
  });

  it("deposit subtype applies to FD/RD only", () => {
    expect(isDepositSubtype("fixedDeposit")).toBe(true);
    expect(isDepositSubtype("recurringDeposit")).toBe(true);
    expect(isDepositSubtype("savings")).toBe(false);
    expect(isDepositSubtype(null)).toBe(false);
  });
});

describe("account-product-rules — editing an existing card locks its subtype", () => {
  it("edit mode never asks for the money-establishing fields again (credit limit, initial opening balance)", () => {
    const v = fieldVisibilityFor("card", null, "credit", true);
    expect(v.creditLimit).toBe(false);
    expect(v.currentUsedOutstanding).toBe(false);
    expect(v.statementDate).toBe(false);
    expect(v.paymentDueDate).toBe(false);
  });

  it("editing a credit card skips the (now-irrelevant) create-time validations", () => {
    const form = baseForm({
      type: "card",
      cardSubtype: "credit",
      accountHolderName: "Jane Doe",
      accountNumberLast4: "1234",
      creditLimit: "", // would fail on create, but editing doesn't touch CreditCardProfile fields here
    });
    const validated = validateAccountForm(form, true);
    expectOk(validated);
  });
});
