import type { KeyboardEvent } from "react";

/** Controls that own the Enter key themselves: multi-line text, pickers/menus, and anything marked `data-enter-skip`. */
const OWNS_ENTER = 'textarea, select, [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [contenteditable="true"], [data-enter-skip]';

interface EnterKeyOptions {
  /** When false (nothing valid to confirm yet — a disabled button, a delete still waiting for its typed name), Enter does nothing. */
  enabled?: boolean;
  /**
   * Whether Enter still fires `run` when a button or link has focus. A confirm/delete dialog opens with focus on
   * Cancel, and Enter there should still confirm (`true`); inside a form, Enter on a button should keep doing that
   * button's own job (`false`, the default).
   */
  fromButtons?: boolean;
}

/**
 * The one "Enter finishes this" rule for dialogs and panels that aren't a real `<form>` — call it from an
 * `onKeyDown`. It acts on a plain Enter only: not a held-down key (so the Enter that opened a delete dialog
 * can't also confirm it), not Shift+Enter, not mid-IME composition, not Enter that something inside already
 * handled, not Enter from content portalled out of `currentTarget` (select lists, popovers), and not from
 * controls that need Enter themselves (textareas, comboboxes, menus).
 *
 * Returns whether it ran `run`.
 */
export function handleEnterKey(event: KeyboardEvent<HTMLElement>, run: () => unknown, options: EnterKeyOptions = {}): boolean {
  const { enabled = true, fromButtons = false } = options;
  if (event.key !== "Enter" || event.repeat || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.defaultPrevented) return false;
  const target = event.target as HTMLElement;
  if (!event.currentTarget.contains(target)) return false;
  if (target.closest(OWNS_ENTER)) return false;
  // Radio / checkbox / switch controls don't use Enter themselves, so finishing the form from one works like it does
  // in a native form; real buttons, links and tabs keep their own Enter behaviour (unless `fromButtons`).
  const onControl = target.closest('[role="radio"], [role="checkbox"], [role="switch"]') ? null : target.closest('button, a[href], [role="button"], [role="tab"]');
  if (onControl && (!fromButtons || onControl.getAttribute("data-slot") === "dialog-close")) return false;
  if (!enabled) return false;
  event.preventDefault();
  void run();
  return true;
}
