// @vitest-environment jsdom
/**
 * Covers the Bills-safety follow-ups: an Unskip action wired to the transactional `unskip` method (with loading
 * state and stale-refusal handling), occurrences refreshed when a bill is opened (no new listener — a point-in-time
 * refetch), and the read-only Duplicate Review panel. Mocks the data hooks the way other Bills/feature component
 * tests in this codebase do; the repository/engine logic itself is covered by the emulator and unit suites.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillsWorkspace } from "./bills-workspace";
import type { Bill, BillOccurrence, PaymentRecord } from "@/lib/models/bill";
import { toast } from "@/store/toast-store";

const base = { deletedAt: null, lastEditedAt: null, editHistory: [], createdAt: new Date(2026, 0, 1) };
function bill(id: string, over: Partial<Bill> = {}): Bill {
  return { ...base, id, name: "QA Electricity", amount: 1_000, nextDueDate: new Date(2026, 9, 27, 12), recurrence: "monthly", accountId: null, categoryId: null, customIntervalDays: null, reminderOffsets: [], notes: "", ...over };
}
function occ(id: string, over: Partial<BillOccurrence> = {}): BillOccurrence {
  return { ...base, id, billId: "b1", dueDate: new Date(2026, 9, 27, 12), amount: 1_000, amountPaid: 0, isSkipped: false, ...over };
}

let rowsState: { bill: Bill; occurrence: BillOccurrence | null; account: undefined; category: undefined }[] = [];
let cyclesState: { billId: string; occurrence: BillOccurrence }[] = [];
const refreshOccurrences = vi.fn(async () => {});
const skipOccurrence = vi.fn(async () => {});
const unskipOccurrence = vi.fn(async () => {});
const listPayments = vi.fn(async (_billId: string) => [] as PaymentRecord[]);
const listOccurrences = vi.fn(async (_billId: string) => [] as BillOccurrence[]);

vi.mock("@/features/bills/hooks/use-bills-data", () => ({
  useBillRows: () => ({ rows: rowsState, cycles: cyclesState, isLoading: false, refreshOccurrences }),
  useBillActions: () => ({
    createBill: vi.fn(),
    editBill: vi.fn(),
    deleteBill: vi.fn(),
    payFromAccount: vi.fn(),
    recordPaidEarlier: vi.fn(),
    editBillPayment: vi.fn(),
    cancelBillPayment: vi.fn(),
    listPayments,
    listOccurrences,
    skipOccurrence,
    unskipOccurrence,
    recordPayment: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [] }) }));
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/features/bills/hooks/use-upcoming-dues", () => ({
  UPCOMING_DUES_HORIZON_DAYS: 7,
  useUpcomingDues: () => ({ items: [], totals: { creditCard: 0, loan: 0, emi: 0, total: 0, overdue: 0, includedInCardBills: 0 }, isLoading: false }),
}));

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<BillsWorkspace />, { wrapper: Wrapper });
}

function setFixture(opts: { occurrence: BillOccurrence | null; extraOccurrences?: BillOccurrence[] }) {
  const b = bill("b1");
  rowsState = [{ bill: b, occurrence: opts.occurrence, account: undefined, category: undefined }];
  const all = [...(opts.occurrence ? [opts.occurrence] : []), ...(opts.extraOccurrences ?? [])];
  cyclesState = all.map((occurrence) => ({ billId: "b1", occurrence }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openBill() {
  fireEvent.click(screen.getByText("QA Electricity"));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
}

describe("Unskip action", () => {
  it("a skipped cycle shows Un-skip (not Skip); clicking it calls the transactional unskip method", async () => {
    setFixture({ occurrence: occ("o1", { isSkipped: true }) });
    renderWorkspace();
    await openBill();

    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    const unskip = screen.getByRole("button", { name: "Un-skip" }) as HTMLButtonElement;
    expect(unskip.disabled).toBe(false);

    fireEvent.click(unskip);
    await waitFor(() => expect(unskipOccurrence).toHaveBeenCalledTimes(1));
    expect(unskipOccurrence).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }), expect.objectContaining({ id: "o1", isSkipped: true }));
  });

  it("an unpaid, un-skipped cycle still shows Skip (not Un-skip)", async () => {
    setFixture({ occurrence: occ("o1") });
    renderWorkspace();
    await openBill();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Un-skip" })).toBeNull();
  });

  it("Un-skip shows a loading label while in flight and is not double-invoked by a second click", async () => {
    let resolve!: () => void;
    unskipOccurrence.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    setFixture({ occurrence: occ("o1", { isSkipped: true }) });
    renderWorkspace();
    await openBill();

    const unskip = screen.getByRole("button", { name: "Un-skip" });
    fireEvent.click(unskip);
    await waitFor(() => expect(screen.getByRole("button", { name: "Un-skipping…" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Un-skipping…" }));
    expect(unskipOccurrence).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Un-skip" })).toBeTruthy());
  });

  it("a refused Un-skip (e.g. stale panel) shows an error toast and refreshes occurrences instead of silently doing nothing", async () => {
    const toastError = vi.spyOn(toast, "error");
    unskipOccurrence.mockRejectedValueOnce(new Error("This bill cycle no longer exists — refresh and try again."));
    setFixture({ occurrence: occ("o1", { isSkipped: true }) });
    renderWorkspace();
    await openBill();
    refreshOccurrences.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Un-skip" }));
    await waitFor(() => expect(unskipOccurrence).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshOccurrences).toHaveBeenCalled());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't un-skip this bill", expect.stringMatching(/no longer exists/i)));
  });
});

describe("freshness: opening a bill refreshes occurrences without a new listener", () => {
  it("clicking a bill card triggers a refresh (point-in-time refetch), not a permanent subscription", async () => {
    setFixture({ occurrence: occ("o1") });
    renderWorkspace();
    expect(refreshOccurrences).not.toHaveBeenCalled();
    await openBill();
    expect(refreshOccurrences).toHaveBeenCalledTimes(1);
  });
});

describe("Duplicate Review panel (read-only)", () => {
  it("no duplicate-cycle button when every bill has at most one occurrence per due day", () => {
    setFixture({ occurrence: occ("o1") });
    renderWorkspace();
    expect(screen.queryByText(/duplicate cycle/i)).toBeNull();
  });

  it("shows a count button when a duplicate exists; opening it lists both occurrences, their status, and the totals effect — and loads payments once, read-only", async () => {
    const paid = occ("o-old", { amountPaid: 1_000, createdAt: new Date(2026, 0, 1) });
    const phantom = occ("o-new", { createdAt: new Date(2026, 0, 2) });
    listPayments.mockResolvedValueOnce([{ ...base, id: "p1", billId: "b1", occurrenceId: "o-old", amount: 1_000, date: new Date(2026, 9, 27, 12), note: "", transactionId: "t1", accountId: "a1", recordedEarlier: false }]);
    setFixture({ occurrence: phantom, extraOccurrences: [paid] });
    renderWorkspace();

    const button = await screen.findByRole("button", { name: /1 duplicate cycle/i });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: /duplicate bill cycles/i });
    expect(within(dialog).getByText("o-old")).toBeTruthy();
    expect(within(dialog).getByText("o-new")).toBeTruthy();
    expect(within(dialog).getByText("Shown on Bills page")).toBeTruthy(); // the phantom, currently shown
    await waitFor(() => expect(listPayments).toHaveBeenCalledWith("b1"));
    await waitFor(() => expect(within(dialog).getByText(/p1/)).toBeTruthy());
    expect(within(dialog).getByText(/overstated by/i)).toBeTruthy();

    // Read-only: no write-capable action anywhere in the panel.
    expect(within(dialog).queryByRole("button", { name: /merge|delete|resolve|apply|fix/i })).toBeNull();
  });

  it("two unpaid duplicates on the same day: no payment rows, recommendation still shown, nothing resolved automatically", async () => {
    setFixture({ occurrence: occ("o-a", { createdAt: new Date(2026, 0, 1) }), extraOccurrences: [occ("o-b", { createdAt: new Date(2026, 0, 2) })] });
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: /duplicate cycle/i }));
    const dialog = await screen.findByRole("dialog", { name: /duplicate bill cycles/i });
    expect(within(dialog).getByText(/keep one/i)).toBeTruthy();
  });
});
