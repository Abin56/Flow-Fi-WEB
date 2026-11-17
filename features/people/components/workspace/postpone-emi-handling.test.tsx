// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { EmiHandlingSection, type EmiHandle } from "./postpone-emi-handling";

/**
 * "What about this EMI?" — the three choices, on a CARD-LINKED purchase EMI (the case in the bug report: "Pay from my account"
 * was disabled), a plain EMI and a Loan. Pins: why an option is unavailable is said in words; a card EMI CAN be paid from the
 * user's own account (bank funding, debited once, funds re-checked); an expense is never suggested because only its amount and
 * date match ("lulu"); and nothing links until the user confirms it.
 */

const h = vi.hoisted(() => ({
  installments: [] as unknown[],
  emiRows: [] as unknown[],
  loanRows: [] as unknown[],
  transactions: [] as unknown[],
  accounts: [] as unknown[],
  emiRecord: vi.fn(async (..._a: unknown[]) => ({})),
  loanRecord: vi.fn(async (..._a: unknown[]) => ({})),
}));
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => undefined }) }));
vi.mock("@/hooks/use-emis", () => ({ useAllEmiInstallments: () => ({ data: h.installments }) }));
vi.mock("@/hooks/use-loans", () => ({ useAllLoanInstallments: () => ({ data: h.installments }) }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: h.accounts }) }));
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: h.transactions }) }));
vi.mock("@/features/emi/hooks/use-emi-data", () => ({ useEmiRows: () => ({ rows: h.emiRows }), useEmiActions: () => ({ recordPayment: h.emiRecord }) }));
vi.mock("@/features/emi/components/emi-card", () => ({ emiCardLabel: () => "HDFC Credit Card" }));
vi.mock("@/features/loans/hooks/use-loans-data", () => ({ useLoanRows: () => ({ rows: h.loanRows }), useLoanActions: () => ({ recordPayment: h.loanRecord }) }));
vi.mock("@/features/people/hooks/use-linked-people-readiness", () => ({ useLinkedPeopleReadiness: () => ({ readiness: null, isLoading: false }) }));
vi.mock("@/features/loans/lib/record-payment", async (orig) => ({
  ...(await orig<typeof import("@/features/loans/lib/record-payment")>()),
  loanPaymentFigures: () => ({ next: null, dueAmount: 1000, dueCount: 1, totalRemaining: 1000, payableCount: 1 }),
  planLoanPayment: () => ({ ok: true, amount: 1000, includeUpcomingInstallments: false, extra: 0 }),
}));
vi.mock("@/lib/engines/loan-payment-core", () => ({ planLoanPaymentCore: () => ({ installmentIds: ["i2"], overflow: 0, payments: [{ installmentId: "i2" }] }) }));
vi.mock("@/components/finance/account-label", () => ({
  AccountSelect: ({ accounts, value, onChange, ariaLabel }: { accounts: { id: string; name: string }[]; value: string; onChange: (v: string) => void; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  ),
  AccountMark: () => null,
}));

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(11, 16);

const inst = (id: string, seq: number) => ({ id, scheduleId: "sch", ownerType: "emi", ownerId: "e1", sequenceNumber: seq, dueDate: d(10, seq), amountDue: 1000, amountPaid: 0, isSkipped: false, principalPortion: 800, interestPortion: 200, deletedAt: null, createdAt: d(1, 1) });
const emi = (patch: Record<string, unknown> = {}) => ({ id: "e1", name: "iPhone EMI", lenderName: "HDFC Bank", categoryId: "cat-phone", purchaseTransactionId: null, linkedCreditCardId: "card1", scheduleId: "sch", ...patch });
const tx = (patch: Record<string, unknown>) => ({ id: "t", type: "expense", amount: 1000, dateTime: d(10, 1), accountId: "boi", description: "", notes: "", categoryId: "x", deletedAt: null, excludeFromCalculations: false, transferId: null, loanId: null, emiId: null, billPaymentId: null, fundedByPersonId: null, isPersonLedgerMovement: false, paymentAllocationType: null, earlierPaymentLink: null, ...patch });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.emiRecord.mockReset();
  h.emiRecord.mockImplementation(async () => ({}));
  h.loanRecord.mockReset();
  h.loanRecord.mockImplementation(async () => ({}));
  h.accounts = [
    { id: "boi", name: "Bank of India Savings", type: "bank", deletedAt: null, currentBalance: 50000 },
    { id: "low", name: "Low", type: "bank", deletedAt: null, currentBalance: 300 },
    { id: "cardacct", name: "HDFC Credit Card", type: "card", deletedAt: null, currentBalance: 0 },
  ];
  h.transactions = [];
  h.installments = [inst("i1", 1)];
  h.emiRows = [{ emi: emi(), installments: [inst("i1", 1)], linkedCard: { accountId: "cardacct" } }];
  h.loanRows = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The parent hands the section a STABLE callback (a state setter) — a fresh one per render would re-publish forever.
function setup(rowKey = "emi-inst:i1") {
  const box: { handle: EmiHandle | null } = { handle: null };
  const onHandle = (hd: EmiHandle | null) => {
    box.handle = hd;
  };
  const row = { key: rowKey } as LedgerRow;
  render(<EmiHandlingSection row={row} onHandle={onHandle} />);
  return { handle: () => box.handle! };
}
const pick = (choice: "payNow" | "paidEarlier" | "pending") => fireEvent.click(screen.getByTestId(`emi-handling-${choice}`));

describe("Pay from my account", () => {
  it("a card-linked EMI is payable from the user's own bank account: enabled, no 'unavailable' message, nothing billed to the card", async () => {
    const s = setup();
    const btn = screen.getByTestId("emi-handling-payNow") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByTestId("emi-pay-unavailable")).toBeNull();
    pick("payNow");
    expect(s.handle().blocker).toBe("Choose account");
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "boi" } });
    expect(screen.queryByRole("option", { name: "HDFC Credit Card" })).toBeNull(); // a card never funds its own EMI
    expect(screen.getByTestId("payment-source-summary").textContent).toContain("₹50,000"); // balance
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹49,000"); // projected balance
    expect(screen.getByTestId("emi-card-note").textContent).toBe("₹1,000 leaves Bank of India Savings. Nothing is billed to HDFC Credit Card.");
    expect(s.handle().blocker).toBeNull();
    expect(s.handle().action).toBe("pay ₹1,000");

    await act(async () => s.handle().run());
    expect(h.emiRecord).toHaveBeenCalledTimes(1);
    expect(h.emiRecord.mock.calls[0][2]).toMatchObject({ amount: 1000, accountId: "boi", fundingMode: "bank", enforceFunds: true, targetInstallmentId: "i1", recordedEarlier: null, linkedTransactionId: null });
  });

  it("Case A (the purchase is already on the card): the bank pays the interest as the EMI charge and the principal goes to the card — debited once", () => {
    h.transactions = [tx({ id: "purchase", accountId: "cardacct", description: "iPhone" })];
    h.emiRows = [{ emi: emi({ purchaseTransactionId: "purchase" }), installments: [inst("i1", 1)], linkedCard: { accountId: "cardacct" } }];
    const s = setup();
    pick("payNow");
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "boi" } });
    expect(screen.getByTestId("emi-card-note").textContent).toBe("₹200 leaves Bank of India Savings as the EMI charge and ₹800 is paid to HDFC Credit Card. Nothing is billed to the card.");
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹49,000"); // the bank is debited the full installment, once
    expect(s.handle().blocker).toBeNull();
  });

  it("an account that can't cover it blocks the payment and says so", () => {
    const s = setup();
    pick("payNow");
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "low" } });
    expect(s.handle().blocker).toBe("Not enough balance");
    expect(h.emiRecord).not.toHaveBeenCalled();
  });

  it("a plain (non-card) EMI is paid with the card-less funding mode", async () => {
    h.emiRows = [{ emi: emi({ linkedCreditCardId: null }), installments: [inst("i1", 1)], linkedCard: undefined }];
    const s = setup();
    pick("payNow");
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "boi" } });
    expect(screen.queryByTestId("emi-card-note")).toBeNull();
    await act(async () => s.handle().run());
    expect(h.emiRecord.mock.calls[0][2]).toMatchObject({ accountId: "boi", fundingMode: "card", enforceFunds: true });
  });

  it("a Loan installment that isn't the oldest unpaid: the option is disabled AND the reason is stated, naming the installment to pay first", () => {
    const first = { ...inst("i1", 1), ownerType: "loan" };
    const second = { ...inst("i2", 2), ownerType: "loan" };
    h.installments = [first, second];
    h.emiRows = [];
    h.loanRows = [{ loan: { id: "L1", name: "Bike loan" }, installments: [first, second], direction: "taken" }];
    setup("loan-inst:i2");
    expect((screen.getByTestId("emi-handling-payNow") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("emi-pay-unavailable").textContent).toBe("Pay from my account isn't available: A loan is paid in order — installment #1 is still unpaid. Pay it first (Loan & EMI), or choose Already paid.");
  });
});

