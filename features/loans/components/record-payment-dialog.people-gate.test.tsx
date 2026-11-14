// @vitest-environment jsdom
import type { ReimbursementItem, ReimbursementLine, ReimbursementResult } from "@/lib/engines/historical-reimbursement";
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { linkedStateOf, type LinkedPeopleReadiness, type LinkedPerson } from "@/lib/engines/linked-people-readiness";
import type { InstallmentBreakdown, ShareLine } from "@/lib/engines/installment-participants";
import { RecordPaymentDialog, type PaymentTarget } from "./record-payment-dialog";

/**
 * Loan / EMI Record payment (Pay EMI) — the user scenarios A–H. Summary first; one compact row per person
 * (display only — their status, never an action). While a person's share of THAT installment is still open
 * the user answers one plain question, "Has their share been paid?" — Yes or No, nothing preselected.
 * Either answer only marks status (saved in the payment's own note) and unblocks paying the lender; it
 * never writes a People ledger entry, moves money, or settles anyone — a real reimbursement is recorded
 * separately, in the person's own People Record Payment screen. Fully received already → no question, no
 * acknowledgement. "Mark an old EMI as paid" records a past payment with no account movement. The footer
 * always names what it does. The participant breakdown reads the People statements (mocked here). Layout
 * at phone width is not testable in jsdom — H checks the content stays one row per person with one footer
 * action.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/emi" }));
vi.mock("next/link", () => ({
  default: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={String(href)} {...rest}>
        {children}
      </a>
    );
  }),
}));
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
const emiRecordPayment = vi.fn(async (..._args: unknown[]) => ({ allocationType: "regular" }));
const loanRecordPayment = vi.fn(async (..._args: unknown[]) => ({ overallAllocationType: "regular", reamortization: null }));
vi.mock("@/features/emi/hooks/use-emi-data", () => ({ useEmiActions: () => ({ recordPayment: emiRecordPayment }) }));
vi.mock("@/features/loans/hooks/use-loans-data", () => ({ useLoanActions: () => ({ recordPayment: loanRecordPayment }) }));
vi.mock("@/features/emi/components/emi-card", () => ({ emiCardLabel: () => null }));
vi.mock("@/features/loans/components/loan-card", () => ({ loanDisplayName: (r: { loan: { name: string } }) => r.loan.name }));
vi.mock("@/features/loans/components/loans-workspace", () => ({ AddElsewhereLink: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(async () => {}) }) }));
let mockSbiBalance = 10000;
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", type: "bank", isDefault: true, deletedAt: null, currentBalance: mockSbiBalance }] }) }));
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: [] }) }));
// The paying account is never defaulted: a native select stands in for the Radix one so tests choose it explicitly.
vi.mock("@/components/finance/account-label", () => ({
  AccountSelect: ({ accounts, value, onChange, ariaLabel }: { accounts: { id: string; name: string }[]; value: string; onChange: (id: string) => void; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose account</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  ),
  AccountMark: () => null,
  AccountLabel: ({ account }: { account: { name: string } }) => <span>{account.name}</span>,
}));
vi.mock("@/features/people/hooks/use-linked-funds", () => ({ useLinkedFunds: () => ({ funds: [] }) }));
vi.mock("@/features/loans/hooks/use-payment-history", () => ({
  EMI_PAYMENT_HISTORY_KEY: "emiPaymentHistory",
  useEmiPaymentHistory: () => ({ data: { payments: [], breakdowns: [] }, isLoading: false }),
  useLoanPaymentHistory: () => ({ data: { payments: [], events: [], disbursements: [] }, isLoading: false }),
}));
vi.mock("@/features/people/components/linked-funds", () => ({ LinkedFundsPayNotice: () => null }));
let deferralsMock: unknown[] = [];
const deferralApply = vi.fn(async (..._args: unknown[]) => ({ outcome: "written" }));
vi.mock("@/features/people/hooks/use-payment-deferrals", () => ({
  usePaymentDeferralActions: () => ({ apply: deferralApply }),
  usePersonPaymentDeferrals: () => ({ deferrals: deferralsMock, isLoading: false }),
  usePeoplePaymentDeferrals: (ids: string[]) => ({ deferralsByPerson: Object.fromEntries(ids.map((id) => [id, deferralsMock])), isLoading: false }),
}));
vi.mock("@/features/settings/hooks/use-user-preferences", () => ({ useMonthCycleStartDay: () => 1 }));
let breakdownState: { breakdown: InstallmentBreakdown | null; isLoading: boolean } = { breakdown: null, isLoading: false };
vi.mock("@/features/loans/hooks/use-installment-breakdown", () => ({
  useInstallmentBreakdown: (target: unknown) => (target == null ? { breakdown: null, isLoading: false } : breakdownState),
}));

// Historical reimbursement: People lines (as the statement engine would give them) and the People write.
let reimbLines: ReimbursementLine[] = [];
const reimbRecord = vi.fn(async (items: readonly ReimbursementItem[], _accountId: string, previous: Record<string, ReimbursementResult> = {}) => ({
  ...previous,
  ...Object.fromEntries(items.map((i) => [i.key, { status: "recorded" as const }])),
}));
vi.mock("@/features/loans/hooks/use-historical-reimbursement", () => ({
  useHistoricalReimbursement: (target: unknown) => ({ lines: target == null ? [] : reimbLines, isLoading: false, record: reimbRecord }),
}));

let peopleState: { readiness: LinkedPeopleReadiness | null; isLoading: boolean } = { readiness: null, isLoading: false };
const readinessTargets: unknown[] = [];
vi.mock("@/features/people/hooks/use-linked-people-readiness", () => ({
  useLinkedPeopleReadiness: (target: unknown) => {
    readinessTargets.push(target);
    return target == null ? { readiness: null, isLoading: false } : peopleState;
  },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);
beforeEach(() => {
  push.mockClear();
  emiRecordPayment.mockClear();
  loanRecordPayment.mockClear();
  readinessTargets.length = 0;
  peopleState = { readiness: null, isLoading: false };
  breakdownState = { breakdown: null, isLoading: false };
  deferralsMock = [];
  deferralApply.mockClear();
  reimbLines = [];
  reimbRecord.mockClear();
  mockSbiBalance = 10000;
});

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
// #1 is 3 days overdue, #2 is due in 2 days: only a DUE installment's People shares gate a lender payment.
function installment(id: string, sequenceNumber: number, ownerType: "emi" | "loan", dueOffset = sequenceNumber * 5 - 8): Installment {
  return {
    id, scheduleId: "sch", ownerType, ownerId: "src", sequenceNumber, dueDate: day(dueOffset), amountDue: 3000, amountPaid: 0, isSkipped: false,
    principalPortion: null, interestPortion: null, createdAt: day(-30), deletedAt: null, lastEditedAt: null, editHistory: [],
  };
}

function person(personId: string, personName: string, share: number, received: number, key: string): LinkedPerson {
  const remaining = share - received;
  const state = linkedStateOf(share, remaining);
  return { personId, personName, share, received, remaining, state, obligations: [{ key, title: "Share", share, received, remaining, state }] };
}
function readinessOf(list: LinkedPerson[]): LinkedPeopleReadiness {
  const peopleShare = list.reduce((s, p) => s + p.share, 0);
  const received = list.reduce((s, p) => s + p.received, 0);
  return { lenderDue: 3000, people: [...list].sort((a, b) => b.remaining - a.remaining), peopleShare, received, stillExpected: peopleShare - received, yourPortion: 3000 - peopleShare };
}

const line = (key: string, seq: number, share: number, received: number): ShareLine => {
  const remaining = share - received;
  return { key, installmentId: key.split(":")[1], sequenceNumber: seq, dueDate: new Date(), share, received, remaining, state: linkedStateOf(share, remaining) };
};
function breakdownOf(parts: { id: string; name: string; current: ShareLine; carried?: ShareLine[] }[], lenderPaid = 0): InstallmentBreakdown {
  const participants = parts.map((p) => {
    const carried = p.carried ?? [];
    return { personId: p.id, personName: p.name, current: p.current, carried, outstanding: p.current.remaining + carried.reduce((t, l) => t + l.remaining, 0) };
  });
  const peopleShare = parts.reduce((t, p) => t + p.current.share, 0);
  return { installmentAmount: 3000, lenderPaid, lenderRemaining: 3000 - lenderPaid, yourShare: 3000 - peopleShare, participants, othersOwe: participants.reduce((t, p) => t + p.outstanding, 0) };
}

function emiTarget(): PaymentTarget {
  const installments = [installment("i1", 1, "emi"), installment("i2", 2, "emi")];
  return {
    kind: "emi",
    row: { emi: { id: "src", name: "Home EMI", installmentCount: 2 }, installments, nextInstallment: installments[0], remainingBalance: 6000 } as never,
  };
}
function loanTarget(direction: "taken" | "given" = "taken"): PaymentTarget {
  const installments = [installment("l1", 1, "loan"), installment("l2", 2, "loan")];
  const loan = {
    id: "src", name: "Car loan", loanAmount: 6000, loanDate: day(-30), repaymentType: "installment", direction, interest: null,
    installmentFrequency: "monthly", installmentCount: 2, scheduleId: "sch",
  } as unknown as Loan;
  return {
    kind: "loan",
    row: { loan, installments, direction, outstandingPrincipal: 6000, totalInstallments: 2, principalPrepaid: 0 } as never,
  };
}

const pickAccount = async (user: ReturnType<typeof userEvent.setup>, label: RegExp | string = "Paid from account") => {
  await user.selectOptions(screen.getByLabelText(label), "sbi");
};
const renderDialog = (target: PaymentTarget) => render(<RecordPaymentDialog target={target} open onOpenChange={() => {}} />);
const panel = () => screen.queryByRole("region", { name: "Who pays this installment" });
const footer = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

/** Record past payments → the one installment the dialog was on → the single past-payment form (unchanged write path). */
async function openPastSingle(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: /past (payment|repayment)/i }));
  await user.click(screen.getByRole("button", { name: /^Continue with 1 (EMI|installment)$/ }));
}
const EARLIER_ACK = { acknowledgedUnsettledPeople: true, reason: "Recorded as already paid earlier (before FlowFi) — People shares unchanged" };
const noonOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
const dueOf = (t: PaymentTarget) => (t.row as unknown as { installments: Installment[] }).installments[0].dueDate;

