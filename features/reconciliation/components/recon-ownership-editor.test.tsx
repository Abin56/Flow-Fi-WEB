// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconOwnershipEditor } from "./recon-ownership-editor";
import { reconRow } from "../lib/test-fixtures";
import type { RowOwnership } from "../lib/types";

afterEach(cleanup);

const PEOPLE = [
  { id: "p-ravi", name: "Ravi" },
  { id: "p-asha", name: "Asha" },
];
const row = reconRow({ id: "r1", amount: 1000 });

function Harness({ start = null, onChange = () => {} }: { start?: RowOwnership | null; onChange?: (o: RowOwnership | null) => void }) {
  const [ownership, setOwnership] = useState<RowOwnership | null>(start);
  return (
    <ReconOwnershipEditor
      row={row}
      ownership={ownership}
      people={PEOPLE}
      onChange={(next) => {
        setOwnership(next);
        onChange(next);
      }}
    />
  );
}

const split = (overrides: Partial<Extract<RowOwnership, { kind: "split" }>> = {}): RowOwnership => ({
  kind: "split",
  splitType: "custom",
  shares: [
    { id: "me", personId: null, name: "Me", isMe: true, amount: "400" },
    { id: "a", personId: null, name: "Newcomer", isMe: false, amount: "400" },
  ],
  ...overrides,
});

describe("ReconOwnershipEditor", () => {
  it("is Mine by default and shows no allocation controls", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "My own expense" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("ownership-split")).toBeNull();
    expect(screen.queryByTestId("ownership-person")).toBeNull();
  });

  it("choosing Split starts a draft with me and one other row; going back to Mine clears it", () => {
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    fireEvent.click(screen.getByRole("radio", { name: "Split expense" }));
    expect(screen.getAllByTestId("split-share")).toHaveLength(2);
    expect(seen.mock.calls.at(-1)![0]).toMatchObject({ kind: "split", splitType: "equal" });
    fireEvent.click(screen.getByRole("radio", { name: "My own expense" }));
    expect(seen.mock.calls.at(-1)![0]).toBeNull();
    expect(screen.queryByTestId("ownership-split")).toBeNull();
  });

  it("says what is left to assign, in words, and clears it once the amounts add up", () => {
    render(<Harness start={split()} />);
    expect(screen.getByTestId("split-left").textContent).toBe("₹200.00 left to assign");
    expect(screen.getByTestId("ownership-errors").textContent).toMatch(/₹200\.00 left to assign — the amounts must add up to ₹1,000\.00/);
    fireEvent.change(screen.getByLabelText("My share"), { target: { value: "600" } });
    expect(screen.getByTestId("split-left").textContent).toBe("₹1,000.00 fully assigned");
    expect(screen.queryByTestId("ownership-errors")).toBeNull();
  });

  it("'The rest' gives me whatever the other amounts leave", () => {
    render(<Harness start={split()} />);
    fireEvent.click(screen.getByRole("button", { name: "The rest" }));
    expect((screen.getByLabelText("My share") as HTMLInputElement).value).toBe("600.00");
    expect(screen.queryByTestId("ownership-errors")).toBeNull();
  });

  it("refuses a typed name that is already in People, or typed twice, right beside the allocation", () => {
    render(
      <Harness
        start={split({
          splitType: "equal",
          shares: [
            { id: "me", personId: null, name: "Me", isMe: true, amount: "" },
            { id: "a", personId: null, name: "ravi", isMe: false, amount: "" },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("ownership-errors").textContent).toMatch(/ravi is already in People/);
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(screen.getAllByTestId("split-share")).toHaveLength(3);
  });

  it("equal shares are shown per person and always add up to the amount", () => {
    render(
      <Harness
        start={split({
          splitType: "equal",
          shares: [
            { id: "me", personId: null, name: "Me", isMe: true, amount: "" },
            { id: "a", personId: null, name: "Newcomer", isMe: false, amount: "" },
            { id: "b", personId: null, name: "Other", isMe: false, amount: "" },
          ],
        })}
      />,
    );
    const shown = screen.getAllByTestId("split-share").map((li) => within(li).getByLabelText(/share$/).textContent);
    expect(shown).toEqual(["₹333.33", "₹333.33", "₹333.34"]);
    expect(screen.queryByTestId("ownership-errors")).toBeNull();
  });

  it("a person row can be removed, but the last other person leaves the split needing one", () => {
    render(<Harness start={split()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Newcomer" }));
    expect(screen.getAllByTestId("split-share")).toHaveLength(1);
    expect(screen.getByTestId("ownership-errors").textContent).toMatch(/at least one other person/);
  });

  it("a credit cannot be assigned", () => {
    render(<ReconOwnershipEditor row={reconRow({ id: "c", direction: "credit", amount: 100 })} ownership={split()} people={PEOPLE} onChange={() => {}} />);
    expect(screen.getByTestId("ownership-errors").textContent).toMatch(/Only expenses/);
  });
});

describe("ReconOwnershipEditor — repeated problems", () => {
  it("two empty person rows say it once, with no duplicate-key warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Harness
        start={split({
          splitType: "equal",
          shares: [
            { id: "me", personId: null, name: "Me", isMe: true, amount: "" },
            { id: "a", personId: null, name: "", isMe: false, amount: "" },
            { id: "b", personId: null, name: "", isMe: false, amount: "" },
          ],
        })}
      />,
    );
    expect(within(screen.getByTestId("ownership-errors")).getAllByText("Choose a person, or type a name.")).toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    warn.mockRestore();
  });
});
