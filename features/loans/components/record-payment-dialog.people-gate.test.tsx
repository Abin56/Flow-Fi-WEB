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
let mockTransactions: unknown[] = [];
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: mockTransactions }) }));
vi.mock("@/hooks/use-people", () => ({ usePeople: () => ({ data: [] }) }));
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
vi.mock("@/features/people/hooks/use-people-data", () => ({
  usePeopleLedgerEntries: () => ({ entriesByPersonId: { amma: [
    { id: "receipt-1", type: "receivedBack", amount: 120, obligationRef: "emi-inst:i1", date: day(0) },
    { id: "receipt-2", type: "receivedBack", amount: 50, obligationRef: "emi-inst:i1", date: day(-4) },
    { id: "receipt-3", type: "receivedBack", amount: 20, obligationRef: "emi-inst:i1", date: day(0), receivedDateKnown: false },
  ] } }),
  usePeopleAdvanceApplications: () => ({ applicationsByPersonId: {} }),
  usePeopleActions: () => null,
}));
vi.mock("@/features/month-cycle/hooks/use-global-cycle", () => ({
  useGlobalCycle: () => ({ cycleRange: { start: day(-1), end: day(1) }, label: "Selected cycle" }),
}));
vi.mock("@/features/settings/hooks/use-user-preferences", () => ({ useMonthCycleStartDay: () => 1 }));
let breakdownState: { breakdown: InstallmentBreakdown | null; isLoading: boolean } = { breakdown: null, isLoading: false };
vi.mock("@/features/loans/hooks/use-installment-breakdown", () => ({
  useInstallmentBreakdown: (target: unknown) => (target == null ? { breakdown: null, isLoading: false } : breakdownState),
}));

