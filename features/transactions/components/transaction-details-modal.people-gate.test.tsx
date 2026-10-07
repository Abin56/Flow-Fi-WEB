// @vitest-environment jsdom
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import { linkedStateOf, peopleSettlementGate, PeopleSettlementPendingError, type LinkedPeopleReadiness, type LinkedPerson } from "@/lib/engines/linked-people-readiness";
import { TransactionDetailsModal, type PeopleGateInput } from "./transaction-details-modal";
import { CardStatementChangedError } from "@/lib/repositories/transaction-repository";

/**
 * Transaction form redesign + card-bill People settlement gate.
 *  - Add Expense / Add Income / Add Transfer keep every field and behavior.
 *  - A card-bill transfer whose card carries an unresolved linked People obligation can't be saved by any path
 *    (button, Enter, Ctrl+Enter, form submit); the primary action becomes the exact Settle step instead.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={String(href)} {...rest}>
        {children}
      </a>
    );
  }),
}));
const addLedgerEntryWithTransaction = vi.fn(async () => {});
vi.mock("@/features/people/hooks/use-people-data", () => ({
  usePeopleActions: () => ({ addLedgerEntryWithTransaction }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const accounts = [
  { id: "sbi", name: "SBI", type: "bank", bankId: null },
  { id: "octane", name: "OCTANE", type: "card" },
  { id: "hdfc-card", name: "HDFC CARD", type: "card" },
] as unknown as Account[];
const categories = [
  { id: "food", name: "Food", type: "expense" },
  { id: "salary", name: "Salary", type: "income" },
] as unknown as Category[];
const people = [{ id: "amma", name: "AMMA" }] as unknown as Person[];

function makeActions() {
  return {
    createTransaction: vi.fn(async (input: Record<string, unknown>) => ({ id: "t1", ...input })),
    createTransferPair: vi.fn(async (_input: Record<string, unknown>) => {}),
    applyOwesPersonChange: vi.fn(async () => {}),
    editTransaction: vi.fn(async () => {}),
    deleteTransaction: vi.fn(async () => {}),
    expenseRepository: { convertToSplit: vi.fn(async () => {}), editExpense: vi.fn(async () => {}) },
  };
}
let actions: ReturnType<typeof makeActions>;
beforeEach(() => {
  actions = makeActions();
  addLedgerEntryWithTransaction.mockClear();
});

/** One person's linked share on the card bill — `received` of `share` already given. */
function person(personId: string, personName: string, share: number, received: number): LinkedPerson {
  const remaining = share - received;
  const state = linkedStateOf(share, remaining);
  return { personId, personName, share, received, remaining, state, obligations: [{ key: `ledger:${personId}-g`, title: "Phone", share, received, remaining, state }] };
}
function readinessOf(lenderDue: number, list: LinkedPerson[]): LinkedPeopleReadiness {
  const peopleShare = list.reduce((s, p) => s + p.share, 0);
  const received = list.reduce((s, p) => s + p.received, 0);
  const sorted = [...list].sort((a, b) => b.remaining - a.remaining);
  return { lenderDue, people: sorted, peopleShare, received, stillExpected: peopleShare - received, yourPortion: Math.max(0, lenderDue - peopleShare) };
}
const gateOf = (readiness: LinkedPeopleReadiness | null, loading = false): PeopleGateInput => ({
  accountId: "octane",
  readiness,
  loading,
  payeeName: "OCTANE",
  returnTo: "/credit-cards?card=c-octane&pay=1",
});

function renderAdd(props: Partial<Parameters<typeof TransactionDetailsModal>[0]> = {}) {
  return render(
    <TransactionDetailsModal
      open
      onOpenChange={() => {}}
      row={null}
      expense={null}
      people={people}
      accounts={accounts}
      categories={categories}
      actions={actions as never}
      {...props}
    />,
  );
}
const renderCardBill = (peopleGate: PeopleGateInput | null, extra: Partial<Parameters<typeof TransactionDetailsModal>[0]> = {}) =>
  renderAdd({ defaultKind: "transfer", initialDestinationAccountId: "octane", initialAmount: 1000, peopleGate, ...extra });

