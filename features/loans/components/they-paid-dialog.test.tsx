// @vitest-environment jsdom
import type { ReimbursementItem, ReimbursementLine, ReimbursementResult } from "@/lib/engines/historical-reimbursement";
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Installment } from "@/lib/models/payment-schedule";
import type { InstallmentBreakdown } from "@/lib/engines/installment-participants";
import { TheyPaidDialog } from "./they-paid-dialog";

/** "They paid" on a schedule row: People side only — the same per-person People receipt as the past-payment form, never a lender write. */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/loans" }));
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
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(async () => {}) }) }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", type: "bank", deletedAt: null, currentBalance: 1000 }] }) }));
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
vi.mock("@/features/people/hooks/use-payment-deferrals", () => ({
  usePaymentDeferralActions: () => ({ apply: vi.fn() }),
  usePeoplePaymentDeferrals: () => ({ deferralsByPerson: {}, isLoading: false }),
}));
vi.mock("@/features/settings/hooks/use-user-preferences", () => ({ useMonthCycleStartDay: () => 1 }));
let breakdown: InstallmentBreakdown | null = null;
vi.mock("@/features/loans/hooks/use-installment-breakdown", () => ({ useInstallmentBreakdown: () => ({ breakdown, isLoading: false }) }));
let lines: ReimbursementLine[] = [];
const record = vi.fn(async (items: readonly ReimbursementItem[], _a: string, previous: Record<string, ReimbursementResult> = {}) => ({
  ...previous,
  ...Object.fromEntries(items.map((i) => [i.key, { status: "recorded" as const }])),
}));
vi.mock("@/features/loans/hooks/use-historical-reimbursement", () => ({ useHistoricalReimbursement: () => ({ lines, isLoading: false, record }) }));

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
  lines = [];
  breakdown = null;
  record.mockClear();
});

const inst = { id: "i1", scheduleId: "s", ownerType: "emi", ownerId: "src", sequenceNumber: 1, dueDate: new Date(2026, 8, 5), amountDue: 3000, amountPaid: 0, isSkipped: false, principalPortion: null, interestPortion: null, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] } as unknown as Installment;
const share = (personId: string, personName: string, received = 0): ReimbursementLine =>
  ({ personId, personName, installmentId: "i1", sequenceNumber: 1, dueDate: new Date(2026, 8, 5), obligationKey: "emi-inst:i1", share: 1000, received, remaining: 1000 - received }) as ReimbursementLine;
const renderIt = () => render(<TheyPaidDialog open onOpenChange={() => {}} sourceKind="emi" source={{ id: "src" } as never} installments={[inst]} installmentId="i1" />);
const choose = (user: ReturnType<typeof userEvent.setup>, who: string, option: string) => user.click(within(screen.getByRole("radiogroup", { name: who })).getByRole("radio", { name: option }));

describe("They paid", () => {
  it("records only a People receipt for what the person paid — one idempotent item, no lender write, account chosen explicitly", async () => {
    const user = userEvent.setup();
    lines = [share("sanju", "SANJU")];
    renderIt();
    const save = () => screen.getByRole("button", { name: "Record Received" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true); // nothing is assumed received
    await choose(user, "SANJU", "Received in Full");
    await choose(user, "Where is SANJU's money", "Add to my account");
    expect(save().disabled).toBe(true); // an account is needed
    await user.selectOptions(screen.getByLabelText("Received into account"), "sbi");
    await user.click(save());
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    const [items, accountId] = record.mock.calls[0];
    expect(accountId).toBe("sbi");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ personId: "sanju", obligationKey: "emi-inst:i1", amount: 1000, recordedEarlier: false, dateKnown: true });
  });

  it("'Already in my account' records the receipt with no balance change", async () => {
    const user = userEvent.setup();
    lines = [share("sanju", "SANJU")];
    renderIt();
    await choose(user, "SANJU", "Received in Full");
    await choose(user, "Where is SANJU's money", "Already in my account");
    await user.selectOptions(screen.getByLabelText("Received into account"), "sbi");
    await user.click(screen.getByRole("button", { name: "Record Received" }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0][0]).toMatchObject({ recordedEarlier: true });
  });

  it("a share People already shows as received is never offered again", () => {
    lines = [share("sanju", "SANJU", 1000)];
    renderIt();
    expect(screen.getByText(/Received earlier/)).toBeTruthy();
    expect(screen.getByTestId("they-paid-nothing-open")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "SANJU" })).toBeNull();
  });

  it("a general People payment is only pointed out (with a link) — never assigned to the installment", () => {
    lines = [share("sanju", "SANJU")];
    breakdown = { installmentAmount: 3000, lenderPaid: 0, lenderRemaining: 3000, yourShare: 2000, othersOwe: 1000, participants: [{ personId: "sanju", personName: "SANJU", current: { key: "emi-inst:i1", installmentId: "i1", sequenceNumber: 1, dueDate: new Date(), share: 1000, received: 0, remaining: 1000, state: "none" as never }, carried: [], outstanding: 1000, generalCredit: 1000 }] };
    renderIt();
    const note = screen.getByTestId("they-paid-general-sanju");
    expect(note.textContent).toContain("isn't linked to an installment");
    expect(within(note).getByRole("link", { name: "People" }).getAttribute("href")).toBe("/people?person=sanju");
    expect(record).not.toHaveBeenCalled();
  });
});