describe("Pay later", () => {
  it("is the default and writes nothing for the bank", async () => {
    const s = setup();
    expect(screen.getByTestId("emi-handling-pending").getAttribute("aria-checked")).toBe("true");
    expect(s.handle().choice).toBe("later");
    await act(async () => s.handle().run());
    expect(h.emiRecord).not.toHaveBeenCalled();
    expect(h.loanRecord).not.toHaveBeenCalled();
  });
});

describe("Already paid — transaction linking", () => {
  const lulu = tx({ id: "lulu", description: "lulu", categoryId: "groceries", amount: 1000, dateTime: d(10, 1), accountId: "boi" });

  it("an expense with only the same amount and date ('lulu') is NOT suggested: empty state, nothing linked, nothing selected", async () => {
    h.transactions = [lulu];
    const s = setup();
    pick("paidEarlier");
    expect(screen.getByTestId("link-transaction").textContent).toContain("no likely match");
    fireEvent.click(screen.getByText(/Link a transaction you already recorded/));
    expect(screen.getByTestId("link-not-linked")).toBeTruthy();
    expect(screen.getByTestId("link-empty").textContent).toContain("No recorded expense looks like this EMI payment");
    expect(screen.queryByTestId("link-candidate")).toBeNull(); // not listed until asked for
    expect(screen.queryByTestId("linked-transaction")).toBeNull();

    // Saving without a link records the payment with NO transaction reference.
    fireEvent.change(screen.getByLabelText("Date paid"), { target: { value: "01/10/2026" } });
    await act(async () => s.handle().run());
    expect(h.emiRecord.mock.calls[0][2]).toMatchObject({ recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, accountId: null });
    expect((h.emiRecord.mock.calls[0][2] as { linkedTransactionId: string | null }).linkedTransactionId).toBeNull();
  });

  it("the unrelated expense is reachable only on request, behind a warning, and picking it still needs an explicit confirmation", async () => {
    h.transactions = [lulu];
    const s = setup();
    pick("paidEarlier");
    fireEvent.click(screen.getByText(/Link a transaction you already recorded/));
    fireEvent.click(screen.getByTestId("link-show-others"));
    expect(screen.getByText(/nothing ties them to this EMI/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("link-candidate"));
    // Picked, not linked: details + a warning, and the payment still has no link.
    const pending = screen.getByTestId("link-pending").textContent!;
    expect(pending).toContain("lulu");
    expect(pending).toContain("₹1,000");
    expect(pending).toContain("Bank of India Savings");
    expect(pending).toContain("Same amount as the EMI");
    expect(pending).toContain("Paid on the due date");
    expect(pending).toContain("Nothing in this expense mentions the EMI");
    expect(screen.queryByTestId("linked-transaction")).toBeNull();
    fireEvent.click(screen.getByText("Not this one"));
    expect(screen.queryByTestId("linked-transaction")).toBeNull();
    await act(async () => s.handle().run());
    expect((h.emiRecord.mock.calls[0][2] as { linkedTransactionId: string | null }).linkedTransactionId).toBeNull();
  });

  it("an expense that names the EMI IS suggested with its reason, and links only after 'Link this expense'", async () => {
    h.transactions = [lulu, tx({ id: "real", description: "iPhone EMI Oct", categoryId: "loan_payment", amount: 1000, dateTime: d(10, 3), accountId: "boi" })];
    const s = setup();
    pick("paidEarlier");
    expect(screen.getByTestId("link-transaction").textContent).toContain("1 likely");
    fireEvent.click(screen.getByText(/Link a transaction you already recorded/));
    const rows = screen.getAllByTestId("link-candidate");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("iPhone EMI Oct");
    expect(rows[0].textContent).toContain("Mentions “iPhone EMI”");
    fireEvent.click(rows[0]);
    expect(screen.queryByTestId("linked-transaction")).toBeNull();
    fireEvent.click(screen.getByTestId("link-confirm"));
    expect(screen.getByTestId("linked-transaction").textContent).toContain("Linked: iPhone EMI Oct");
    await act(async () => s.handle().run());
    expect(h.emiRecord.mock.calls[0][2]).toMatchObject({ amount: 1000, linkedTransactionId: "real", recordedEarlier: { dateKnown: true } });
  });

  it("the EMI's own purchase transaction can never be offered as its payment", () => {
    h.transactions = [tx({ id: "purchase", description: "iPhone EMI purchase", amount: 1000, dateTime: d(9, 28) })];
    h.emiRows = [{ emi: emi({ purchaseTransactionId: "purchase" }), installments: [inst("i1", 1)], linkedCard: { accountId: "cardacct" } }];
    setup();
    pick("paidEarlier");
    expect(screen.queryByTestId("link-transaction")).toBeNull(); // nothing eligible at all → no picker
  });
});