const amountInput = () => document.getElementById("txn-amount") as HTMLInputElement;
const footerSettle = () => document.querySelector<HTMLAnchorElement>('[data-gate="settle"]');
const settlementCard = () => screen.queryByRole("region", { name: "People settlement" });
const nothingSaved = () => {
  expect(actions.createTransferPair).not.toHaveBeenCalled();
  expect(actions.createTransaction).not.toHaveBeenCalled();
};

describe("Add Expense — every field and function retained", () => {
  it("renders amount, mode switch (no Transfer), details, Paid from, People & Split, notes and more options", async () => {
    const user = userEvent.setup();
    renderAdd();
    expect(screen.getByRole("heading", { name: "Add Expense" })).toBeTruthy();
    const modes = within(screen.getByRole("group", { name: "Transaction type" }));
    expect(modes.getByRole("button", { name: /expense/i }).getAttribute("aria-pressed")).toBe("true");
    expect(modes.getByRole("button", { name: /income/i }).getAttribute("aria-pressed")).toBe("false");
    expect(modes.queryByRole("button", { name: /transfer/i })).toBeNull();

    expect(amountInput()).toBeTruthy();
    expect(screen.getByPlaceholderText("e.g. Blue Tokai Coffee")).toBeTruthy();
    expect(screen.getByText("Category *")).toBeTruthy();
    expect(screen.getByText("Date *")).toBeTruthy();
    expect(screen.getByText("Paid from")).toBeTruthy();
    expect(screen.getByText("Assign to a person")).toBeTruthy();
    expect(screen.getByRole("button", { name: /split with more people/i })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Notes" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /more options/i }));
    expect(screen.getByText(/don.t count this in my totals/i)).toBeTruthy();
    expect(screen.getByText(/count this in a different month/i)).toBeTruthy();
  });

  it("Enter on the amount steps to Description; a valid Ctrl+Enter saves exactly one expense", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "450");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByPlaceholderText("e.g. Blue Tokai Coffee"));
    await user.type(screen.getByPlaceholderText("e.g. Blue Tokai Coffee"), "Lunch");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction.mock.calls[0][0]).toMatchObject({ type: "expense", amount: 450, accountId: "sbi", categoryId: "food", description: "Lunch" });
  });

  it("a People gate passed to the popup never affects an expense", async () => {
    const user = userEvent.setup();
    renderAdd({ peopleGate: gateOf(readinessOf(1000, [person("amma", "AMMA", 1000, 0)])) });
    expect(settlementCard()).toBeNull();
    await user.type(amountInput(), "100");
    await user.type(screen.getByPlaceholderText("e.g. Blue Tokai Coffee"), "Tea");
    await user.click(screen.getByRole("button", { name: "Add Expense" }));
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
  });
});

describe("Add Income — every field and function retained", () => {
  it("switching to Income: semantic mode, income placeholder, Received in, no People & Split; saves income", async () => {
    const user = userEvent.setup();
    renderAdd();
    const income = screen.getByRole("button", { name: /income/i });
    await user.click(income);
    expect(income.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "Add Income" })).toBeTruthy();
    expect(screen.getByText("Received in")).toBeTruthy();
    expect(screen.queryByText("Assign to a person")).toBeNull();
    // A plus sign, never a minus, on the amount.
    expect(within(amountInput().parentElement!).getByText("+")).toBeTruthy();

    await user.type(amountInput(), "5000");
    await user.type(screen.getByPlaceholderText("e.g. Salary, Freelance payment"), "Salary");
    await user.click(screen.getByRole("button", { name: "Add Income" }));
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction.mock.calls[0][0]).toMatchObject({ type: "income", amount: 5000 });
  });
});