/** AMMA and JOHN each owe ₹1,000 of #1 (₹3,000); my share ₹1,000. */
const BOTH_PENDING = () => readinessOf([person("amma", "AMMA", 1000, 0, "emi-inst:i1"), person("john", "JOHN", 1000, 0, "emi-inst:i1")]);
const BOTH_PENDING_BREAKDOWN = () =>
  breakdownOf([
    { id: "amma", name: "AMMA", current: line("emi-inst:i1", 1, 1000, 0) },
    { id: "john", name: "JOHN", current: line("emi-inst:i1", 1, 1000, 0) },
  ]);

describe("Summary — what the lender is owed comes first", () => {
  it("title, installment, primary figure and the people figures; the loan total is secondary", () => {
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    expect(screen.getByText("Pay EMI")).toBeTruthy();
    expect(screen.getByText("Home EMI · Installment #1 of 2")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Payment summary" });
    expect(within(summary).getByText("To pay lender")).toBeTruthy();
    expect(screen.getByText(/^Overdue · /)).toBeTruthy();
    const fact = (label: string) => within(summary).getByText(label).nextElementSibling?.textContent;
    expect([fact("Your share"), fact("Owed to you by others"), fact("EMI outstanding")]).toEqual(["₹1,000", "₹2,000", "₹6,000"]);
  });

  it("reads readiness for THIS installment only (by id)", () => {
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    renderDialog(emiTarget());
    expect(readinessTargets.at(-1)).toEqual({ kind: "emi", installmentId: "i1", installmentIds: ["i1"], lenderDue: 3000 });
  });
});

describe("A — everyone has paid their share", () => {
  it("no decision; the footer pays the lender; no acknowledgement", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([person("amma", "AMMA", 1000, 1000, "emi-inst:i1"), person("john", "JOHN", 1000, 1000, "emi-inst:i1")]), isLoading: false };
    breakdownState = {
      breakdown: breakdownOf([
        { id: "amma", name: "AMMA", current: line("emi-inst:i1", 1, 1000, 1000) },
        { id: "john", name: "JOHN", current: line("emi-inst:i1", 1, 1000, 1000) },
      ]),
      isLoading: false,
    };
    renderDialog(emiTarget());
    expect(screen.getByTestId("share-amma").textContent).toBe("Received");
    expect(screen.queryByRole("region", { name: "Has their share been paid?" })).toBeNull();
    expect(screen.queryByTestId("account-movement")).toBeNull(); // no account is assumed until it is chosen
    await pickAccount(user);
    expect(screen.getByTestId("account-movement").textContent).toBe("₹3,000 will be taken from SBI.");
    await user.click(footer("Pay ₹3,000 to lender"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, accountId: "sbi", targetInstallmentId: "i1", peopleGateAcknowledgement: null, recordedEarlier: null });
  });
});

