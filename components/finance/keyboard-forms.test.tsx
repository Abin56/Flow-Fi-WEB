// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClayButton } from "@/components/clay/clay-button";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "./confirm-dialog";
import { FormDialog } from "./form-dialog";
import { SectionedFormDialog } from "./sectioned-form-dialog";

/**
 * Keyboard contract for FlowFi's shared create/edit/confirm dialogs — every Add/Edit flow built on
 * FormDialog / SectionedFormDialog (bills, budgets, savings, loans & EMIs, loan payments, statement import,
 * split expense) and every delete built on ConfirmDialog inherits exactly this behavior.
 */

beforeAll(() => {
  // Radix Select / Dialog touch layout APIs jsdom doesn't implement.
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

type Saved = { amount: string; description: string; notes: string; category: string; date: string };

/** A representative Add/Edit Transaction-style form: the dialog's onConfirm runs the page's validated save. */
function TransactionFormHarness({
  save,
  initial,
  Dialog = FormDialog,
}: {
  save: (values: Saved) => Promise<void> | void;
  initial?: Partial<Saved>;
  Dialog?: typeof FormDialog;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState<Saved>({ amount: "", description: "", notes: "", category: "food", date: "2026-10-01", ...initial });

  async function onConfirm() {
    // Page-level validation — Enter must not bypass it.
    if (!v.amount || !v.description) {
      setError("Amount and description are required");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await save(v);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <input aria-label="Search transactions" />
      <ClayButton onClick={() => setOpen(true)}>{initial ? "Edit transaction" : "Add transaction"}</ClayButton>
      <Dialog open={open} onOpenChange={setOpen} title="Transaction" onConfirm={onConfirm} loading={loading} confirmLabel="Save">
        <label>
          Amount
          <input value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
        </label>
        <label>
          Description
          <input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </label>
        <Select value={v.category} onValueChange={(category) => setV({ ...v, category })}>
          <SelectTrigger aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="food">Food</SelectItem>
            <SelectItem value="rent">Rent</SelectItem>
            <SelectItem value="travel">Travel</SelectItem>
          </SelectContent>
        </Select>
        <label>
          Date
          <input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
        </label>
        <label>
          Notes
          <textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </label>
        {/* A helper button inside the form (chip / "add person") must never submit it. */}
        <ClayButton onClick={() => setV({ ...v, amount: "100" })}>Quick ₹100</ClayButton>
        {error && <p role="alert">{error}</p>}
      </Dialog>
    </>
  );
}

async function openForm(user: ReturnType<typeof userEvent.setup>, label = "Add transaction") {
  const trigger = screen.getByRole("button", { name: label });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog");
  return trigger;
}

describe.each([
  ["FormDialog", FormDialog],
  ["SectionedFormDialog", SectionedFormDialog as typeof FormDialog],
])("%s keyboard behavior", (_name, Dialog) => {
  it("A. ADD — Tab through the form, Enter in a field saves exactly one record", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} />);
    await openForm(user);

    // Focus moved into the dialog: first field.
    expect(document.activeElement).toBe(screen.getByLabelText("Amount"));
    await user.keyboard("250");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Description"));
    await user.keyboard("Coffee{Enter}");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ amount: "250", description: "Coffee" }));
  });

  it("A. validation still applies — Enter with a missing required field does not save", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} />);
    await openForm(user);
    await user.keyboard("250{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("required");
    expect(save).not.toHaveBeenCalled();
  });

  it("B. EDIT — Enter runs the same update path (one call, edited values)", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} initial={{ amount: "80", description: "Lunch" }} />);
    await openForm(user, "Edit transaction");
    await user.tab(); // → Description
    await user.clear(screen.getByLabelText("Description"));
    await user.keyboard("Team lunch{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ amount: "80", description: "Team lunch" }));
  });

  it("H. TEXTAREA — Enter inserts a newline and does not submit", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} initial={{ amount: "1", description: "x" }} />);
    await openForm(user, "Edit transaction");
    const notes = screen.getByLabelText("Notes");
    notes.focus();
    await user.keyboard("line one{Enter}line two");
    expect(notes).toHaveProperty("value", "line one\nline two");
    expect(save).not.toHaveBeenCalled();
  });

  it("I. DROPDOWN — Enter opens the select and Enter picks an option without submitting", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} initial={{ amount: "1", description: "x" }} />);
    await openForm(user, "Edit transaction");
    screen.getByRole("combobox", { name: "Category" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("combobox", { name: "Category" }).textContent).toContain("Rent");
    expect(save).not.toHaveBeenCalled();
    // …and the dialog is still open for the rest of the form.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("helper buttons inside the form never submit it", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} initial={{ description: "x" }} />);
    await openForm(user, "Edit transaction");
    screen.getByRole("button", { name: "Quick ₹100" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Amount")).toHaveProperty("value", "100");
    expect(save).not.toHaveBeenCalled();
  });

  it("J. DOUBLE SUBMIT — rapid Enter, and Enter + click, save once while the save is in flight", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<TransactionFormHarness save={save} Dialog={Dialog} initial={{ amount: "5", description: "Tea" }} />);
    await openForm(user, "Edit transaction");
    screen.getByLabelText("Description").focus();
    await user.keyboard("{Enter}{Enter}{Enter}");
    await user.click(screen.getByRole("button", { name: /Sav/ }));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("K. TAB ORDER — fields follow visual order and end on Cancel → Save", async () => {
    const user = userEvent.setup();
    render(<TransactionFormHarness save={vi.fn()} Dialog={Dialog} initial={{ amount: "1", description: "x" }} />);
    await openForm(user, "Edit transaction");
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      const el = document.activeElement as HTMLElement;
      order.push(el.getAttribute("aria-label") ?? el.closest("label")?.textContent?.split(/\s/)[0] ?? el.textContent ?? "");
      await user.tab();
    }
    expect(order.slice(0, 8)).toEqual(["Amount", "Description", "Category", "Date", "Notes", "Quick ₹100", "Cancel", "Save"]);
    // Shift+Tab walks back.
    await user.tab({ shift: true });
    expect(document.activeElement?.textContent).toContain("Save");
  });

  it("L. ESCAPE — closes the dialog, saves nothing, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} />);
    const trigger = await openForm(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("M. FILTERS — Enter in a page search box does not open or submit anything", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<TransactionFormHarness save={save} Dialog={Dialog} />);
    screen.getByLabelText("Search transactions").focus();
    await user.keyboard("coffee{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});

function DeleteHarness({ remove }: { remove: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  return (
    <>
      <Button aria-label="Delete Coffee" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this transaction?"
        variant="destructive"
        confirmLabel="Delete"
        loading={loading}
        onConfirm={async () => {
          setLoading(true);
          await remove();
          setLoading(false);
          setOpen(false);
        }}
      />
    </>
  );
}

describe("C. DELETE — ConfirmDialog keyboard safety", () => {
  it("Enter on the row's Delete opens confirmation; focus starts on Cancel, so Enter again does not delete", async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    render(<DeleteHarness remove={remove} />);
    screen.getByRole("button", { name: "Delete Coffee" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    expect(document.activeElement?.textContent).toContain("Cancel");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("Escape cancels and restores focus to the Delete trigger", async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    render(<DeleteHarness remove={remove} />);
    const trigger = screen.getByRole("button", { name: "Delete Coffee" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("deliberate Tab → Delete → Enter deletes exactly once, even with rapid repeats", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const remove = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<DeleteHarness remove={remove} />);
    screen.getByRole("button", { name: "Delete Coffee" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.tab();
    expect(document.activeElement?.textContent).toContain("Delete");
    await user.keyboard("{Enter}{Enter}{Enter}");
    expect(remove).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("button primitives", () => {
  it("ClayButton and Button default to type=button; submit is opt-in", () => {
    render(
      <form>
        <ClayButton>clay</ClayButton>
        <Button>shad</Button>
        <ClayButton type="submit">go</ClayButton>
      </form>,
    );
    expect(screen.getByRole("button", { name: "clay" })).toHaveProperty("type", "button");
    expect(screen.getByRole("button", { name: "shad" })).toHaveProperty("type", "button");
    expect(screen.getByRole("button", { name: "go" })).toHaveProperty("type", "submit");
  });

  it("N. TABLE ACTIONS — Enter and Space on a focused action run it", async () => {
    const user = userEvent.setup();
    const edit = vi.fn();
    render(
      <Button aria-label="Edit Coffee" onClick={edit}>
        ✎
      </Button>,
    );
    screen.getByRole("button", { name: "Edit Coffee" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(edit).toHaveBeenCalledTimes(2);
  });
});