// Historical reimbursement: People lines (as the statement engine would give them) and the People write.
let reimbLines: ReimbursementLine[] = [];
const reimbRecord = vi.fn(async (items: readonly ReimbursementItem[], _accountId: string, previous: Record<string, ReimbursementResult> = {}): Promise<Record<string, ReimbursementResult>> => ({
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
  mockTransactions = [];
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
const panel = () => screen.queryByRole("table", { name: "Who shares this installment" });
const personRow = (id: string) => screen.getByTestId(`share-row-${id}`);
const figure = (label: string) => within(screen.getByTestId("people-summary")).getByText(label).nextElementSibling?.textContent;
/** A past payment's date is never pre-filled: the user picks it — here through the calendar's own shortcut. */
const pickPaidDate = async (user: ReturnType<typeof userEvent.setup>, shortcut: RegExp | string = /^Due /) => {
  const field = screen.getByLabelText(/^Date (paid|received)$/);
  await user.click(within(field.parentElement!).getByRole("button", { name: "Open calendar" }));
  await user.click(within(screen.getByTestId("date-calendar")).getByRole("button", { name: shortcut }));
};

const footer = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

/** "Other: Past payment · Pay several" under the Pay now form. */
const openFlow = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(within(screen.getByTestId("other-payment-flows")).getByRole("button", { name: "More" }));
  await user.click(screen.getByRole("menuitem", { name }));
};

/** Record past payments → the one installment the dialog was on → the single past-payment form (unchanged write path). */
async function openPastSingle(user: ReturnType<typeof userEvent.setup>) {
  await openFlow(user, /^Past (payment|repayment)$/);
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
  it("title, installment, what is due and the people figures", () => {
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    expect(screen.getByRole("heading", { name: "Pay EMI · Home EMI" })).toBeTruthy();
    expect(screen.getByTestId("due-summary").textContent).toContain("Installment #1 of 2");
    expect(screen.getByTestId("due-summary").textContent).toContain("₹3,000");
    expect(screen.getByText(/^Overdue · /)).toBeTruthy();
    expect(figure("People owe")).toBe("₹2,000");
    expect(within(screen.getByTestId("people-summary")).queryByText("To lender")).toBeNull();
    // My own part is shown as mine, never as money someone owes me.
    expect(personRow("me").textContent).toBe("Me₹1,000——");
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
    expect(personRow("amma").textContent).toContain("Settled");
    expect(within(personRow("amma")).queryByRole("button", { name: /^Yes, receive from/ })).toBeNull();
    expect(screen.queryByTestId("account-movement")).toBeNull(); // no account is assumed until it is chosen
    await pickAccount(user);
    expect(screen.getByTestId("account-movement").textContent).toBe("₹3,000 will be taken from SBI.");
    await user.click(footer("Pay ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, accountId: "sbi", targetInstallmentId: "i1", peopleGateAcknowledgement: null, recordedEarlier: null });
  });
});

describe("B — AMMA and JOHN haven't paid", () => {
  it("open shares never hold the lender payment back: each person has Receive and Postpone, and nothing is written yet", () => {
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    for (const [id, name] of [["amma", "AMMA"], ["john", "JOHN"]]) {
      expect(within(personRow(id)).getByRole("button", { name: `Yes, receive from ${name} for installment 1` })).toBeTruthy();
      expect(within(personRow(id)).getByRole("button", { name: new RegExp(`^No, no new receipt from ${name} for installment 1$`) })).toBeTruthy();
    }
    // The only thing the footer waits for is the paying account.
    expect(footer("Pay ₹3,000").disabled).toBe(true);
    expect([emiRecordPayment.mock.calls.length, reimbRecord.mock.calls.length, deferralApply.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it("paying with shares open pays the lender once with the 'not paid yet' acknowledgement; their shares stay owed, and no People entry is written", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    await pickAccount(user);
    expect(screen.getByTestId("account-movement").textContent).toBe("₹3,000 will be taken from SBI.");
    expect(screen.getByText(/People receipts save separately/)).toBeTruthy();
    const pay = footer("Pay ₹3,000");
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

  it("paying the lender never records anyone's money, even when their shares could be settled", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: BOTH_PENDING(), isLoading: false };
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    reimbLines = [
      { personId: "amma", personName: "AMMA", installmentId: "i1", sequenceNumber: 1, dueDate: day(-1), obligationKey: "emi-inst:i1", share: 1000, received: 0, remaining: 1000 },
      { personId: "john", personName: "JOHN", installmentId: "i1", sequenceNumber: 1, dueDate: day(-1), obligationKey: "emi-inst:i1", share: 1000, received: 0, remaining: 1000 },
    ];
    renderDialog(emiTarget());
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(reimbRecord).not.toHaveBeenCalled();
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, accountId: "sbi", recordedEarlier: null });
  });

  it("Loan: paying with a share open forwards the acknowledgement", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 0, "loan-inst:l1")]), isLoading: false };
    renderDialog(loanTarget());
    expect(screen.getByRole("heading", { name: /^Pay installment ·/ })).toBeTruthy();
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000"));
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
    const row = within(personRow("john"));
    expect(row.getByText("₹1,000")).toBeTruthy();
    expect(row.getByText("₹600")).toBeTruthy();
    expect(row.getByText("₹400")).toBeTruthy();
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
    expect(screen.getByTestId("share-line-emi-inst:i1").textContent).toBe("₹1,000Postponed to Nov 2099");
    expect(screen.getByTestId("earlier-toggle-john").textContent).toBe("₹1,000 earlier unpaid (1) · 1 postponed");
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
    await pickPaidDate(user);
    expect(screen.getByTestId("past-payment-effect").textContent).toContain("No account balance changes");
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

  it("the paid date starts empty (never the due date), blocks saving, and a typed date survives other edits", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget());
    await openPastSingle(user);
    const field = () => screen.getByLabelText("Date paid") as HTMLInputElement;
    expect(field().value).toBe("");
    expect(within(screen.getByTestId("sheet-header")).getByText(/^(Overdue ·|Due) /)).toBeTruthy();
    expect(footer("Save past payment of ₹3,000").disabled).toBe(true);
    await user.type(field(), "05/03/2024");
    await user.click(screen.getByRole("button", { name: "Back to payment" }));
    await openPastSingle(user);
    expect(field().value).toBe("05/03/2024");
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ date: new Date(2024, 2, 5, 12), recordedEarlier: { dateKnown: true } });
  });

  it("calendar: opens on the due month, month and year jump directly, browsing never changes the date", async () => {
    const user = userEvent.setup();
    const target = emiTarget();
    renderDialog(target);
    await openPastSingle(user);
    const field = screen.getByLabelText("Date paid") as HTMLInputElement;
    await user.click(within(field.parentElement!).getByRole("button", { name: "Open calendar" }));
    const calendar = within(screen.getByTestId("date-calendar"));
    const due = dueOf(target);
    const month = () => (calendar.getByRole("combobox", { name: "Month" }) as HTMLSelectElement).value;
    const year = () => (calendar.getByRole("combobox", { name: "Year" }) as HTMLSelectElement).value;
    expect([month(), year()]).toEqual([String(due.getMonth()), String(due.getFullYear())]);
    await user.selectOptions(calendar.getByRole("combobox", { name: "Year" }), String(due.getFullYear() - 2));
    await user.selectOptions(calendar.getByRole("combobox", { name: "Month" }), "4");
    expect(field.value).toBe("");
    await user.click(calendar.getByRole("button", { name: `15 May ${due.getFullYear() - 2}` }));
    expect(screen.queryByTestId("date-calendar")).toBeNull();
    expect(field.value).toBe(`15/05/${due.getFullYear() - 2}`);
    expect(emiRecordPayment).not.toHaveBeenCalled();
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

  it("Loan: the account is for the record only; Back to payment goes back", async () => {
    const user = userEvent.setup();
    renderDialog(loanTarget());
    await openPastSingle(user);
    expect(screen.getByText("Paid from · for your records")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to payment" }));
    expect(footer("Pay ₹3,000")).toBeTruthy();
    await openPastSingle(user);
    await pickPaidDate(user);
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
    await pickPaidDate(user);
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(footer("Back to payment").disabled).toBe(true);
  });
});

describe("F / G — every amount is visible and named", () => {
  it("F: a part payment — the scheduled amount is stated once; a typed one is one tap away and the footer follows", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget());
    expect(screen.getByTestId("due-summary").textContent).toContain("₹3,000");
    expect(screen.queryByTestId("amount-card")).toBeNull();
    await user.click(screen.getByTestId("change-amount"));
    await user.type(within(screen.getByTestId("amount-card")).getByRole("spinbutton"), "1000");
    await pickAccount(user);
    await user.click(footer("Pay ₹1,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 1000, targetInstallmentId: "i1" });
  });

  it("G: pay all remaining — by typing the total; the footer names it before anything is paid", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget());
    await user.click(screen.getByTestId("change-amount"));
    await user.type(within(screen.getByTestId("amount-card")).getByRole("spinbutton"), "6000");
    await pickAccount(user);
    // Everything in one go: nothing can be paid until it is confirmed.
    expect(footer("Pay ₹6,000").disabled).toBe(true);
    await user.click(footer("Pay ₹6,000"));
    expect(emiRecordPayment).not.toHaveBeenCalled();
    await user.click(within(screen.getByTestId("remaining-warning")).getByRole("checkbox"));
    expect(screen.queryByTestId("closure-warning")).toBeNull(); // interest-free
    await user.click(footer("Pay ₹6,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 6000 });
  });
});

describe("H — many people (small screens)", () => {
  it("keeps No local, previews the target cycle, and postpones only after confirmation", async () => {
    const user = userEvent.setup();
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(emiTarget());
    const row = within(personRow("amma"));
    expect(row.getByText("₹120 this cycle")).toBeTruthy();
    await user.click(row.getByRole("button", { name: /^No, no new receipt/ }));
    expect(row.getByText("₹0 received for this answer")).toBeTruthy();
    await user.click(row.getByRole("button", { name: "Keep pending" }));
    expect(row.getByText("Kept pending")).toBeTruthy();
    expect(reimbRecord).not.toHaveBeenCalled();
    expect(deferralApply).not.toHaveBeenCalled();
    await user.click(row.getByRole("button", { name: /^No, no new receipt/ }));
    await user.click(row.getByRole("button", { name: /^Postpone AMMA/ }));
    expect(deferralApply).not.toHaveBeenCalled();
    await user.click(row.getByRole("button", { name: "Confirm postponement" }));
    await waitFor(() => expect(deferralApply).toHaveBeenCalledTimes(1));
    expect(deferralApply.mock.calls[0][0]).toMatchObject({ personId: "amma", remaining: 1000, targetDate: null });
    expect(reimbRecord).not.toHaveBeenCalled();
  });

  it("opens a blank receipt, checks the cap, and retries a failed partial receipt separately", async () => {
    const user = userEvent.setup();
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    reimbLines = [{ personId: "amma", personName: "AMMA", installmentId: "i1", sequenceNumber: 1, obligationKey: "emi-inst:i1", dueDate: day(-3), share: 1000, received: 0, remaining: 1000 }];
    let finishAttempt: () => void = () => {};
    const attempt = new Promise<void>((resolve) => { finishAttempt = resolve; });
    reimbRecord.mockImplementationOnce(async (items) => {
      await attempt;
      return Object.fromEntries(items.map((item) => [item.key, { status: "failed" as const, error: "Receipt write failed" }]));
    });
    renderDialog(emiTarget());
    const row = within(personRow("amma"));
    const originalRows = within(panel()!).getAllByRole("row").length;
    await user.click(row.getByRole("button", { name: /^Yes, receive from/ }));
    const amount = row.getByRole("spinbutton", { name: "Amount received from AMMA" }) as HTMLInputElement;
    expect(within(panel()!).getAllByRole("row")).toHaveLength(originalRows);
    expect(screen.queryByTestId("they-paid-panel")).toBeNull();
    expect(amount.value).toBe("");
    await user.type(amount, "1100");
    await user.click(row.getByRole("button", { name: "Receipt details for AMMA" }));
    const receipt = within(screen.getByTestId("they-paid-panel"));
    await user.click(receipt.getByRole("radio", { name: "Add to my account" }));
    await user.selectOptions(receipt.getByLabelText("Received into account"), "sbi");
    expect((receipt.getByRole("button", { name: "Record Received" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    await user.clear(amount);
    await user.type(amount, "400");
    expect(row.getByText("After receipt ₹600")).toBeTruthy();
    await user.type(amount, "{Enter}", { skipClick: true });
    expect(emiRecordPayment).not.toHaveBeenCalled();
    await user.click(row.getByRole("button", { name: "Receipt details for AMMA" }));
    const activeReceipt = within(screen.getByTestId("they-paid-panel"));
    await user.click(activeReceipt.getByRole("button", { name: "Record Received" }));
    expect(screen.getAllByRole<HTMLButtonElement>("button", { name: /^Cancel$/ }).every((button) => button.disabled)).toBe(true);
    finishAttempt();
    await user.click(await activeReceipt.findByRole("button", { name: "Retry what didn't save" }));
    await activeReceipt.findByText("Receipt saved into SBI");
    expect(reimbRecord.mock.calls[0][0][0]).toMatchObject({ amount: 400, recordedEarlier: false });
    expect(reimbRecord.mock.calls[1][0][0].key).toBe(reimbRecord.mock.calls[0][0][0].key);
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("one compact row per person with a Yes or No answer", () => {
    const names = ["AMMA", "JOHN", "RAVI", "SANJU"];
    peopleState = { readiness: readinessOf(names.map((n) => person(n.toLowerCase(), n, 500, 0, "emi-inst:i1"))), isLoading: false };
    breakdownState = { breakdown: breakdownOf(names.map((n) => ({ id: n.toLowerCase(), name: n, current: line("emi-inst:i1", 1, 500, 0) }))), isLoading: false };
    renderDialog(emiTarget());
    expect(names.map((n) => personRow(n.toLowerCase()).querySelector("th")!.textContent)).toEqual(names);
    expect(screen.getAllByRole("button", { name: /^Yes, receive from / })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /^No, no new receipt from / })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /^Pay ₹3,000$/ })).toHaveLength(1);
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
    await user.click(footer("Pay ₹3,000"));
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
    expect(screen.getByRole("heading", { name: /^Record repayment ·/ })).toBeTruthy();
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
    await openFlow(user, /^Past (payment|repayment)$/);
    expect(screen.getByTestId("bulk-step").textContent).toBe("Choose EMIs · Step 1 of 3");
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
    await openFlow(user, /^(Pay|Receive) several$/);
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
    await openFlow(user, /^(Pay|Receive) several$/);
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
    await openFlow(user, /^(Pay|Receive) several$/);
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Review 2 EMIs · ₹6,000"));
    expect(screen.queryByRole("combobox", { name: /paid from account/i })).toBeNull();
    expect(screen.getByTestId("bulk-balance-preview").textContent).toContain("no bank account is debited");
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
    await openFlow(user, /^Past (payment|repayment)$/);
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Continue with 2 EMIs"));
    await user.click(screen.getByRole("radio", { name: /i don't know the dates/i }));
    await user.click(footer("Continue to people's shares"));
    expect(screen.getByTestId("bulk-step").textContent).toBe("People's shares · Step 3 of 4");
    // SANJU paid both; AMMA only #3, and only part of it.
    const sanjuRow = screen.getByTestId("reconcile-person-sanju");
    await user.click(within(sanjuRow).getByRole("button", { name: "All received" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "AMMA #3" })).getByRole("radio", { name: "Received some" }));
    await user.type(screen.getByRole("spinbutton", { name: /amount received from amma/i }), "250");
    // Mixed in one batch: everything already in the account except AMMA's #3, which is added now.
    await user.click(screen.getByRole("button", { name: "Already in my account" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Where is AMMA #3's money" })).getByRole("radio", { name: "Add to my account" }));
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("Account credit +₹250");
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
    await openFlow(user, /^Past (payment|repayment)$/);
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
    // Due date deliberately different from the lender payment's date (the date picked here is #1's due date).
    personId, personName, installmentId: "i1", sequenceNumber: 1, dueDate: day(-40), obligationKey: "emi-inst:i1", share: 1000, received, remaining: 1000 - received,
  });
  const choose = async (user: ReturnType<typeof userEvent.setup>, who: string, option: string) =>
    user.click(within(screen.getByRole("radiogroup", { name: who })).getByRole("radio", { name: option }));

  it("nothing is assumed received; a received share asks no balance question (a past payment never moves an account); lender first, then the People settlement", async () => {
    const user = userEvent.setup();
    reimbLines = [share("amma", "AMMA"), share("sanju", "SANJU")];
    renderDialog(emiTarget());
    await openPastSingle(user);
    await pickPaidDate(user);
    expect(screen.getByRole("heading", { name: "People contributions" })).toBeTruthy();
    expect(screen.queryByText(/already included in your flowfi account balance/i)).toBeNull();
    expect(footer("Save past payment of ₹3,000")).toBeTruthy();

    await choose(user, "SANJU", "Received in full");
    // Past payment: the lender was paid earlier, so there is no "where is the money" question — it is already in the balance.
    expect(screen.queryByRole("radiogroup", { name: "Where is SANJU's money" })).toBeNull();
    const save = footer("Save past payment of ₹3,000");
    expect(save.disabled).toBe(true); // the account the record is filed under is chosen, never assumed
    // The date already given for the lender payment is the starting point — not asked again from today's calendar.
    expect(screen.queryByText("Date will be saved as unknown.")).toBeNull();
    expect((screen.getByLabelText("Date received from SANJU") as HTMLInputElement).value).not.toBe("");
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("AMMA₹1,000 pending after saving");
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("SANJUFully received");
    expect(screen.getByTestId("past-payment-effect").textContent).toContain("No account balance changes");
    expect(footer("Save past payment of ₹3,000").disabled).toBe(true); // no account is assumed
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000"));
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
    await pickPaidDate(user);
    await choose(user, "SANJU", "Received in full");
    await user.clear(screen.getByLabelText("Date received from SANJU"));
    expect(screen.getByText("Date will be saved as unknown.")).toBeTruthy();
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    const item = reimbRecord.mock.calls[0][0][0];
    expect(item).toMatchObject({ dateKnown: false });
    expect(item.date.toDateString()).toBe(day(-40).toDateString());
  });

  it("received some: recorded for exactly that amount as money already in the balance — a past payment never adds money to an account", async () => {
    const user = userEvent.setup();
    reimbLines = [share("amma", "AMMA")];
    renderDialog(emiTarget());
    await openPastSingle(user);
    await pickPaidDate(user);
    await choose(user, "AMMA", "Received some");
    await user.type(screen.getByRole("spinbutton", { name: /amount received from amma/i }), "400");
    await user.clear(screen.getByLabelText("Date received from AMMA"));
    await user.type(screen.getByLabelText("Date received from AMMA"), "05/09/2026");
    expect(screen.queryByRole("radiogroup", { name: "Where is AMMA's money" })).toBeNull();
    expect(screen.getByTestId("reconcile-summary").textContent).toContain("AMMA₹600 pending after saving");
    expect(screen.getByTestId("reconcile-summary").textContent).not.toContain("Account credit");
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(reimbRecord.mock.calls[0][0][0]).toMatchObject({ amount: 400, recordedEarlier: true, dateKnown: true });
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
    await pickPaidDate(user);
    await choose(user, "AMMA", "Received in full");
    await choose(user, "SANJU", "Received in full");
    await pickAccount(user, "Received into account");
    await user.click(footer("Save past payment of ₹3,000"));
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
    expect(footer("Pay ₹3,000").disabled).toBe(true); // account not chosen yet
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
    await user.click(footer("Pay ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, accountId: "sbi", enforceFunds: true });
  });

  it("insufficient funds: names the shortfall and disables the payment — nothing is sent", async () => {
    const user = userEvent.setup();
    mockSbiBalance = 2500;
    renderDialog(emiTarget());
    await pickAccount(user);
    expect(screen.getByTestId("payment-source-insufficient").textContent).toContain("short by ₹500");
    expect(footer("Pay ₹3,000").disabled).toBe(true);
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("a Loan payment also re-checks funds in the write", async () => {
    const user = userEvent.setup();
    renderDialog(loanTarget());
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({ accountId: "sbi", enforceFunds: true, recordedEarlier: null });
  });

  it("'already paid earlier' never checks or deducts funds, even on an empty account", async () => {
    const user = userEvent.setup();
    mockSbiBalance = 0;
    renderDialog(loanTarget());
    await openPastSingle(user);
    await pickPaidDate(user);
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
    await user.click(footer("Pay ₹3,000"));
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
    expect(screen.getByTestId("due-summary").textContent).toContain("Installments #1–#3");
    expect(screen.getByTestId("due-summary").textContent).toContain("3 installments, paid in order");
    await pickAccount(user);
    expect(footer("Pay ₹9,000").disabled).toBe(true); // #1–#3 is every installment left
    await user.click(within(screen.getByTestId("remaining-warning")).getByRole("checkbox"));
    await user.click(footer("Pay ₹9,000"));
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
    expect(screen.getByTestId("due-summary").textContent).toContain("Installment #1");
    expect(screen.getByTestId("due-summary").textContent).not.toContain("Installments #");
  });

  it("a Loan amount above what is due says where the extra goes: principal by default, due now paid first", async () => {
    const user = userEvent.setup();
    renderDialog(loanThreeTarget());
    await user.click(screen.getByTestId("change-amount"));
    await user.type(within(screen.getByTestId("amount-card")).getByRole("spinbutton"), "3500");
    const extra = screen.getByRole("radiogroup", { name: "Apply the extra amount to" });
    expect(within(extra).getByRole("radio", { name: "Lower the loan balance" }).getAttribute("aria-checked")).toBe("true");
    await pickAccount(user);
    await user.click(footer("Pay ₹3,500"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3500, includeUpcomingInstallments: false, expectedAllocation: { overflow: 500 } });
  });

  it("'I pay' offers no one-tap 'pay everything', and never calls a scheduled total a payoff", () => {
    const target = loanThreeTarget();
    (target.row as unknown as { loan: { interest: unknown } }).loan.interest = { ratePercent: 12, period: "yearly", type: "reducing" };
    renderDialog(target);
    expect(screen.queryByRole("radio", { name: /all remaining installments/i })).toBeNull();
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

  it("opened from the details screen as Record past payments: list first with a way back to payment", () => {
    render(<RecordPaymentDialog target={emiTarget()} open onOpenChange={() => {}} initialView="past" />);
    expect(screen.getByText("Record past payments")).toBeTruthy();
    expect(footer("Back to payment").disabled).toBe(false);
    // Nothing is preselected when the user came to record history.
    expect(screen.getByRole("checkbox", { name: "#1" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("safeguards for paying everything off", () => {
  const guard = () => screen.queryByTestId("remaining-warning");
  const closure = () => screen.queryByTestId("closure-warning");
  const type = async (user: ReturnType<typeof userEvent.setup>, amount: string) => {
    if (!screen.queryByTestId("amount-card")) await user.click(screen.getByTestId("change-amount"));
    const field = within(screen.getByTestId("amount-card")).getByRole("spinbutton");
    await user.clear(field);
    await user.type(field, amount);
  };
  /** 3 × ₹3,000: #1 overdue, #2 and #3 later. `interest`: each installment is ₹2,700 principal + ₹300 interest. */
  function threeLoan(interest: boolean): PaymentTarget {
    const installments = [installment("l1", 1, "loan", -3), installment("l2", 2, "loan", 27), installment("l3", 3, "loan", 57)].map((i) => (interest ? { ...i, principalPortion: 2700, interestPortion: 300 } : i));
    const loan = {
      id: "src", name: "Car loan", loanAmount: interest ? 8100 : 9000, loanDate: day(-40), repaymentType: "installment", direction: "taken",
      interest: interest ? { ratePercent: 12, period: "yearly", type: "reducing" } : null, installmentFrequency: "monthly", installmentCount: 3, scheduleId: "sch",
    } as unknown as Loan;
    return { kind: "loan", row: { loan, installments, direction: "taken", outstandingPrincipal: interest ? 8100 : 9000, totalInstallments: 3, principalPrepaid: 0 } as never };
  }

  it("the scheduled payment and an ordinary part payment show neither, even with interest", async () => {
    const user = userEvent.setup();
    renderDialog(threeLoan(true));
    expect([guard(), closure()]).toEqual([null, null]);
    await type(user, "1000");
    expect([guard(), closure()]).toEqual([null, null]);
    await user.click(screen.getByTestId("change-amount"));
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000"));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, includeUpcomingInstallments: false });
  });

  it("the whole scheduled total asks first, warns it isn't a closure quote, and asks again if the amount changes", async () => {
    const user = userEvent.setup();
    renderDialog(threeLoan(true));
    await type(user, "9000");
    await pickAccount(user);
    expect(closure()!.textContent).toContain("A foreclosure or closure quote may be different");
    expect(closure()!.textContent).toContain("doesn't close the loan with your lender");
    const pay = () => screen.getByRole("button", { name: /^Pay ₹/ }) as HTMLButtonElement;
    expect(pay().disabled).toBe(true);
    await user.click(pay());
    expect(loanRecordPayment).not.toHaveBeenCalled();
    await user.click(within(guard()!).getByRole("checkbox"));
    expect(pay().disabled).toBe(false);
    await type(user, "9100");
    expect(within(guard()!).getByRole("checkbox")).toHaveProperty("checked", false);
    expect(pay().disabled).toBe(true);
  });

  it("an extra that clears all the principal asks first even though it is below the scheduled total", async () => {
    const user = userEvent.setup();
    renderDialog(threeLoan(true));
    await type(user, "8700");
    await pickAccount(user);
    expect(guard()!.textContent).toContain("pays off the whole loan balance");
    expect(closure()!.textContent).toContain("clears the principal recorded in FlowFi");
    expect((screen.getByRole("button", { name: /^Pay ₹/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(loanRecordPayment).not.toHaveBeenCalled();
  });

  it("the last unpaid installment on its own is an ordinary payment", async () => {
    const user = userEvent.setup();
    const target = threeLoan(true);
    const rows = (target.row as unknown as { installments: Installment[] }).installments;
    rows[0].amountPaid = 3000;
    rows[1].amountPaid = 3000;
    renderDialog(target);
    await pickAccount(user);
    expect([guard(), closure()]).toEqual([null, null]);
    expect(footer("Pay ₹3,000").disabled).toBe(false);
  });
});

describe("card EMI wording, and the unsupported direct issuer payment", () => {
  function cardTarget(purchaseTransactionId: string | null): PaymentTarget {
    const installments = [installment("i1", 1, "emi"), installment("i2", 2, "emi")];
    return { kind: "emi", row: { emi: { id: "src", name: "Phone EMI", installmentCount: 2, linkedCreditCardId: "c1", purchaseTransactionId }, linkedCard: { accountId: "cardacc" }, installments, nextInstallment: installments[0], remainingBalance: 6000 } as never };
  }

  it("records a card EMI (not a lender payment, not the card bill) and offers the issuer option where it can be recorded", async () => {
    const user = userEvent.setup();
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(cardTarget(null));
    expect(footer("Pay ₹3,000 card EMI from bank").disabled).toBe(true);
    expect(screen.getByLabelText("Paid from account")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: /pays card issuer$/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pay card bill" }).getAttribute("href")).toBe("/credit-cards?card=c1&pay=1");
    expect(screen.getByRole("heading", { name: "Pay EMI · Phone EMI" })).toBeTruthy();
    expect(screen.queryByText("To lender")).toBeNull();
    expect(screen.queryByTestId("issuer-unsupported")).toBeNull();
  });

  it("with the purchase already in the card balance, no direct issuer option is offered and the reason is shown", async () => {
    const user = userEvent.setup();
    mockTransactions = [{ id: "buy", accountId: "cardacc", deletedAt: null, excludeFromCalculations: false, transferId: null, type: "expense", amount: 6000, dateTime: new Date() }];
    breakdownState = { breakdown: BOTH_PENDING_BREAKDOWN(), isLoading: false };
    renderDialog(cardTarget("buy"));
    expect(footer("Record ₹3,000 card EMI")).toBeTruthy();
    expect(screen.queryByLabelText("Paid from account")).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: /pays card issuer$/ })).toBeNull();
    expect(screen.getByTestId("issuer-unsupported").textContent).toContain("already in your card balance");
    expect(screen.getByRole("button", { name: "Yes, receive from AMMA for installment 1" })).toBeTruthy();
  });

  it.each(["pay", "payMany"] as const)("routes a card-financed loan with a posted purchase to the issuer bill in %s", (initialView) => {
    const base = loanTarget();
    if (base.kind !== "loan") throw new Error("Expected a loan");
    mockTransactions = [{ id: "buy", accountId: "cardacc", deletedAt: null, excludeFromCalculations: false, transferId: null, type: "expense", amount: 6000, dateTime: new Date() }];
    const target = { ...base, row: { ...base.row, loan: { ...base.row.loan, fundingSource: "creditCard" as const, linkedCreditCardId: "c1", purchaseTransactionId: "buy" } } };
    render(<RecordPaymentDialog target={target} open onOpenChange={() => {}} initialView={initialView} />);
    expect(screen.getByRole("link", { name: "Pay card bill" }).getAttribute("href")).toBe("/credit-cards?card=c1&pay=1");
    expect(screen.queryByLabelText("Paid from account")).toBeNull();
    expect(loanRecordPayment).not.toHaveBeenCalled();
  });
});

describe("L — an EMI paid ahead (not due yet) can still be recorded as a past payment", () => {
  it("Record past payments offers the dialog's own installment and records it through the single past form", async () => {
    const user = userEvent.setup();
    const base = emiTarget() as unknown as { kind: "emi"; row: { installments: Installment[] }; installment?: Installment };
    base.installment = base.row.installments[1]; // #2, due in 2 days
    renderDialog(base as never);
    await openPastSingle(user);
    // Nothing is assumed, and a due date that hasn't arrived can't be picked as the paid date.
    expect((screen.getByLabelText("Date paid") as HTMLInputElement).value).toBe("");
    expect(footer("Save past payment of ₹3,000").disabled).toBe(true);
    await pickPaidDate(user, "Today");
    await user.click(footer("Save past payment of ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, targetInstallmentId: "i2", recordedEarlier: { dateKnown: true }, accountId: null });
    // The date the user picked is the date written.
    expect((emiRecordPayment.mock.calls[0][2] as { date: Date }).date.toDateString()).toBe(new Date().toDateString());
  });
});

describe("M — who is paying the lender", () => {
  it("loan detail guides the user from share status to a direct payment without debiting the selected account", async () => {
    const user = userEvent.setup();
    const obligationKey = "loan-inst:l1";
    peopleState = { readiness: readinessOf([person("abin", "ABIN", 1000, 0, obligationKey)]), isLoading: false };
    breakdownState = { breakdown: breakdownOf([{ id: "abin", name: "ABIN", current: line(obligationKey, 1, 1000, 0) }]), isLoading: false };
    reimbLines = [{ personId: "abin", personName: "ABIN", installmentId: "l1", sequenceNumber: 1, dueDate: day(-3), obligationKey, share: 1000, received: 0, remaining: 1000 }];
    render(<RecordPaymentDialog target={loanTarget()} open onOpenChange={() => {}} loanDetail />);

    expect(screen.getByTestId("pay-card")).toBeTruthy();
    expect(within(personRow("abin")).getByRole("button", { name: "Yes, receive from ABIN for installment 1" })).toBeTruthy();

    await openFlow(user, /^ABIN pays lender$/);
    await pickPaidDate(user);
    expect(footer("Back to payment").disabled).toBe(false);
    await user.click(within(screen.getByRole("radiogroup", { name: "ABIN" })).getByRole("radio", { name: "Full share" }));
    // A payment to the lender can never add money to my account, so there is no such choice to make.
    expect(screen.queryByRole("radio", { name: /Add to my account/ })).toBeNull();
    const save = footer("Record direct payment · ₹3,000");
    expect(save.disabled).toBe(true);
    await pickAccount(user, "Account for this record");
    await user.click(save);

    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(loanRecordPayment).toHaveBeenCalledTimes(1);
    expect(loanRecordPayment.mock.calls[0][2]).toMatchObject({ accountId: "sbi", recordedEarlier: { dateKnown: true }, enforceFunds: false });
    expect(reimbRecord.mock.calls[0][0][0]).toMatchObject({ obligationKey, amount: 1000, recordedEarlier: true });
  });

  function pastEmiTarget(): PaymentTarget {
    const installments = [installment("i1", 1, "emi", -90), { ...installment("i2", 2, "emi", -60), amountPaid: 3000 }, installment("i3", 3, "emi", -30), installment("i4", 4, "emi", 20)];
    return { kind: "emi", row: { emi: { id: "src", name: "Home EMI", installmentCount: 4 }, installments, nextInstallment: installments[0], remainingBalance: 9000 } as never };
  }
  it("'<person> paid directly': recorded as already paid — no account, the payer named in the note, the payment dialog says so", async () => {
    const user = userEvent.setup();
    breakdownState = { breakdown: breakdownOf([{ id: "sanju", name: "SANJU", current: line("emi-inst:i1", 1, 1000, 0) }]), isLoading: false };
    reimbLines = [];
    renderDialog(emiTarget());
    await openFlow(user, /^SANJU pays lender$/);
    await pickPaidDate(user);
    expect(screen.getByTestId("payer-hint").textContent).toContain("No account debit, no card charge.");
    expect(screen.getByRole("heading", { name: "Record direct payment" })).toBeTruthy();
    await user.click(footer("Record direct payment · ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    const call = emiRecordPayment.mock.calls[0][2] as { accountId: unknown; recordedEarlier: unknown; note: string; enforceFunds: boolean };
    expect(call.accountId).toBeNull();
    expect(call.recordedEarlier).toMatchObject({ dateKnown: true });
    expect(call.note).toContain("Paid directly by SANJU");
    expect(call.enforceFunds).toBe(false);
  });

  it("'I'm paying' is the default and stays a normal account payment; switching back after choosing the other payer restores it", async () => {
    const user = userEvent.setup();
    breakdownState = { breakdown: breakdownOf([{ id: "sanju", name: "SANJU", current: line("emi-inst:i1", 1, 1000, 1000) }]), isLoading: false };
    renderDialog(emiTarget());
    expect(screen.queryByRole("radio", { name: "I pay" })).toBeNull();
    await openFlow(user, /^SANJU pays lender$/);
    expect(screen.getByRole("heading", { name: "Record direct payment" })).toBeTruthy();
    await user.click(footer("Back to payment"));
    await pickAccount(user);
    await user.click(footer("Pay ₹3,000"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ accountId: "sbi", recordedEarlier: null, enforceFunds: true });
  });

  it("Pay several: each installment has its own payer — mine debit the account once, the other is recorded as paid with no account", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockImplementation(async () => ({ alreadyRecorded: false, applied: 0, allocationType: "regularEmi" }));
    renderDialog(pastEmiTarget());
    await openFlow(user, /^(Pay|Receive) several$/);
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Review 2 EMIs · ₹6,000"));
    await user.click(within(screen.getByRole("radiogroup", { name: "Who paid #3" })).getByRole("radio", { name: "Person paid lender" }));
    await pickAccount(user);
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹7,000"); // only the ₹3,000 I pay leaves SBI
    await user.click(footer("Record 2 EMIs · ₹3,000 from my account"));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(2));
    const [mine, other] = emiRecordPayment.mock.calls.map((c) => c[2] as Record<string, unknown>);
    expect(mine).toMatchObject({ targetInstallmentId: "i1", accountId: "sbi", enforceFunds: true, recordedEarlier: null });
    expect(other).toMatchObject({ targetInstallmentId: "i3", accountId: null, enforceFunds: false, recordedEarlier: { dateKnown: true } });
    expect(other.note).toContain("Paid directly by someone else");
    expect(mine.idempotencyKey).not.toBe(other.idempotencyKey);
  });

  function cardEmiTarget(): PaymentTarget {
    const base = pastEmiTarget().row as unknown as { installments: Installment[] };
    return { kind: "emi", row: { emi: { id: "src", name: "Phone EMI", installmentCount: 4, linkedCreditCardId: "c1", purchaseTransactionId: null }, linkedCard: { accountId: "cardacc" }, installments: base.installments, nextInstallment: base.installments[0], remainingBalance: 9000 } as never };
  }
  async function reviewCardSeveral(user: ReturnType<typeof userEvent.setup>) {
    renderDialog(cardEmiTarget());
    await openFlow(user, /^(Pay|Receive) several$/);
    expect(screen.getByTestId("bulk-source-note").textContent).toContain("no bank account is debited");
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Review 2 EMIs · ₹6,000"));
  }

  it("Pay several, card EMI: the wording names a card charge, never an account balance going down", async () => {
    const user = userEvent.setup();
    await reviewCardSeveral(user);
    expect(screen.getByTestId("bulk-card-effect").textContent).toMatch(/Charged to the linked card · ₹6,000(\.00)?\. No bank account is debited\./);
    expect(screen.queryByLabelText("Paid from account")).toBeNull();
  });

  const share = (name: string, installmentId = "i1") => ({ personId: name, personName: name, installmentId, sequenceNumber: Number(installmentId.slice(1)), dueDate: day(-90), obligationKey: `emi-inst:${installmentId}`, share: 1000, received: 0, remaining: 1000 });
  async function directSeveral(user: ReturnType<typeof userEvent.setup>) {
    await openFlow(user, /^(Pay|Receive) several$/);
    await user.click(screen.getByRole("button", { name: /select all unpaid \(2\)/i }));
    await user.click(footer("Review 2 EMIs · ₹6,000"));
    await user.click(within(screen.getByRole("radiogroup", { name: "Who paid #1" })).getByRole("radio", { name: /^Person paid (lender|card issuer)$/ }));
  }
  const confirm = () => footer(/^Record 2 EMIs/);
  const pickPayer = (user: ReturnType<typeof userEvent.setup>, person: string, option: RegExp) =>
    user.click(within(screen.getByRole("radiogroup", { name: `${person} #1` })).getByRole("radio", { name: new RegExp(option.source.replace("^Full share$", "Cover full share").replace("^Part$", "Cover part")) }));

  it("Pay several, two sharers: nobody is preselected, Confirm waits, and only the named payer is settled", async () => {
    const user = userEvent.setup();
    reimbLines = [share("AMMA"), share("JOHN")];
    renderDialog(pastEmiTarget());
    await directSeveral(user);
    await pickAccount(user);
    expect(screen.getByTestId("bulk-direct-blocker").textContent).toContain("Choose who paid #1");
    expect(confirm().disabled).toBe(true);
    expect(screen.queryByRole("radio", { name: /Add to my account/ })).toBeNull();
    await pickPayer(user, "AMMA", /^Full share$/);
    await user.click(confirm());
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(reimbRecord.mock.calls[0][0]).toMatchObject([{ personId: "AMMA", amount: 1000, recordedEarlier: true }]);
    expect(reimbRecord.mock.calls[0][0]).toHaveLength(1);
  });

  it("Pay several, two payers with different portions: typed amounts are saved; covering more than the lender payment is refused", async () => {
    const user = userEvent.setup();
    reimbLines = [share("AMMA"), share("JOHN")];
    renderDialog(pastEmiTarget());
    await directSeveral(user);
    await pickAccount(user);
    await pickPayer(user, "AMMA", /^Full share$/);
    await pickPayer(user, "JOHN", /^Part$/);
    expect(confirm().disabled).toBe(true);
    await user.type(screen.getByLabelText("Amount covered for JOHN"), "400");
    expect(confirm().disabled).toBe(false);
    await user.type(screen.getByLabelText("Amount for #1"), "1200");
    expect(screen.getByTestId("bulk-direct-blocker").textContent).toContain("cover more than");
    expect(confirm().disabled).toBe(true);
    await user.clear(screen.getByLabelText("Amount for #1"));
    await user.click(confirm());
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(reimbRecord.mock.calls[0][0].map((i) => [i.personId, i.amount])).toEqual([["AMMA", 1000], ["JOHN", 400]]);
  });

  it("Pay several, shared card EMI paid by a person: payer and People record account come first; then no account or card is charged for it", async () => {
    const user = userEvent.setup();
    reimbLines = [share("AMMA"), share("JOHN")];
    renderDialog(cardEmiTarget());
    await directSeveral(user);
    expect(screen.getByTestId("bulk-direct-blocker").textContent).toContain("Choose who paid #1");
    await pickPayer(user, "AMMA", /^Full share$/);
    expect(screen.getByTestId("bulk-direct-blocker").textContent).toContain("Choose the account for the People record");
    expect(confirm().disabled).toBe(true);
    await user.click(confirm());
    expect(emiRecordPayment).not.toHaveBeenCalled();
    expect(reimbRecord).not.toHaveBeenCalled();
    await pickAccount(user, "Account for the People record");
    await user.click(confirm());
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    const [direct, mine] = emiRecordPayment.mock.calls.map((c) => c[2] as { accountId: unknown; recordedEarlier: unknown; note?: string });
    expect(direct.accountId).toBeNull();
    expect(direct.recordedEarlier).not.toBeNull(); // posts no card or bank transaction
    expect(direct.note).toContain("Paid directly by AMMA");
    expect(direct.note).not.toContain("JOHN");
    expect(mine.recordedEarlier).toBeNull(); // the one I pay is still billed to the card
    expect(reimbRecord.mock.calls[0][0].map((i) => [i.personId, i.amount, i.recordedEarlier])).toEqual([["AMMA", 1000, true]]);
    expect(reimbRecord.mock.calls[0][1]).toBe("sbi");
  });

  it("Pay several, People write fails: says partly saved, and retry re-sends only People with the same key", async () => {
    const user = userEvent.setup();
    emiRecordPayment.mockImplementation(async () => ({ alreadyRecorded: false, applied: 0, allocationType: "regularEmi" }));
    reimbLines = [share("AMMA")];
    reimbRecord.mockImplementationOnce(async (items) => Object.fromEntries(items.map((i) => [i.key, { status: "failed" as const, error: "network" }])) as never);
    renderDialog(pastEmiTarget());
    await directSeveral(user);
    await pickAccount(user);
    await pickPayer(user, "AMMA", /^Full share$/);
    await user.click(confirm());
    expect((await screen.findByTestId("bulk-people-failed")).textContent).toContain("Only partly saved");
    expect(screen.queryByRole("button", { name: /2 EMIs recorded$/ })).toBeNull();
    await user.click(footer("Retry 1 people's payment"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(2));
    expect(emiRecordPayment).toHaveBeenCalledTimes(2);
    expect(reimbRecord.mock.calls[1][0][0].key).toBe(reimbRecord.mock.calls[0][0][0].key);
  });
});

describe("N — Pay now, a person paid the lender directly", () => {
  const sharer = (name: string, share = 1000) => ({ personId: name, personName: name, installmentId: "i1", sequenceNumber: 1, dueDate: day(-3), obligationKey: "emi-inst:i1", share, received: 0, remaining: share });
  async function openDirect(user: ReturnType<typeof userEvent.setup>, names: string[] = ["AMMA", "JOHN"]) {
    breakdownState = { breakdown: breakdownOf(names.map((n) => ({ id: n, name: n, current: line("emi-inst:i1", 1, 1000, 0) }))), isLoading: false };
    reimbLines = names.map((n) => sharer(n));
    renderDialog(emiTarget());
    await openFlow(user, /^(Person|AMMA and JOHN|AMMA) pays lender$/);
    await pickPaidDate(user);
  }
  const choose = (user: ReturnType<typeof userEvent.setup>, person: string, option: RegExp) =>
    user.click(within(screen.getByRole("radiogroup", { name: person })).getByRole("radio", { name: option }));
  const checked = (person: string) =>
    within(screen.getByRole("radiogroup", { name: person })).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent);
  const save = () => screen.getByRole("button", { name: /^(Save payment made by|Save past payment|Record direct payment)/ }) as HTMLButtonElement;
  async function partPayment(user: ReturnType<typeof userEvent.setup>, amount: string) {
    await user.click(screen.getByTestId("other-ways-toggle"));
    await user.click(screen.getByRole("radio", { name: /A different amount/ }));
    await user.type(within(screen.getByTestId("amount-card")).getByRole("spinbutton"), amount);
  }

  it("nobody is preselected and saving waits for an explicit payer", async () => {
    const user = userEvent.setup();
    await openDirect(user);
    expect(checked("AMMA")).toEqual(["Didn't pay"]);
    expect(checked("JOHN")).toEqual(["Didn't pay"]);
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId("direct-settlement-blocker").textContent).toContain("Choose who paid #1");
  });

  it("one of two sharers pays: only that person is settled, nothing touches an account, the note names only them", async () => {
    const user = userEvent.setup();
    await openDirect(user);
    await choose(user, "AMMA", /^Full share$/);
    expect(screen.queryByRole("radio", { name: /Add to my account/ })).toBeNull();
    await pickAccount(user, "Account for the People record");
    await user.click(save());
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(reimbRecord.mock.calls[0][0]).toHaveLength(1);
    expect(reimbRecord.mock.calls[0][0][0]).toMatchObject({ personId: "AMMA", amount: 1000, recordedEarlier: true });
    const note = (emiRecordPayment.mock.calls[0][2] as { note: string }).note;
    expect(note.startsWith("Paid directly by AMMA")).toBe(true);
    expect(note).not.toContain("JOHN");
  });

  it("two people, different portions: exactly the typed amounts are settled", async () => {
    const user = userEvent.setup();
    await openDirect(user);
    await choose(user, "AMMA", /^Full share$/);
    await choose(user, "JOHN", /^Part$/);
    await user.type(screen.getByLabelText("Amount covered for JOHN"), "400");
    await pickAccount(user, "Account for the People record");
    await user.click(save());
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(1));
    expect(reimbRecord.mock.calls[0][0].map((i) => [i.personId, i.amount])).toEqual([["AMMA", 1000], ["JOHN", 400]]);
  });

  it("a part lender payment can't credit people for more than was paid — refused before any write", async () => {
    const user = userEvent.setup();
    await openDirect(user);
    await partPayment(user, "1500");
    await choose(user, "AMMA", /^Full share$/);
    await choose(user, "JOHN", /^Full share$/);
    await pickAccount(user, "Account for the People record");
    expect(screen.getByTestId("direct-settlement-blocker").textContent).toContain("cover more than");
    expect(save().disabled).toBe(true);
    await user.click(save());
    expect(emiRecordPayment).not.toHaveBeenCalled();
    expect(reimbRecord).not.toHaveBeenCalled();
  });

  it("zero, negative and over-share amounts are refused", async () => {
    const user = userEvent.setup();
    await openDirect(user);
    await choose(user, "AMMA", /^Part$/);
    await pickAccount(user, "Account for the People record");
    const field = screen.getByLabelText("Amount covered for AMMA");
    for (const bad of ["0", "-5", "1200"]) {
      await user.clear(field);
      await user.type(field, bad);
      expect(save().disabled).toBe(true);
    }
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("the People record account is required before the lender write starts", async () => {
    const user = userEvent.setup();
    await openDirect(user);
    await choose(user, "AMMA", /^Full share$/);
    expect(save().disabled).toBe(true);
    await user.click(save());
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("People write fails: reported as partly saved, retry writes People only, with the same key", async () => {
    const user = userEvent.setup();
    reimbRecord.mockImplementationOnce(async (items) => Object.fromEntries(items.map((i) => [i.key, { status: "failed" as const, error: "network" }])) as never);
    await openDirect(user);
    await choose(user, "AMMA", /^Full share$/);
    await pickAccount(user, "Account for the People record");
    await user.click(save());
    expect((await screen.findByTestId("people-partly-saved")).textContent).toContain("Only partly saved");
    await user.click(footer("Retry people's payments"));
    await waitFor(() => expect(reimbRecord).toHaveBeenCalledTimes(2));
    expect(emiRecordPayment).toHaveBeenCalledTimes(1);
    expect(reimbRecord.mock.calls[1][0][0].key).toBe(reimbRecord.mock.calls[0][0][0].key);
  });
});