describe("B — AMMA and JOHN haven't paid", () => {
  it("nothing is preselected: the footer waits for an answer and payment fields stay hidden", () => {
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    const confirm = screen.getByRole("region", { name: "Has their share been paid?" });
    const radios = within(confirm).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Yes, already paid", "No, not yet"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(footer("Has their share been paid?").disabled).toBe(true);
    expect(screen.queryByRole("region", { name: "Payment details" })).toBeNull();
    // Display only now — no in-dialog action buttons per person.
    expect(screen.queryByRole("button", { name: /record money received/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /postpone/i })).toBeNull();
    expect(screen.getByTestId("share-john").textContent).toBe("Not received");
  });

  it("answering 'No' pays the lender once with the new acknowledgement; their shares stay owed, and no People entry is written", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    await user.click(screen.getByRole("radio", { name: "No, not yet" }));
    expect(screen.getByTestId("share-not-paid-warning")).toBeTruthy();
    await pickAccount(user);
    expect(screen.getByTestId("account-movement").textContent).toBe("₹3,000 will be taken from SBI.");
    expect(screen.getByTestId("people-impact").textContent).toBe("People: AMMA and JOHN still owe you ₹2,000 — paying the lender doesn't mark anyone as paid.");
    const pay = footer("Pay ₹3,000 to lender");
    await user.click(pay);
    await user.click(pay); // double submit
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({
      amount: 3000,
      accountId: "sbi",
      note: "Marked: AMMA and JOHN hasn't paid their share yet — paying the lender anyway.",
      recordedEarlier: null,
      peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "Marked: AMMA and JOHN hasn't paid their share yet — paying the lender anyway." },
    });
    expect(push).not.toHaveBeenCalled();
    expect(reimbRecord).not.toHaveBeenCalled();
  });

  it("answering 'Yes' also pays the lender, with the 'already paid' acknowledgement — still no People entry", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    await user.click(screen.getByRole("radio", { name: "Yes, already paid" }));
    expect(screen.queryByTestId("share-not-paid-warning")).toBeNull();
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000 to lender"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({
      note: "Marked: AMMA and JOHN already paid their share of this.",
      peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "Marked: AMMA and JOHN already paid their share of this." },
    });
    expect(reimbRecord).not.toHaveBeenCalled();
  });

  it("Loan: answering 'No' forwards the acknowledgement", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 0, "loan-inst:l1")]), isLoading: false };
    renderDialog(loanTarget());
    expect(screen.getByText("Pay installment")).toBeTruthy();
    expect(footer("Has their share been paid?").disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: "No, not yet" }));
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000 to lender"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({
      accountId: "sbi",
      note: "Marked: JOHN hasn't paid their share yet — paying the lender anyway.",
      peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "Marked: JOHN hasn't paid their share yet — paying the lender anyway." },
    });
  });
});

describe("C / D — partial and postponed reimbursements", () => {
  it("C: a partial People payment reads exactly", () => {
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 600, "emi-inst:i1")]), isLoading: false };
    breakdownState = { breakdown: breakdownOf([{ id: "john", name: "JOHN", current: line("emi-inst:i1", 1, 1000, 600) }]), isLoading: false };
    renderDialog(emiTarget());
    expect(screen.getByTestId("share-john").textContent).toBe("₹600 of ₹1,000 received");
  });

  it("D: a share moved to a later cycle and an earlier unpaid share show in one compact row", () => {
    const later = { start: new Date(2099, 10, 1), end: new Date(2099, 10, 30) };
    deferralsMock = [
      { obligationKey: "emi-inst:i1", state: "active", expected: { cycle: later, reason: null, note: null }, frames: [] },
      { obligationKey: "emi-inst:i0", state: "active", expected: { cycle: later, reason: null, note: null }, frames: [] },
    ];
    breakdownState = {
      breakdown: breakdownOf([{ id: "john", name: "JOHN", current: line("emi-inst:i1", 2, 1000, 0), carried: [line("emi-inst:i0", 1, 1000, 0)] }]),
      isLoading: false,
    };
    renderDialog(emiTarget());
    expect(screen.getByTestId("share-john").textContent).toMatch(/^Not received · Postponed to Nov 2099 cycle · from \d{2} \w{3}$/);
    expect(screen.getByText(/\+ ₹1,000 still owed from #1/)).toBeTruthy();
    // The lender's own due date is unchanged by the postponement.
    expect(screen.getByText(/^Overdue · /)).toBeTruthy();
  });
});

