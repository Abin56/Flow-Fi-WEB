// @vitest-environment jsdom
import type { ReimbursementItem, ReimbursementLine, ReimbursementResult } from "@/lib/engines/historical-reimbursement";
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Installment } from "@/lib/models/payment-schedule";
import type { InstallmentBreakdown } from "@/lib/engines/installment-participants";
import { TheyPaidPanel } from "./they-paid-panel";

/** Inline "They paid" panel: new receipt / link held advance / pending. "They paid" on a schedule row: People side only — the same per-person People receipt as the past-payment form, never a lender write. */

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

vi.mock("@/hooks/use-people", () => ({ usePeople: () => ({ data: [{ id: "sanju", name: "SANJU" }] }) }));
let entries: unknown[] = [];
const applyAdvance = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/features/people/hooks/use-people-data", () => ({
  usePeopleLedgerEntries: () => ({ entriesByPersonId: { sanju: entries } }),
  usePeopleAdvanceApplications: () => ({ applicationsByPersonId: {} }),
  usePeopleActions: () => ({ applyPersonAdvance: applyAdvance }),
}));
const inst = { id: "i1", scheduleId: "s", ownerType: "emi", ownerId: "src", sequenceNumber: 1, dueDate: new Date(2026, 8, 5), amountDue: 3000, amountPaid: 0, isSkipped: false, principalPortion: null, interestPortion: null, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] } as unknown as Installment;
const share = (personId: string, personName: string, received = 0): ReimbursementLine =>
  ({ personId, personName, installmentId: "i1", sequenceNumber: 1, dueDate: new Date(2026, 8, 5), obligationKey: "emi-inst:i1", share: 1000, received, remaining: 1000 - received }) as ReimbursementLine;
const renderIt = () => render(<TheyPaidPanel sourceKind="emi" source={{ id: "src" } as never} installments={[inst]} installmentId="i1" onClose={() => {}} />);
const choose = (user: ReturnType<typeof userEvent.setup>, who: string, option: string) => user.click(within(screen.getByRole("radiogroup", { name: who })).getByRole("radio", { name: option }));

beforeEach(() => {
  entries = [];
  applyAdvance.mockClear();
});

describe("They paid — inline panel", () => {
  it("shows installment / received / left once, 'Not Received' is the default, Record Received stays disabled and Cancel writes nothing", async () => {
    const user = userEvent.setup();
    lines = [share("sanju", "SANJU")];
    renderIt();
    const block = screen.getByTestId("reconcile-person-sanju").textContent ?? "";
    expect(block).toContain("Installment₹1,000");
    expect(block).toContain("Left₹1,000");
    expect(within(screen.getByRole("radiogroup", { name: "SANJU" })).getByRole("radio", { name: "Not Received" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("they-paid-save") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Keep pending" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(record).not.toHaveBeenCalled();
    expect(applyAdvance).not.toHaveBeenCalled();
  });

  it("shows what was already received and what is left", () => {
    lines = [share("sanju", "SANJU", 400)];
    renderIt();
    const block = screen.getByTestId("reconcile-person-sanju").textContent ?? "";
    expect(block).toContain("Received₹400");
    expect(block).toContain("Left₹600");
  });

  it("Received Partially asks for the amount and records exactly that", async () => {
    const user = userEvent.setup();
    lines = [share("sanju", "SANJU")];
    renderIt();
    await choose(user, "SANJU", "Received Partially");
    await user.type(screen.getByLabelText("Amount received from SANJU"), "400");
    await choose(user, "Where is SANJU's money", "Add to my account");
    await user.selectOptions(screen.getByLabelText("Received into account"), "sbi");
    await user.click(screen.getByTestId("they-paid-save"));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toHaveLength(1);
    expect(record.mock.calls[0][0][0]).toMatchObject({ amount: 400 });
  });

  it("a held People advance is linked with applyPersonAdvance — no new receipt, no bank transaction", async () => {
    const user = userEvent.setup();
    lines = [share("sanju", "SANJU")];
    entries = [{ id: "adv1", deletedAt: null, sourceKind: "advance", type: "receivedBack", date: new Date(2026, 8, 1), createdAt: new Date(2026, 8, 1), amount: 1000 }];
    renderIt();
    await user.click(screen.getByRole("button", { name: /Already received · link ₹1,000/ }));
    await waitFor(() => expect(applyAdvance).toHaveBeenCalledTimes(1));
    const [, params] = applyAdvance.mock.calls[0] as [unknown, { targets: { obligationKey: string; uses: { advanceEntryId: string; amount: number }[] }[] }];
    expect(params.targets).toEqual([{ obligationKey: "emi-inst:i1", uses: [{ advanceEntryId: "adv1", amount: 1000 }] }]);
    expect(record).not.toHaveBeenCalled();
  });

  it("no held advance: no link offered; a new receipt is the People writer (one item)", async () => {
    const user = userEvent.setup();
    lines = [share("sanju", "SANJU")];
    renderIt();
    expect(screen.queryByTestId("they-paid-held-sanju")).toBeNull();
    await choose(user, "SANJU", "Received in Full");
    await choose(user, "Where is SANJU's money", "Add to my account");
    await user.selectOptions(screen.getByLabelText("Received into account"), "sbi");
    await user.click(screen.getByTestId("they-paid-save"));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(applyAdvance).not.toHaveBeenCalled();
  });
});
