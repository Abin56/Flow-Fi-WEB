// @vitest-environment jsdom
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { linkedStateOf, type LinkedPeopleReadiness, type LinkedPerson } from "@/lib/engines/linked-people-readiness";
import { RecordPaymentDialog, type PaymentTarget } from "./record-payment-dialog";

/**
 * Loan / EMI Record payment — People settlement gate: a shared installment can't be recorded while a person's
 * share of THAT installment is still to come in. The primary action becomes the exact Settle step; Enter only
 * focuses it. Once every linked share is received, the normal Record action returns.
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
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
vi.mock("@/features/people/hooks/use-linked-funds", () => ({ useLinkedFunds: () => ({ funds: [] }) }));
vi.mock("@/features/people/components/linked-funds", () => ({ LinkedFundsPayNotice: () => null }));

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

const renderDialog = (target: PaymentTarget) => render(<RecordPaymentDialog target={target} open onOpenChange={() => {}} />);
const card = () => screen.queryByRole("region", { name: "People settlement" });

describe("EMI Record payment — People settlement gate", () => {
  const JOHN_PENDING = () => readinessOf([person("amma", "AMMA", 1000, 1000, "emi-inst:i1"), person("john", "JOHN", 1000, 0, "emi-inst:i1")]);

  it("reads readiness for THIS installment only (by id)", () => {
    peopleState = { readiness: JOHN_PENDING(), isLoading: false };
    renderDialog(emiTarget());
    expect(readinessTargets.at(-1)).toEqual({ kind: "emi", installmentId: "i1", installmentIds: ["i1"], lenderDue: 3000 });
  });

  it("JOHN pending → blocked: Settle CTA replaces Record, deep-links to JOHN's installment share", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: JOHN_PENDING(), isLoading: false };
    renderDialog(emiTarget());
    expect(card()!.dataset.state).toBe("blocked");
    expect(within(card()!).getByText("AMMA")).toBeTruthy(); // received ✓ row
    expect(within(card()!).getByText(/must be recorded from JOHN before this EMI can be paid/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^record/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Settle ₹1,000 with JOHN →" }));
    expect(push).toHaveBeenCalledWith("/people?person=john&obligation=emi-inst%3Ai1&settle=1&return=%2Femi");
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("Enter can't record the blocked EMI — it focuses the Settle step without leaving", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: JOHN_PENDING(), isLoading: false };
    renderDialog(emiTarget());
    screen.getAllByRole("radio")[0].focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(within(card()!).getByRole("link", { name: "Settle ₹1,000 with JOHN" }));
    expect(push).not.toHaveBeenCalled();
    expect(emiRecordPayment).not.toHaveBeenCalled();
  });

  it("partial People payment → still blocked for the rest", () => {
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 600, "emi-inst:i1")]), isLoading: false };
    renderDialog(emiTarget());
    expect(screen.getByRole("button", { name: "Settle ₹400 with JOHN →" })).toBeTruthy();
  });

  it("all linked shares received → People settled; Record pays the EMI once", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([person("amma", "AMMA", 1000, 1000, "emi-inst:i1"), person("john", "JOHN", 1000, 1000, "emi-inst:i1")]), isLoading: false };
    renderDialog(emiTarget());
    expect(card()!.dataset.state).toBe("settled");
    expect(within(card()!).getByText("Ready to pay Home EMI.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /record ₹3,000/i }));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
    expect(emiRecordPayment.mock.calls[0][2]).toMatchObject({ amount: 3000, targetInstallmentId: "i1" });
  });

  it("People data loading → Record waits (disabled), never reads as 'nothing linked'", () => {
    peopleState = { readiness: null, isLoading: true };
    renderDialog(emiTarget());
    expect((screen.getByRole("button", { name: "Checking People…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("no linked People → unchanged Record flow", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([]), isLoading: false };
    renderDialog(emiTarget());
    expect(card()).toBeNull();
    await user.click(screen.getByRole("button", { name: /record ₹3,000/i }));
    await waitFor(() => expect(emiRecordPayment).toHaveBeenCalledTimes(1));
  });
});

describe("Loan Record payment — People settlement gate", () => {
  it("paying an installment before it is due asks People about nothing (its shares are not owed yet)", () => {
    const target = loanTarget();
    const future = [installment("l1", 1, "loan", 5), installment("l2", 2, "loan", 35)];
    renderDialog({ ...target, row: { ...(target.row as object), installments: future } } as PaymentTarget);
    expect(readinessTargets.at(-1)).toEqual({ kind: "loan", installmentId: "l1", installmentIds: [], lenderDue: 3000 });
  });

  it("linked People pending on this installment → loan payment gated", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 0, "loan-inst:l1")]), isLoading: false };
    renderDialog(loanTarget());
    expect(readinessTargets.at(-1)).toEqual({ kind: "loan", installmentId: "l1", installmentIds: ["l1"], lenderDue: 3000 });
    await user.click(screen.getByRole("button", { name: "Settle ₹1,000 with JOHN →" }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining("obligation=loan-inst%3Al1"));
    expect(loanRecordPayment).not.toHaveBeenCalled();
  });

  it("settled → the loan installment records once", async () => {
    const user = userEvent.setup();
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 1000, "loan-inst:l1")]), isLoading: false };
    renderDialog(loanTarget());
    await user.click(screen.getByRole("button", { name: /record ₹3,000/i }));
    await waitFor(() => expect(loanRecordPayment).toHaveBeenCalledTimes(1));
  });

  it("a loan I gave (repayment received) is never gated", () => {
    peopleState = { readiness: readinessOf([person("john", "JOHN", 1000, 0, "loan-inst:l1")]), isLoading: false };
    renderDialog(loanTarget("given"));
    expect(readinessTargets.at(-1)).toBeNull();
    expect(card()).toBeNull();
    expect(screen.getByRole("button", { name: /record ₹3,000/i })).toBeTruthy();
  });
});
