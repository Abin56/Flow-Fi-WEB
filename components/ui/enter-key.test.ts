import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { handleEnterKey } from "./enter-key";

type Kind = "input" | "textarea" | "button" | "radio" | "combobox" | "close";

/** A stand-in for the focused element: `closest(selector)` answers for whichever kind of control it is. */
function fakeTarget(kind: Kind) {
  const needle: Record<Kind, string> = { input: "<none>", textarea: "textarea", button: "button", radio: 'role="radio"', combobox: 'role="combobox"', close: "button" };
  const el = {
    closest: (selector: string) => (selector.includes(needle[kind]) ? el : null),
    getAttribute: (name: string) => (kind === "close" && name === "data-slot" ? "dialog-close" : null),
  };
  return el;
}

function fakeEvent(kind: Kind, overrides: Record<string, unknown> = {}) {
  const preventDefault = vi.fn();
  const event = {
    key: "Enter",
    repeat: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    target: fakeTarget(kind),
    currentTarget: { contains: () => true },
    preventDefault,
    ...overrides,
  };
  return { event: event as unknown as KeyboardEvent<HTMLElement>, preventDefault };
}

describe("handleEnterKey", () => {
  it("runs the action for Enter in a single-line field, and stops the browser's own Enter", () => {
    const run = vi.fn();
    const { event, preventDefault } = fakeEvent("input");
    expect(handleEnterKey(event, run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("ignores other keys, held-down Enter, Shift/Alt+Enter, IME composition and Enter something already handled", () => {
    for (const overrides of [{ key: "a" }, { repeat: true }, { shiftKey: true }, { altKey: true }, { nativeEvent: { isComposing: true } }, { defaultPrevented: true }]) {
      const run = vi.fn();
      expect(handleEnterKey(fakeEvent("input", overrides).event, run)).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("leaves Enter alone in textareas and comboboxes, and for content portalled outside the dialog", () => {
    for (const kind of ["textarea", "combobox"] as Kind[]) {
      const run = vi.fn();
      expect(handleEnterKey(fakeEvent(kind).event, run)).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }
    const run = vi.fn();
    expect(handleEnterKey(fakeEvent("input", { currentTarget: { contains: () => false } }).event, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing while disabled (e.g. a delete still waiting for its typed name)", () => {
    const run = vi.fn();
    expect(handleEnterKey(fakeEvent("input").event, run, { enabled: false })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a focused button's own Enter in forms, but confirms from Cancel in a confirm dialog (not from the X)", () => {
    const formRun = vi.fn();
    expect(handleEnterKey(fakeEvent("button").event, formRun)).toBe(false);
    expect(formRun).not.toHaveBeenCalled();

    const dialogRun = vi.fn();
    expect(handleEnterKey(fakeEvent("button").event, dialogRun, { fromButtons: true })).toBe(true);
    expect(dialogRun).toHaveBeenCalledTimes(1);

    const closeRun = vi.fn();
    expect(handleEnterKey(fakeEvent("close").event, closeRun, { fromButtons: true })).toBe(false);
    expect(closeRun).not.toHaveBeenCalled();
  });

  it("finishes the form from a radio/checkbox/switch, which don't use Enter themselves", () => {
    const run = vi.fn();
    expect(handleEnterKey(fakeEvent("radio").event, run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