describe("E — Mark an old EMI as paid", () => {
  it("EMI: old-payment fields replace the payment section; no account; People shares untouched", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 0, "emi-inst:i1")]), isLoading: false };
    breakdownState = { breakdown: breakdownOf([{ id: "john", name: "JOHN", current: line("emi-inst:i1", 1, 1000, 0) }]), isLoading: false };
    const target = emiTarget();
    renderDialog(target);
    await openPastSingle(user);
    expect(screen.getByTestId("past-payment-header").textContent).toContain("paid before FlowFi — no account balance changes");
    expect(screen.queryByRole("region", { name: "Has their share been paid?" })).toBeNull();
    expect(screen.queryByLabelText(/paid from account/i)).toBeNull();
    expect(screen.queryByTestId("account-movement")).toBeNull();
    const save = footer("Save past payment of ₹3,000");
    await user.click(save);
    await user.click(save); // double submit
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({
      amount: 3000,
      accountId: null,
      targetInstallmentId: "i1",
      date: noonOf(dueOf(target)),
      recordedEarlier: { dateKnown: true },
      peopleGateAcknowledgement: EARLIER_ACK,
    });
  });

  it("unknown date → stored on the installment's due date, flagged as not known", async () => {
    const user = userEvent.setup();
    const target = emiTarget();
    renderDialog(target);
    await openPastSingle(user);
    await user.click(screen.getByRole("checkbox", { name: /don't know the exact date/i }));
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ date: dueOf(target), recordedEarlier: { dateKnown: false } });
  });

  it("Loan: the account is for the record only; 'Pay now instead' goes back", async () => {
    const user = userEvent.setup();
    renderDialog(loanTarget());
    await openPastSingle(user);
    expect(screen.getByText("Paid from · for your records")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pay it now instead" }));
    expect(footer("Pay ₹3,000 to lender")).toBeTruthy();
    await openPastSingle(user);
    expect(footer("Save past payment of ₹3,000").disabled).toBe(true); // the record's account is chosen, never assumed
    await pickAccount(user);
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({
      accountId: "sbi",
      includeUpcomingInstallments: true,
      recordedEarlier: { dateKnown: true },
      expectedFirstInstallmentId: "l1",
      peopleGateAcknowledgement: EARLIER_ACK,
    });
  });

  it("after a failed save the kind of payment is fixed — a retry can't turn into a different one", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockRejectedValueOnce(new Error("offline"));
    renderDialog(emiTarget());
    await openPastSingle(user);
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Pay it now instead" })).toBeNull();
  });
});

describe("F / G — every amount is visible and named", () => {
  it("F: a part payment — named, one tap; the footer follows", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget());
    const group = screen.getByRole("radiogroup", { name: "How much are you paying?" });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Pay this installment"),
    ]);
    // Part payment, extra payment and "pay everything" open on request.
    await user.click(screen.getByTestId("other-ways-toggle"));
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Pay this installment"),
      expect.stringContaining("Part payment"),
      expect.stringContaining("All remaining installments · advanced"),
    ]);
    await user.click(screen.getByRole("radio", { name: /part payment/i }));
    await user.type(within(group).getByRole("spinbutton"), "1000");
    await pickAccount(user);
    await user.click(footer("Pay ₹1,000 to lender"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 1000, targetInstallmentId: "i1" });
  });

  it("G: pay all remaining", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget());
    await user.click(screen.getByTestId("other-ways-toggle"));
    await user.click(screen.getByRole("radio", { name: /all remaining installments/i }));
    await pickAccount(user);
    // An advanced action: it needs an explicit confirmation before it can be paid.
    expect(footer("Pay ₹6,000 to lender").disabled).toBe(true);
    await user.click(within(screen.getByTestId("remaining-warning")).getByRole("checkbox"));
    await user.click(footer("Pay ₹6,000 to lender"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 6000 });
  });
});

describe("H — many people (small screens)", () => {
  it("one compact row per person (display only), and one Yes/No question regardless of how many people share it", () => {
    const names = ["AMMA", "JOHN", "RAVI", "SANJU"];
    peopleState = { readiness: readinessOf(names.map((n) => person(n.toLowerCase(), n, 500, 0, "emi-inst:i1"))), isLoading: false };
    breakdownState = { breakdown: breakdownOf(names.map((n) => ({ id: n.toLowerCase(), name: n, current: line("emi-inst:i1", 1, 500, 0) }))), isLoading: false };
    renderDialog(emiTarget());
    expect(within(panel()!).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryAllByRole("button", { name: /^Record money received from .* here$/ })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /^Postpone .*share here$/ })).toHaveLength(0);
    expect(within(screen.getByRole("region", { name: "Has their share been paid?" })).getAllByRole("radio")).toHaveLength(2);
    expect(footer("Has their share been paid?").disabled).toBe(true);
  });
});

describe("Edge states", () => {
  it("People data loading → the footer waits (disabled), never reads as 'nothing linked'", () => {
    peopleState = { readiness: null, isLoading: true };
    renderDialog(emiTarget());
    expect(footer("Checking shared people…").disabled).toBe(true);
  });

  it("no linked People → no people section; pays straight away", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([]), isLoading: false };
    breakdownState = { breakdown: breakdownOf([]), isLoading: false };
    renderDialog(emiTarget());
    expect(panel()).toBeNull();
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000 to lender"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
  });

  it("paying an installment before it is due asks People about nothing", () => {
    const target = loanTarget();
    const future = [installment("l1", 1, "loan", 5), installment("l2", 2, "loan", 35)];
    renderDialog({ ...target, row: { ...(target.row as object), installments: future } } as PaymentTarget);
    expect(readinessTargets.at(-1)).toEqual({ kind: "loan", installmentId: "l1", installmentIds: [], lenderDue: 3000 });
  });

  it("a loan I gave (repayment received) has no People section", () => {
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 0, "loan-inst:l1")]), isLoading: false };
    renderDialog(loanTarget("given"));
    expect(readinessTargets.at(-1)).toBeNull();
    expect(panel()).toBeNull();
    expect(screen.getByText("Record repayment")).toBeTruthy();
    expect(footer("Record ₹3,000 received")).toBeTruthy();
  });
});

// The old "H — shares already moved to a later cycle in People" scenario (all-postponed / lapsed-note /
// per-person collect-only-the-undecided-one) tested the removed 3-way decision UI directly. The underlying
// informational display it also touched — each person's own postponed/lapsed status text, via
// `InstallmentPeoplePanel` — is independent of that decision UI and is still covered in "C / D" above
// (unaffected by this rewrite).