describe("Add Transfer — transfer identity, From → To, card bill", () => {
  it("shows Transfer as its own selected mode, no +/− sign, From and To accounts, card-bill context", () => {
    renderCardBill(null);
    expect(screen.getByRole("heading", { name: "Add Transfer" })).toBeTruthy();
    expect(screen.getByText(/card bill payment · octane/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /transfer/i }).getAttribute("aria-pressed")).toBe("true");
    expect(within(amountInput().parentElement!).queryByText("−")).toBeNull();
    expect(within(amountInput().parentElement!).queryByText("+")).toBeNull();
    expect(screen.getByText("From Account *")).toBeTruthy();
    expect(screen.getByText("To Account *")).toBeTruthy();
  });

  it("fast double Save writes ONE card payment (one transfer pair)", async () => {
    let finish!: () => void;
    actions.createTransferPair.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    renderCardBill(gateOf(readinessOf(1000, [])));
    const pay = screen.getByRole("button", { name: /pay ₹1,000/i });
    fireEvent.click(pay);
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    // Second click and a raw submit while the first save is still in flight.
    fireEvent.click(pay);
    fireEvent.submit(pay.closest("form")!);
    finish();
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(actions.createTransferPair).toHaveBeenCalledTimes(1);
  });

  it("write-layer People refusal (state changed since the dialog opened): specific message, dialog stays open, nothing auto-settled", async () => {
    const user = userEvent.setup();
    const stale: LinkedPerson = { personId: "amma", personName: "AMMA", share: 1000, received: 0, remaining: 1000, state: "pending", obligations: [] };
    actions.createTransferPair.mockRejectedValueOnce(new PeopleSettlementPendingError(peopleSettlementGate(readinessOf(1000, [stale])), "card-bill"));
    renderCardBill(gateOf(readinessOf(1000, [])));
    await user.click(screen.getByRole("button", { name: /pay ₹1,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalled());
    expect(screen.getByRole("alert").textContent).toBe("Some people-linked amounts in this bill still need to be settled (₹1,000 from AMMA). Review them before paying.");
    expect(screen.getByRole("heading", { name: "Add Transfer" })).toBeTruthy();
    expect(actions.createTransaction).not.toHaveBeenCalled();
  });

  it("one Save action = one idempotency key: kept across a retry after a refusal, so the retry can never double-record", async () => {
    const user = userEvent.setup();
    const stale: LinkedPerson = { personId: "amma", personName: "AMMA", share: 1000, received: 0, remaining: 1000, state: "pending", obligations: [] };
    actions.createTransferPair.mockRejectedValueOnce(new PeopleSettlementPendingError(peopleSettlementGate(readinessOf(1000, [stale])), "card-bill"));
    renderCardBill(gateOf(readinessOf(1000, [])));
    await user.click(screen.getByRole("button", { name: /pay ₹1,000/i }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: /pay ₹1,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(2));
    const [first, second] = actions.createTransferPair.mock.calls.map(([p]) => (p as { idempotencyKey: string }).idempotencyKey);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });

  it("card bill funding defaults to a bank account — never another credit card listed first", async () => {
    const user = userEvent.setup();
    renderCardBill(gateOf(readinessOf(1000, [])), { accounts: [accounts[2], accounts[1], accounts[0]] as never });
    await user.click(screen.getByRole("button", { name: /pay ₹1,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    expect(actions.createTransferPair).toHaveBeenCalledWith(expect.objectContaining({ sourceAccountId: "sbi", destinationAccountId: "octane" }));
  });

  it("card bill with no linked People: Pay is available and writes ONE transfer pair (never income / expense)", async () => {
    const user = userEvent.setup();
    renderCardBill(gateOf(readinessOf(1000, [])));
    expect(settlementCard()).toBeNull();
    await user.click(screen.getByRole("button", { name: /pay ₹1,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    expect(actions.createTransferPair.mock.calls[0][0]).toMatchObject({ amount: 1000, sourceAccountId: "sbi", destinationAccountId: "octane" });
    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(addLedgerEntryWithTransaction).not.toHaveBeenCalled();
  });
});

describe("Card bill — People settlement gate", () => {
  it("pending People share → blocked: settlement card, exact Settle CTA, no Pay action", () => {
    renderCardBill(gateOf(readinessOf(1000, [person("amma", "AMMA", 1000, 0)])));
    const card = settlementCard()!;
    expect(card.dataset.state).toBe("blocked");
    expect(within(card).getByText("People payment pending")).toBeTruthy();
    expect(within(card).getByText("Not received yet")).toBeTruthy();
    expect(within(card).getByText(/must be recorded from AMMA before this card bill can be paid/)).toBeTruthy();
    // The five accounting rows stay collapsed by default.
    expect(within(card).queryByText("People share")).toBeNull();

    const cta = footerSettle()!;
    expect(cta.textContent).toBe("Settle with AMMA");
    // The footer says WHY the bill waits — the bill payment is step 2, never one person's amount.
    expect(screen.getByTestId("gate-reason").textContent).toMatch(/of this bill is still owed by AMMA. Settle first, then pay the bill./);
    expect(cta.getAttribute("href")).toBe("/people?person=amma&obligation=ledger%3Aamma-g&settle=1&return=%2Fcredit-cards%3Fcard%3Dc-octane%26pay%3D1");
    expect(screen.queryByRole("button", { name: /pay ₹|add transfer/i })).toBeNull();
  });

  it("Enter, Ctrl+Enter and a raw submit can't bypass the gate — focus lands on the Settle step", async () => {
    const user = userEvent.setup();
    renderCardBill(gateOf(readinessOf(1000, [person("amma", "AMMA", 1000, 0)])));
    amountInput().focus();
    await user.keyboard("{Enter}"); // Description empty → steps there first (existing behavior)
    await user.type(document.activeElement as HTMLElement, "Bill");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(footerSettle()));
    amountInput().focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(document.activeElement).toBe(footerSettle()));
    fireEvent.submit(amountInput().form!);
    await new Promise((r) => setTimeout(r, 30));
    nothingSaved();
  });

  it("partial People settlement → still blocked for exactly what remains", () => {
    renderCardBill(gateOf(readinessOf(1000, [person("amma", "AMMA", 1000, 400)])));
    expect(settlementCard()!.dataset.state).toBe("blocked");
    expect(screen.getByText(/₹400 of ₹1,000 received · ₹600 remaining/)).toBeTruthy();
    expect(footerSettle()!.textContent).toBe("Settle with AMMA");
  });

  it("fully settled → the card turns into PEOPLE SETTLED and Pay saves once", async () => {
    const user = userEvent.setup();
    renderCardBill(gateOf(readinessOf(1000, [person("amma", "AMMA", 1000, 1000)])));
    const card = settlementCard()!;
    expect(card.dataset.state).toBe("settled");
    expect(within(card).getByText("People settled")).toBeTruthy();
    expect(within(card).getByText("Ready to pay OCTANE.")).toBeTruthy();
    expect(within(card).getByText("received")).toBeTruthy();
    expect(footerSettle()).toBeNull();
    await user.click(screen.getByRole("button", { name: /pay ₹1,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
  });

  it("multiple people: both open items need attention, the received one shows ✓, all must resolve", () => {
    renderCardBill(gateOf(readinessOf(5000, [person("amma", "AMMA", 2000, 0), person("john", "JOHN", 1000, 1000), person("anu", "ANU", 500, 200)])), {
      initialAmount: 5000,
    });
    const card = settlementCard()!;
    expect(within(card).getByText("2 need attention")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Settle ₹2,000 with AMMA" })).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Settle ₹300 with ANU" })).toBeTruthy();
    expect(within(card).queryByRole("link", { name: /with JOHN/ })).toBeNull();
    expect(within(card).getByText("JOHN")).toBeTruthy();
    expect(within(card).getByText(/₹2,300/)).toBeTruthy();
    expect(footerSettle()!.textContent).toBe("Settle with AMMA");
  });

  it("View breakdown reveals Bill / People share / Received / Remaining / Your share", async () => {
    const user = userEvent.setup();
    renderCardBill(gateOf(readinessOf(5000, [person("amma", "AMMA", 2000, 0), person("anu", "ANU", 500, 200)])), { initialAmount: 5000 });
    await user.click(screen.getByRole("button", { name: /view breakdown/i }));
    const card = settlementCard()!;
    for (const label of ["Bill", "People share", "Received", "Remaining", "Your share"]) expect(within(card).getByText(label)).toBeTruthy();
    expect(within(card).getByText("Your share").nextElementSibling?.textContent).toBe("₹2,500"); // 5,000 − 2,500
    expect(within(card).getByText("Remaining").nextElementSibling?.textContent).toBe("₹2,300");
  });

  it("loading People data → the payment waits (no save), never reads as 'nothing linked'", async () => {
    const user = userEvent.setup();
    renderCardBill(gateOf(null, true));
    expect(screen.getByText("Checking linked People…")).toBeTruthy();
    const waiting = screen.getByRole("button", { name: /checking people/i }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    await user.type(screen.getAllByRole("textbox")[1], "Bill{Enter}");
    fireEvent.submit(amountInput().form!);
    await new Promise((r) => setTimeout(r, 30));
    nothingSaved();
  });

  it("the gate only covers the gated card: paying a different account is not blocked by it", async () => {
    const user = userEvent.setup();
    const onDestinationAccountChange = vi.fn();
    renderCardBill(gateOf(readinessOf(1000, [person("amma", "AMMA", 1000, 0)])), { onDestinationAccountChange });
    expect(footerSettle()).not.toBeNull();

    const toTrigger = screen
      .getAllByRole("combobox")
      .find((el) => el.textContent?.includes("OCTANE"))!;
    await user.click(toTrigger);
    await user.click(await screen.findByRole("option", { name: /HDFC CARD/ }));
    expect(onDestinationAccountChange).toHaveBeenCalledWith("hdfc-card");
    expect(settlementCard()).toBeNull();
    expect(footerSettle()).toBeNull();
    await user.click(screen.getByRole("button", { name: /pay ₹1,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    expect(actions.createTransferPair.mock.calls[0][0]).toMatchObject({ destinationAccountId: "hdfc-card" });
  });

  it("switching the flow to Expense drops the gate (it applies to the bill payment only)", async () => {
    const user = userEvent.setup();
    renderCardBill(gateOf(readinessOf(1000, [person("amma", "AMMA", 1000, 0)])));
    await user.click(screen.getByRole("button", { name: /expense/i }));
    expect(settlementCard()).toBeNull();
    expect(footerSettle()).toBeNull();
    expect(screen.getByRole("button", { name: "Add Expense" })).toBeTruthy();
  });
});



describe("Pay bill — stale statement: refused, then an explicit Refresh bill (never auto-pays)", () => {
  it("another device paid ₹4,000 of the ₹10,000 bill: stale Save refused → Refresh loads ₹6,000 → nothing saved until Pay is pressed", async () => {
    const user = userEvent.setup();
    actions.createTransferPair.mockRejectedValueOnce(new CardStatementChangedError());
    const props = (remaining: number) =>
      ({
        open: true,
        onOpenChange: () => {},
        row: null,
        expense: null,
        people,
        accounts,
        categories,
        actions: actions as never,
        defaultKind: "transfer" as const,
        initialDestinationAccountId: "octane",
        initialAmount: 10000,
        peopleGate: gateOf(readinessOf(remaining, [])),
        statementIntent: { accountId: "octane", statementId: "stmt-A", remaining },
      }) satisfies Parameters<typeof TransactionDetailsModal>[0];
    const view = render(<TransactionDetailsModal {...props(10000)} />);

    await user.click(screen.getByRole("button", { name: /pay ₹10,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    expect(actions.createTransferPair.mock.calls[0][0]).toMatchObject({ amount: 10000, cardStatementIntent: { statementId: "stmt-A" } });
    expect(screen.getByRole("alert").textContent).toMatch(/^This bill changed since you opened it/);

    // The live bill now says ₹6,000 left (another device paid ₹4,000).
    view.rerender(<TransactionDetailsModal {...props(6000)} />);
    await user.click(screen.getByRole("button", { name: "Refresh bill" }));
    expect(amountInput().value).toBe("6000");
    expect(screen.queryByRole("alert")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(actions.createTransferPair).toHaveBeenCalledTimes(1); // refresh never submits

    await user.click(screen.getByRole("button", { name: /pay ₹6,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(2));
    expect(actions.createTransferPair.mock.calls[1][0]).toMatchObject({ amount: 6000, cardStatementIntent: { statementId: "stmt-A" } });
  });
});

describe("Pay bill — Refresh bill is an authoritative fresh read (onRefreshBill), never a save", () => {
  type Fresh = { accountId: string; statementId: string; remaining: number } | null;
  async function staleThenRefresh(onRefreshBill: (accountId: string) => Promise<Fresh>) {
    const user = userEvent.setup();
    actions.createTransferPair.mockRejectedValueOnce(new CardStatementChangedError());
    // The live props stay STALE at ₹10,000 throughout — only the fresh read knows better.
    renderCardBill(gateOf(readinessOf(10000, [])), {
      initialAmount: 10000,
      statementIntent: { accountId: "octane", statementId: "stmt-A", remaining: 10000 },
      onRefreshBill,
    });
    await user.click(screen.getByRole("button", { name: /pay ₹10,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    return user;
  }

  it("A + B. the fresh read says ₹6,000 although the live feed still says ₹10,000 → ₹6,000 shown; nothing submitted", async () => {
    const onRefreshBill = vi.fn(async () => ({ accountId: "octane", statementId: "stmt-A", remaining: 6000 }));
    const user = await staleThenRefresh(onRefreshBill);
    await user.click(screen.getByRole("button", { name: "Refresh bill" }));
    await waitFor(() => expect(amountInput().value).toBe("6000"));
    expect(onRefreshBill).toHaveBeenCalledWith("octane");
    await new Promise((r) => setTimeout(r, 30));
    expect(actions.createTransferPair).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /pay ₹6,000/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(2));
    expect(actions.createTransferPair.mock.calls[1][0]).toMatchObject({ amount: 6000, cardStatementIntent: { statementId: "stmt-A" } });
  });

  it("D. the opened statement was paid in full elsewhere → the next statement is NOT pre-filled with the old amount; the user must enter one", async () => {
    const user = await staleThenRefresh(async () => ({ accountId: "octane", statementId: "stmt-B", remaining: 27170 }));
    await user.click(screen.getByRole("button", { name: "Refresh bill" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already paid\. The next statement is shown/));
    expect(amountInput().value).toBe("");
    expect(actions.createTransferPair).toHaveBeenCalledTimes(1);
  });

  it("G. refresh failure: clear message, amount kept, nothing saved, Refresh still offered", async () => {
    const user = await staleThenRefresh(async () => {
      throw new Error("offline");
    });
    await user.click(screen.getByRole("button", { name: "Refresh bill" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't refresh this bill\. Nothing was changed\./));
    expect(amountInput().value).toBe("10000");
    expect(screen.getByRole("button", { name: "Refresh bill" })).toBeTruthy();
    expect(actions.createTransferPair).toHaveBeenCalledTimes(1);
  });

  it("H. repeated Refresh clicks while the read is running → one read, button busy, no payment", async () => {
    let resolve!: (v: Fresh) => void;
    const onRefreshBill = vi.fn(() => new Promise<Fresh>((r) => (resolve = r)));
    const user = await staleThenRefresh(onRefreshBill);
    const button = screen.getByRole("button", { name: "Refresh bill" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: /refreshing/i }));
    expect(onRefreshBill).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: /refreshing/i }) as HTMLButtonElement).disabled).toBe(true);
    resolve({ accountId: "octane", statementId: "stmt-A", remaining: 6000 });
    await waitFor(() => expect(amountInput().value).toBe("6000"));
    expect(actions.createTransferPair).toHaveBeenCalledTimes(1);
    void user;
  });
});
