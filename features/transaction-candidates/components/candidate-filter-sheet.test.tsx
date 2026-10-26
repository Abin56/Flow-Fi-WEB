// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFilterChips } from "../lib/candidate-filter-chips";
import { DEFAULT_CANDIDATE_FILTERS, UNMATCHED_ACCOUNT_KEY, type CandidateFilters } from "../lib/filters";
import { CandidateFilterSheet } from "./candidate-filter-sheet";
import { CandidateToolbar } from "./candidate-toolbar";

beforeAll(() => {
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

const options = { months: ["2026-10", "2026-09"], accounts: [{ key: "account:a1", label: "HDFC Savings •••• 4821" }, { key: "card:c1", label: "ICICI Card •••• 9981" }] };

function open(applied: CandidateFilters = DEFAULT_CANDIDATE_FILTERS, previewCount: (f: CandidateFilters) => number = () => 5) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  render(<CandidateFilterSheet open onOpenChange={onOpenChange} applied={applied} appliedSort="newest" options={options} previewCount={previewCount} onApply={onApply} />);
  return { onApply, onOpenChange, dialog: screen.getByRole("dialog", { name: "Filters" }) };
}

describe("CandidateFilterSheet", () => {
  it("applies nothing until Apply, then hands over exactly the draft", () => {
    const { onApply, dialog } = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Credit" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Low" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Unmatched/ }));
    fireEvent.change(within(dialog).getByLabelText("Minimum"), { target: { value: "₹1,000" } });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId("apply-filters"));
    expect(onApply).toHaveBeenCalledTimes(1);
    const [filters, sort] = onApply.mock.calls[0];
    expect(filters).toEqual({ ...DEFAULT_CANDIDATE_FILTERS, direction: "credit", confidence: ["low"], accountKeys: [UNMATCHED_ACCOUNT_KEY], minAmount: 1000 });
    expect(sort).toBe("newest");
  });

  it("starts from the applied filters each time it opens", () => {
    const applied: CandidateFilters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "debit", minAmount: 250, accountKeys: ["card:c1"] };
    const { dialog } = open(applied);
    expect(within(dialog).getByRole("button", { name: "Debit" }).getAttribute("aria-pressed")).toBe("true");
    expect((within(dialog).getByLabelText("Minimum") as HTMLInputElement).value).toBe("250");
    expect(within(dialog).getByRole("button", { name: /ICICI Card/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: /HDFC Savings/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("previews how many rows the draft would list on the Apply button", () => {
    const previewCount = vi.fn((f: CandidateFilters) => (f.direction === "credit" ? 1 : f.direction === "debit" ? 0 : 12));
    const { dialog } = open(DEFAULT_CANDIDATE_FILTERS, previewCount);
    const apply = within(dialog).getByTestId("apply-filters");
    expect(apply.textContent).toBe("Show 12 results");
    fireEvent.click(within(dialog).getByRole("button", { name: "Credit" }));
    expect(apply.textContent).toBe("Show 1 result");
    fireEvent.click(within(dialog).getByRole("button", { name: "Debit" }));
    expect(apply.textContent).toBe("Apply — no matches");
  });

  it("refuses an impossible amount range or date range, and says why", () => {
    const { onApply, dialog } = open();
    fireEvent.change(within(dialog).getByLabelText("Minimum"), { target: { value: "900" } });
    fireEvent.change(within(dialog).getByLabelText("Maximum"), { target: { value: "100" } });
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Minimum can't be more than the maximum/);
    const apply = within(dialog).getByTestId("apply-filters") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(onApply).not.toHaveBeenCalled();
    // Not a number at all.
    fireEvent.change(within(dialog).getByLabelText("Minimum"), { target: { value: "abc" } });
    expect(within(dialog).getByRole("alert").textContent).toMatch(/plain numbers/);
    expect(apply.disabled).toBe(true);
    // Fixing it re-enables Apply.
    fireEvent.change(within(dialog).getByLabelText("Minimum"), { target: { value: "50" } });
    expect(apply.disabled).toBe(false);
  });

  it("Clear all resets the draft to the defaults (and only then Apply changes anything)", () => {
    const applied: CandidateFilters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "credit", confidence: ["low"], minAmount: 10 };
    const { onApply, dialog } = open(applied);
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" }));
    expect((within(dialog).getByLabelText("Minimum") as HTMLInputElement).value).toBe("");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId("apply-filters"));
    expect(onApply.mock.calls[0][0]).toEqual(DEFAULT_CANDIDATE_FILTERS);
  });

  it("the close button discards the draft", () => {
    const { onApply, onOpenChange, dialog } = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Credit" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close filters" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe("CandidateToolbar", () => {
  const base = {
    searchText: "",
    onSearchChange: () => {},
    compact: false,
    months: ["2026-10"],
    month: null,
    onMonth: () => {},
    direction: null,
    onDirection: () => {},
    sortKey: "newest" as const,
    onSort: () => {},
    activeFilterCount: 0,
    onOpenFilters: () => {},
    chips: [],
    onRemoveChip: () => {},
    canClearAll: false,
    onClearAll: () => {},
  };

  it("shows the count on the Filters button only when something is active", () => {
    const { rerender } = render(<CandidateToolbar {...base} />);
    expect(screen.queryByTestId("active-filter-count")).toBeNull();
    rerender(<CandidateToolbar {...base} activeFilterCount={3} />);
    expect(screen.getByTestId("active-filter-count").textContent).toMatch(/^3/);
  });

  it("folds the quick filters away on a compact workspace, leaving search + Filters", () => {
    render(<CandidateToolbar {...base} compact />);
    expect(screen.queryByRole("group", { name: "Filter by direction" })).toBeNull();
    expect(screen.getByLabelText("Search candidates")).toBeTruthy();
    expect(screen.getByTestId("open-filters")).toBeTruthy();
  });

  it("renders removable chips with a clear name for each remove button, and Clear filters", () => {
    const filters: CandidateFilters = { ...DEFAULT_CANDIDATE_FILTERS, direction: "credit", accountKeys: ["account:a1"] };
    const chips = buildFilterChips(filters, (k) => options.accounts.find((a) => a.key === k)?.label ?? k);
    const onRemoveChip = vi.fn();
    const onClearAll = vi.fn();
    render(<CandidateToolbar {...base} chips={chips} onRemoveChip={onRemoveChip} canClearAll onClearAll={onClearAll} />);
    const list = screen.getByRole("list", { name: "Active filters" });
    fireEvent.click(within(list).getByRole("button", { name: "Remove filter: HDFC Savings •••• 4821" }));
    expect(onRemoveChip).toHaveBeenCalledWith(expect.objectContaining({ id: "acct:account:a1" }));
    fireEvent.click(within(list).getByRole("button", { name: "Clear filters" }));
    expect(onClearAll).toHaveBeenCalled();
  });
});
