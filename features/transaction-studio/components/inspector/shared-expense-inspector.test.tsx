// @vitest-environment jsdom
/**
 * H1: the split editor never saves the same person twice — picked from People and typed again as a custom name.
 * Synthetic data, no repositories.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { Person } from "@/lib/models/person";
import type { GridRow } from "../../lib/grid-types";
import { SharedExpenseInspector } from "./shared-expense-inspector";

afterEach(cleanup);

const people = [
  { id: "p-ravi", name: "Ravi" },
  { id: "p-anu", name: "Anu" },
] as Person[];
const row = {
  id: "1",
  amount: 1000,
  actionDetail: {
    kind: "shared_expense",
    splitType: "custom",
    participants: [
      { personId: null, name: "Me", share: 500, isMe: true },
      { personId: "p-ravi", name: "Ravi", share: 500, isMe: false },
    ],
  },
} as unknown as GridRow;

function renderEditor() {
  const onCommit = vi.fn();
  render(<SharedExpenseInspector row={row} people={people} onCommit={onCommit} onClose={() => undefined} />);
  return onCommit;
}

describe("SharedExpenseInspector — one person, one row", () => {
  it("typing a picked person's name as a new row shows the error and never commits that split", () => {
    const onCommit = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    const committedBefore = onCommit.mock.calls.length;
    const names = screen.getAllByPlaceholderText("Name");
    fireEvent.change(names[names.length - 1], { target: { value: "ravi" } });

    expect(screen.getByText(/ravi is already in this split/)).toBeTruthy();
    expect(onCommit.mock.calls.length).toBe(committedBefore);
    for (const [participants] of onCommit.mock.calls) {
      const ravis = participants.filter((p: { personId: string | null; name: string }) => p.personId === "p-ravi" || p.name.trim().toLowerCase() === "ravi");
      expect(ravis.length).toBeLessThanOrEqual(1);
    }
  });

  it("the quick-add chips leave out people already picked or already typed", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: /^Ravi$/ })).toBeNull(); // picked
    expect(screen.getByRole("button", { name: /Anu/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    const names = screen.getAllByPlaceholderText("Name");
    fireEvent.change(names[names.length - 1], { target: { value: "Anu" } });
    expect(screen.queryByRole("button", { name: /^\s*Anu\s*$/ })).toBeNull(); // typed
  });

  it("a valid split with a new typed name still commits", () => {
    const onCommit = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    const names = screen.getAllByPlaceholderText("Name");
    fireEvent.change(names[names.length - 1], { target: { value: "Sam" } });
    const last = onCommit.mock.calls.at(-1)![0] as { name: string }[];
    expect(last.map((p) => p.name)).toEqual(["Me", "Ravi", "Sam"]);
    expect(screen.queryByText(/already in this split/)).toBeNull();
  });
});
