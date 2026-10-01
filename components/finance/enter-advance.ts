import type { KeyboardEvent } from "react";

const SKIPPED_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "hidden", "image"]);

const FIELD_SELECTOR = 'input, [role="combobox"]';

function isVisible(el: HTMLElement) {
  return el.getClientRects().length > 0;
}

/** Fields the Enter key can walk through: enabled, visible single-line inputs and dropdown triggers. */
function isNavigableField(el: HTMLElement) {
  if (el instanceof HTMLInputElement) {
    if (SKIPPED_INPUT_TYPES.has(el.type) || el.disabled || el.readOnly || el.tabIndex < 0) return false;
  } else if (el.getAttribute("role") === "combobox") {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
  } else {
    return false;
  }
  return isVisible(el);
}

function isEmpty(el: HTMLElement) {
  if (el instanceof HTMLInputElement) return el.value.trim() === "";
  // Radix Select trigger shows its placeholder (and sets data-placeholder) until a value is picked.
  return el.hasAttribute("data-placeholder");
}

/**
 * `onKeyDown` for a data-entry `<form>`: Enter in a single-line field jumps to the next *blank* field after it;
 * when no blank field is left, Enter submits the form (the same guarded path as the Save button).
 * Textareas keep Enter as a newline, buttons and dropdown triggers keep their own Enter, and a held-down key
 * or IME composition never advances/submits.
 */
export function handleEnterAdvance(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Enter" || event.defaultPrevented) return;
  if (event.repeat || event.nativeEvent.isComposing) return;
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;

  const form = event.currentTarget;
  const target = event.target;
  // Only text-like <input>s inside this form's DOM (React events also bubble out of portalled popups).
  if (!(target instanceof HTMLInputElement) || !form.contains(target) || !isNavigableField(target)) return;

  const fields = Array.from(form.querySelectorAll<HTMLElement>(FIELD_SELECTOR)).filter(isNavigableField);
  const next = fields.slice(fields.indexOf(target) + 1).find(isEmpty);

  event.preventDefault(); // we decide: move on, or submit exactly once
  if (next) {
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
    return;
  }
  form.requestSubmit();
}