describe("I — mark several old installments as paid", () => {
  function pastEmiTarget(): PaymentTarget {
    const installments = [installment("i1", 1, "emi", -90), { ...installment("i2", 2, "emi", -60), amountPaid: 3000 }, installment("i3", 3, "emi", -30), installment("i4", 4, "emi", 20)];
    return { kind: "emi", row: { emi: { id: "src", name: "Home EMI", installmentCount: 4 }, installments, nextInstallment: installments[0], remainingBalance: 9000 } as never };
  }

  it("lists due installments, paid ones locked; select all unpaid → review → one past payment each, no account", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockImplementation(async () => ({ alreadyRecorded: false, applied: 0, allocationType: "regularEmi" }));
    renderDialog(pastEmiTarget());
    await user.click(screen.getByRole("radio", { name: /past (payment|repayment)/i }));
    expect(screen.getByTestId("bulk-step").textContent).toBe("Step 1 of 3 · Choose EMIs");
    expect(screen.queryByTestId("candidate-i4")).toBeNull(); // not due yet
    expect(screen.getByTestId("candidate-i2").textContent).toContain("Paid");
    expect((screen.getByRole("checkbox", { name: "#2" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Continue with 2 EMIs"));
    // When they were paid is always the user's explicit answer — nothing is preselected.
    expect(footer("Choose when they were paid").disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /i don't know the dates/i }));
    await user.type(screen.getByRole("spinbutton", { name: "Amount for #3" }), "2500");
    await user.click(footer("Continue to review"));
    expect(screen.getByTestId("bulk-effect").textContent).toContain("Lender payments: no account balance changes.");
    const record = footer("Record 2 EMIs · ₹5,500");
    await user.click(record);
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(2));
    const [first, second] = emiRecordPayment.mock.calls.map((c) => c[2] as { idempotencyKey: string });
    expect(first).toMatchObject({ amount: 3000, accountId: null, targetInstallmentId: "i1", recordedEarlier: { dateKnown: false }, onlyTargetInstallment: true, peopleGateAcknowledgement: EARLIER_ACK });
    expect(second).toMatchObject({ amount: 2500, targetInstallmentId: "i3", onlyTargetInstallment: true });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("pay from my account: balance preview, one debit write per installment, no recorded-earlier mark, People untouched", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockImplementation(async () => ({ alreadyRecorded: false, applied: 0, allocationType: "regularEmi" }));
    renderDialog(pastEmiTarget());
    await user.click(screen.getByRole("radio", { name: /pay several/i }));
    expect(footer("Select EMIs").disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Review 2 EMIs · ₹6,000"));
    await pickAccount(user);
    expect(screen.getByTestId("bulk-balance-preview").textContent).toContain("SBI");
    expect(screen.getByTestId("bulk-balance-preview").textContent).toContain("₹10,000");
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹4,000");
    expect(screen.queryByLabelText(/date paid for/i)).toBeNull(); // one payment date, not per installment
    await user.click(footer("Pay 2 EMIs · ₹6,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(2));
    const calls = emiRecordPayment.mock.calls.map((c) => c[2] as Record<string, unknown>);
    for (const c of calls) {
      expect(c).toMatchObject({ accountId: "sbi", onlyTargetInstallment: true, amount: expect.any(Number) });
      expect(c.recordedEarlier).toBeNull();
      expect((c.peopleGateAcknowledgement as { acknowledgedUnsettledPeople: boolean }).acknowledgedUnsettledPeople).toBe(true);
    }
    expect(calls.map((c) => c.targetInstallmentId)).toEqual(["i1", "i3"]);
    expect(calls[0].idempotencyKey).not.toBe(calls[1].idempotencyKey);
  });

  it("interrupted batch: shows recorded / failed / pending, and the retry re-sends only the failed one (same key)", async () => {
    const user = userEvent.setup();
    let failI3 = true;
    emiRecordPayment.mockImplementation(async (...args: unknown[]) => {
      const p = args[2] as { targetInstallmentId: string };
      if (p.targetInstallmentId === "i3" && failI3) {
        failI3 = false;
        throw new Error("network");
      }
      return { alreadyRecorded: false, applied: 0, allocationType: "regularEmi" };
    });
    renderDialog(pastEmiTarget());
    await user.click(screen.getByRole("radio", { name: /pay several/i }));
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Review 2 EMIs · ₹6,000"));
    await pickAccount(user);
    await user.click(footer("Pay 2 EMIs · ₹6,000"));
    await waitFor(() => expect(screen.getByTestId("bulk-progress").textContent).toContain("1 recorded · 1 failed · 0 pending"));
    expect(emiRecordPayment).toHaveBeenCalledTimes(2);
    const failedKey = (emiRecordPayment.mock.calls[1][2] as { idempotencyKey: string }).idempotencyKey;
    await user.click(footer("Retry 1 failed"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(3)); // #1 is not sent again
    const retry = emiRecordPayment.mock.calls[2][2] as { targetInstallmentId: string; idempotencyKey: string };
    expect([retry.targetInstallmentId, retry.idempotencyKey]).toEqual(["i3", failedKey]);
    await waitFor(() => expect(screen.getByTestId("bulk-progress").textContent).toContain("2 recorded · 0 failed · 0 pending"));
  });

  it("card-linked EMI: no bank account is offered or sent — the card's own accounting applies", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockImplementation(async () => ({ alreadyRecorded: false, applied: 0, allocationType: "regularEmi" }));
    const base = pastEmiTarget() as unknown as { kind: "emi"; row: { emi: Record<string, unknown> } };
    base.row.emi.linkedCreditCardId = "card-1";
    renderDialog(base as never);
    await user.click(screen.getByRole("radio", { name: /pay several/i }));
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Review 2 EMIs · ₹6,000"));
    expect(screen.queryByRole("combobox", { name: /paid from account/i })).toBeNull();
    expect(screen.getByTestId("bulk-balance-preview").textContent).toContain("Charged to the linked card.");
    await user.click(footer("Pay 2 EMIs · ₹6,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(2));
    for (const c of emiRecordPayment.mock.calls) expect(c[2]).toMatchObject({ accountId: null, recordedEarlier: null });
  });

  it("people's shares per installment: a per-person batch answer, recorded only after every lender record is in", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockImplementation(async () => ({ alreadyRecorded: false, applied: 0, allocationType: "regularEmi" }));
    const l = (personId: string, personName: string, id: string, seq: number): ReimbursementLine => ({
      personId, personName, installmentId: id, sequenceNumber: seq, dueDate: id === "i1" ? day(-90) : day(-30), obligationKey: `emi-inst:${id}`, share: 1000, received: 0, remaining: 1000,
    });
    reimbLines = [l("amma", "AMMA", "i1", 1), l("amma", "AMMA", "i3", 3), l("sanju", "SANJU", "i1", 1), l("sanju", "SANJU", "i3", 3)];
    renderDialog(pastEmiTarget());
    await user.click(screen.getByRole("radio", { name: /past (payment|repayment)/i }));
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Continue with 2 EMIs"));
    await user.click(screen.getByRole("radio", { name: /i don't know the dates/i }));
    await user.click(footer("Continue to people's shares"));
    expect(screen.getByTestId("bulk-step").textContent).toBe("Step 3 of 4 · People's shares");
    // SANJU paid both; AMMA only #3, and only part of it.
    const sanjuRow = screen.getByText("SANJU").closest("li")!;
    await user.click(within(sanjuRow as HTMLElement).getByRole("button", { name: "All received" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "AMMA #3" })).getByRole("radio", { name: "Received some" }));
    await user.type(screen.getByRole("spinbutton", { name: /amount received from amma/i }), "250");
    // Mixed in one batch: everything already in the account except AMMA's #3, which is added now.
    await user.click(screen.getByRole("button", { name: "Already in my account" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Where is AMMA #3's money" })).getByRole("radio", { name: "Add to my account" }));
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("Account balance +₹250");
    await pickAccount(user, "Received into account");
    await user.click(footer("Continue to review"));
    // The review names what each person's answers come to before anything is saved.
    expect(screen.getByTestId("bulk-review-person-sanju").textContent).toContain("2 received · ₹2,000 (₹2,000 already in your balance)");
    expect(screen.getByTestId("bulk-review-person-amma").textContent).toContain("1 received · ₹250 (₹250 added to the account now) · ₹1,750 still to receive");
    expect(reimbRecord).not.toHaveBeenCalled();
    await user.click(footer("Record 2 EMIs · ₹6,000 · ₹2,250 from people"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment).toHaveBeenCalledTimes(2);
    expect(emiRecordPayment.mock.invocationCallOrder[1]).toBeLessThan(reimbRecord.mock.invocationCallOrder[0]);
    const items = reimbRecord.mock.calls[0][0];
    expect(items.map((i) => [i.personId, i.installmentId, i.amount, i.recordedEarlier])).toEqual([
      ["amma", "i3", 250, false],
      ["sanju", "i1", 1000, true],
      ["sanju", "i3", 1000, true],
    ]);
    // No received date typed → not known (the due date is only the stored placeholder).
    expect(items.every((i) => i.dateKnown === false)).toBe(true);
    expect(items.find((i) => i.installmentId === "i1")!.date.toDateString()).toBe(day(-90).toDateString());
    expect(items.find((i) => i.installmentId === "i3")!.date.toDateString()).toBe(day(-30).toDateString());
  });

  it("a failed installment is reported and retried alone, with the same key", async () => {
    const user = userEvent.setup();
    let fail = true;
    emiRecordPayment.mockImplementation(async (...args: unknown[]) => {
      const p = args[2] as { targetInstallmentId: string };
      if (p.targetInstallmentId === "i3" && fail) {
        fail = false;
        throw new Error("Network down");
      }
      return { alreadyRecorded: false, applied: 0, allocationType: "regularEmi" };
    });
    renderDialog(pastEmiTarget());
    await user.click(screen.getByRole("radio", { name: /past (payment|repayment)/i }));
    // #1 (the installment the dialog was on) starts ticked.
    expect(screen.getByRole("checkbox", { name: "#1" }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("checkbox", { name: "#3" }));
    await user.click(footer("Continue with 2 EMIs"));
    await user.click(screen.getByRole("radio", { name: /i don't know the dates/i }));
    await user.click(footer("Continue to review"));
    await user.click(footer("Record 2 EMIs · ₹6,000"));
    await waitFor(() => expect(screen.getByText("Network down")).toBeTruthy());
    const firstKey = (emiRecordPayment.mock.calls[1][2] as { idempotencyKey: string }).idempotencyKey;
    await user.click(footer("Retry 1 failed"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(3));
    expect(emiRecordPayment.mock.calls[2][2]).toMatchObject({ targetInstallmentId: "i3", idempotencyKey: firstKey });
  });
});

describe("J — Mark an old EMI as paid: had the people sharing it already paid you?", () => {
  const share = (personId: string, personName: string, received = 0): ReimbursementLine => ({
    // Due date deliberately different from the lender payment's date (the default "Date paid" is #1's due date).
    personId, personName, installmentId: "i1", sequenceNumber: 1, dueDate: day(-40), obligationKey: "emi-inst:i1", share: 1000, received, remaining: 1000 - received,
  });
  const choose = async (user: ReturnType<typeof userEvent.setup>, who: string, option: string) =>
    user.click(within(screen.getByRole("radiogroup", { name: who })).getByRole("radio", { name: option }));

  it("nothing is assumed received; a received share needs the balance answer; lender first, then the People settlement (no account change)", async () => {
    const user = userEvent.setup();
    reimbLines = [share("amma", "AMMA"), share("sanju", "SANJU")];
    renderDialog(emiTarget());
    await openPastSingle(user);
    expect(screen.getByRole("heading", { name: /already paid you/i })).toBeTruthy();
    expect(screen.queryByText(/already included in your flowfi account balance/i)).toBeNull();
    expect(footer("Save past payment of ₹3,000")).toBeTruthy();

    await choose(user, "SANJU", "Received in full");
    const save = footer("Save past payment of ₹3,000");
    expect(save.disabled).toBe(true); // where is the money? must be answered
    // The date already given for the lender payment is the starting point — not asked again from today's calendar.
    expect(screen.queryByText("No date entered — it will be saved as “Date not known”.")).toBeNull();
    expect((screen.getByLabelText("Date received from SANJU") as HTMLInputElement).value).not.toBe("");
    await choose(user, "Where is SANJU's money", "Already in my account");
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("AMMA: ₹1,000 still to receive");
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("SANJU: fully received");
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("Account balance won't change");
    expect(footer("Save past payment of ₹3,000 · ₹1,000 from people").disabled).toBe(true); // no account is assumed
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000 · ₹1,000 from people"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment).toHaveBeenCalledTimes(1);
    expect(emiRecordPayment.mock.invocationCallOrder[0]).toBeLessThan(reimbRecord.mock.invocationCallOrder[0]);
    const [items, accountId] = reimbRecord.mock.calls[0];
    expect(accountId).toBe("sbi");
    expect(items).toHaveLength(1);
    // Untouched, the person's date starts on the lender payment's date and is saved as a known date.
    expect(items[0]).toMatchObject({ personId: "sanju", obligationKey: "emi-inst:i1", amount: 1000, recordedEarlier: true, dateKnown: true });
    expect(items[0].date.toDateString()).toBe((emiRecordPayment.mock.calls[0][2] as { date: Date }).date.toDateString());
  });

  it("clearing the starting date makes it 'Date not known' — the due date is then only a placeholder", async () => {
    const user = userEvent.setup();
    reimbLines = [share("sanju", "SANJU")];
    renderDialog(emiTarget());
    await openPastSingle(user);
    await choose(user, "SANJU", "Received in full");
    await user.clear(screen.getByLabelText("Date received from SANJU"));
    expect(screen.getByText("No date entered — it will be saved as “Date not known”.")).toBeTruthy();
    await choose(user, "Where is SANJU's money", "Already in my account");
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000 · ₹1,000 from people"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    const item = reimbRecord.mock.calls[0][0][0];
    expect(item).toMatchObject({ dateKnown: false });
    expect(item.date.toDateString()).toBe(day(-40).toDateString());
  });

  it("received some + 'Add money to my account': an ordinary receipt for exactly that amount", async () => {
    const user = userEvent.setup();
    reimbLines = [share("amma", "AMMA")];
    renderDialog(emiTarget());
    await openPastSingle(user);
    await choose(user, "AMMA", "Received some");
    await user.type(screen.getByRole("spinbutton", { name: /amount received from amma/i }), "400");
    await user.clear(screen.getByLabelText("Date received from AMMA"));
    await user.type(screen.getByLabelText("Date received from AMMA"), "05/09/2026");
    await choose(user, "Where is AMMA's money", "Add to my account");
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("AMMA: ₹600 still to receive");
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("Account balance +₹400");
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000 · ₹400 from people"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(reimbRecord.mock.calls[0][0][0]).toMatchObject({ amount: 400, recordedEarlier: false, dateKnown: true });
    expect(reimbRecord.mock.calls[0][0][0].date).toEqual(new Date(2026, 8, 5, 12));
  });

  it("a share People already shows as received is listed as such and never offered again", async () => {
    const user = userEvent.setup();
    reimbLines = [share("sanju", "SANJU", 1000)];
    renderDialog(emiTarget());
    await openPastSingle(user);
    expect(screen.getByText("Received earlier")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "SANJU" })).toBeNull();
  });

  it("a People write that fails is retried alone — the lender record is never written again", async () => {
    const user = userEvent.setup();
    reimbLines = [share("amma", "AMMA"), share("sanju", "SANJU")];
    reimbRecord.mockImplementationOnce(async (items) => Object.fromEntries(items.map((i) => [i.key, i.personId === "amma" ? { status: "failed" as const, error: "offline" } : { status: "recorded" as const }])));
    renderDialog(emiTarget());
    await openPastSingle(user);
    await choose(user, "AMMA", "Received in full");
    await choose(user, "SANJU", "Received in full");
    await user.click(screen.getByRole("button", { name: "Already in my account" }));
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000 · ₹2,000 from people"));
    const retry = await screen.findByRole("button", { name: "Retry people's payments" });
    await user.click(retry);
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(2));
    expect(emiRecordPayment).toHaveBeenCalledTimes(1);
    const retried = reimbRecord.mock.calls[1][0];
    expect(retried.map((i) => i.personId)).toEqual(["amma"]);
    // Same deterministic key as the first attempt — a write that did land is found, not repeated.
    expect(retried[0].key).toBe(reimbRecord.mock.calls[0][0].find((i) => i.personId === "amma")!.key);
  });
});

describe("Paying account — balance preview and funds", () => {
  it("shows balance, payment and the balance after once the account is chosen — never before", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget());
    expect(screen.queryByTestId("payment-source-summary")).toBeNull();
    expect(footer("Pay ₹3,000 to lender").disabled).toBe(true); // account not chosen yet
    await pickAccount(user);
    const summary = screen.getByTestId("payment-source-summary");
    expect(summary.textContent).toContain("SBI");
    expect(summary.textContent).toContain("₹10,000");
    expect(summary.textContent).toContain("₹3,000");
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹7,000");
  });

  it("a payment equal to the balance is allowed (₹0 after) and asks the write to re-check funds", async () => {
    const user = userEvent.setup();
    mockSbiBalance = 3000;
    renderDialog(emiTarget());
    await pickAccount(user);
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹0");
    await user.click(footer("Pay ₹3,000 to lender"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, accountId: "sbi", enforceFunds: true });
  });

  it("insufficient funds: names the shortfall and disables the payment — nothing is sent", async () => {
    const user = userEvent.setup();
    mockSbiBalance = 2500;
    renderDialog(emiTarget());
    await pickAccount(user);
    expect(screen.getByTestId("payment-source-insufficient").textContent).toContain("short by ₹500");
    expect(footer("Pay ₹3,000 to lender").disabled).toBe(true);
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("a Loan payment also re-checks funds in the write", async () => {
    const user = userEvent.setup();
    renderDialog(loanTarget());
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000 to lender"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({ accountId: "sbi", enforceFunds: true, recordedEarlier: null });
  });

  it("'already paid earlier' never checks or deducts funds, even on an empty account", async () => {
    const user = userEvent.setup();
    mockSbiBalance = 0;
    renderDialog(loanTarget());
    await openPastSingle(user);
    await pickAccount(user);
    expect(screen.queryByTestId("payment-source-summary")).toBeNull();
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({ enforceFunds: false, recordedEarlier: { dateKnown: true } });
  });

  it("a write-time InsufficientFunds refusal (stale preview) keeps the dialog open with the message", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockRejectedValueOnce(Object.assign(new Error("SBI has ₹1,000 — not enough for ₹3,000."), { name: "InsufficientFundsError" }));
    renderDialog(emiTarget());
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000 to lender"));
    await waitFor(() => expect(screen.getByText(/Nothing was saved. SBI has ₹1,000/)).toBeTruthy());
  });
});

describe("K — clearer payment choices (Phase 2)", () => {
  function loanThreeTarget(pick?: string): PaymentTarget {
    // #1 overdue, #2 and #3 upcoming — Loan installments are paid in order.
    const installments = [installment("l1", 1, "loan", -3), installment("l2", 2, "loan", 27), installment("l3", 3, "loan", 57)];
    const loan = {
      id: "src", name: "Car loan", loanAmount: 9000, loanDate: day(-40), repaymentType: "installment", direction: "taken", interest: null,
      installmentFrequency: "monthly", installmentCount: 3, scheduleId: "sch",
    } as unknown as Loan;
    return {
      kind: "loan",
      row: { loan, installments, direction: "taken", outstandingPrincipal: 9000, totalInstallments: 3, principalPrepaid: 0 } as never,
      installment: pick ? installments.find((i) => i.id === pick) : null,
    };
  }

  it("Loan row 'Pay' on #3 with #1–#2 unpaid: says so and offers #1–#3 in order — never just #3, never silently #1", async () => {
    const user = userEvent.setup();
    renderDialog(loanThreeTarget("l3"));
    expect(screen.getByTestId("through-note").textContent).toContain("You picked installment #3");
    expect(screen.getByTestId("through-note").textContent).toContain("#1–#2 (still unpaid) are paid first");
    const through = screen.getByRole("radio", { name: /installments #1–#3/i });
    expect(through.getAttribute("aria-checked")).toBe("true");
    await pickAccount(user);
    await user.click(footer("Pay ₹9,000 to lender"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({
      amount: 9000,
      includeUpcomingInstallments: true,
      // The write must land on exactly what was shown — #1, #2, #3 and no extra principal.
      expectedAllocation: { installmentIds: ["l1", "l2", "l3"], overflow: 0 },
    });
  });

  it("Loan row 'Pay' on the oldest unpaid one is simply 'this installment' (no extra note)", () => {
    renderDialog(loanThreeTarget("l1"));
    expect(screen.queryByTestId("through-note")).toBeNull();
    expect(screen.getByRole("radio", { name: /pay this installment/i }).getAttribute("aria-checked")).toBe("true");
  });

  it("'Installment + extra payment' is its own choice: due now first, the extra reduces principal", async () => {
    const user = userEvent.setup();
    renderDialog(loanThreeTarget());
    await user.click(screen.getByTestId("other-ways-toggle"));
    await user.click(screen.getByRole("radio", { name: /installment \+ extra payment/i }));
    expect(footer(/^Pay .* to lender$/).disabled).toBe(true); // the extra is required
    await user.type(screen.getByRole("spinbutton"), "500");
    expect(screen.getByTestId("extra-total").textContent).toBe("₹3,000 due now + ₹500 extra = ₹3,500 in total");
    await pickAccount(user);
    await user.click(footer("Pay ₹3,500 to lender"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3500, includeUpcomingInstallments: false, expectedAllocation: { overflow: 500 } });
  });

  it("'All remaining installments' is labelled as the scheduled total, not a payoff", async () => {
    const user = userEvent.setup();
    const target = loanThreeTarget();
    (target.row as unknown as { loan: { interest: unknown } }).loan.interest = { ratePercent: 12, period: "yearly", type: "reducing" };
    renderDialog(target);
    await user.click(screen.getByTestId("other-ways-toggle"));
    const remaining = screen.getByRole("radio", { name: /all remaining installments/i });
    expect(remaining.textContent).toContain("includes scheduled future interest — not a bank closure amount");
    expect(screen.queryByText(/pay off remaining/i)).toBeNull();
  });

  it("a back-dated 'pay now' says it is a real debit on that date and offers Record past payments instead", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget());
    await pickAccount(user);
    expect(screen.queryByTestId("backdate-hint")).toBeNull();
    const date = screen.getByLabelText("Payment date");
    await user.clear(date);
    await user.type(date, "05/03/2024");
    const hint = screen.getByTestId("backdate-hint");
    expect(hint.textContent).toContain("This records a real payment from SBI dated 5 Mar 2024");
    await user.click(within(hint).getByRole("button", { name: /record past payments instead/i }));
    expect(screen.getByTestId("bulk-step").textContent).toContain("Choose EMIs");
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("opened from the details screen as Record past payments: no payment to go back to, list first", () => {
    render(<RecordPaymentDialog target={emiTarget()} open onOpenChange={() => {}} initialView="past" />);
    expect(screen.getByText("Record past payments")).toBeTruthy();
    // The pinned switch is the way to the other pages of the flow — there is no separate "Back to payment" link any more.
    expect(screen.queryByRole("button", { name: "Back to payment" })).toBeNull();
    expect(screen.getByRole("radio", { name: /past payment/i }).getAttribute("aria-checked")).toBe("true");
    // Nothing is preselected when the user came to record history.
    expect(screen.getByRole("checkbox", { name: "#1" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("L — an EMI paid ahead (not due yet) can still be recorded as a past payment", () => {
  it("Record past payments offers the dialog's own installment and records it through the single past form", async () => {
    const user = userEvent.setup();
    const base = emiTarget() as unknown as { kind: "emi"; row: { installments: Installment[] }; installment?: Installment };
    base.installment = base.row.installments[1]; // #2, due in 2 days
    renderDialog(base as never);
    await openPastSingle(user);
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, targetInstallmentId: "i2", recordedEarlier: { dateKnown: true }, accountId: null });
    // Not due yet → the past-payment date starts on today, never the future due date.
    expect((emiRecordPayment.mock.calls[0][2] as { date: Date }).date.toDateString()).toBe(new Date().toDateString());
  });
});
