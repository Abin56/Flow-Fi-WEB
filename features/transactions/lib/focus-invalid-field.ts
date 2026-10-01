/** Add/Edit Transaction form fields that can block a save, in the form's visual (top-to-bottom) order.
 *  Validation reports the FIRST of these that is invalid, so a submit always lands on the topmost problem. */
export type TxnFormField = "amount" | "description" | "category" | "date" | "account" | "destination" | "personDirection" | "split";

export type TxnValidationError = { field: TxnFormField; message: string };

const FOCUSABLE = [
  '[role="radio"][tabindex="0"]',
  "input:not([disabled]):not([type=hidden])",
  '[role="combobox"]:not([disabled])',
  "textarea:not([disabled])",
  "button:not([disabled])",
].join(", ");

/**
 * Brings the invalid field (`[data-field="<field>"]` inside `root`) into view and puts keyboard focus in it,
 * so the user can type/choose immediately. `block: "center"` scrolls inside the form's own scroll area, which
 * keeps the field clear of the dialog's fixed header/footer; focus uses `preventScroll` so it can't fight the
 * smooth scroll with a jump. Returns the element that received focus (or null when the field isn't rendered).
 */
export function focusInvalidField(root: ParentNode | null | undefined, field: TxnFormField): HTMLElement | null {
  const wrapper = root?.querySelector<HTMLElement>(`[data-field="${field}"]`);
  if (!wrapper) return null;
  wrapper.scrollIntoView?.({ behavior: "smooth", block: "center" });
  const target = wrapper.matches(FOCUSABLE) ? wrapper : wrapper.querySelector<HTMLElement>(FOCUSABLE);
  if (!target) return null;
  target.focus({ preventScroll: true });
  return target;
}
