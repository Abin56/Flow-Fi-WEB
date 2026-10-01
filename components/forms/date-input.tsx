"use client";

import * as React from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";

/** `yyyy-mm-dd` (the value every date field in the app stores) -> `dd/mm/yyyy`; "" for anything else. */
export function isoToDisplayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** `dd/mm/yyyy` -> `yyyy-mm-dd`; "" when incomplete or not a real calendar date. */
export function displayToIsoDate(text: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!m) return "";
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const probe = new Date(year, month - 1, day);
  if (year < 1000 || probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Keeps digits only and re-inserts the slashes as the user types: "05102026" -> "05/10/2026". */
function maskDateText(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export type DateInputProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max"
> & {
  /** `yyyy-mm-dd`, or "" when empty — the same value an `<input type="date">` uses. */
  value: string;
  /** Called with `{ target: { value } }` (so existing `e.target.value` handlers keep working); `value` is a valid
   *  `yyyy-mm-dd` date, or "" while the text is incomplete / not a real date / outside min-max. */
  onChange: (event: { target: { value: string } }) => void;
  /** `yyyy-mm-dd` bounds, like the native input's. */
  min?: string;
  max?: string;
  /** Classes for the wrapper `div` — use for flex/grid sizing (`flex-1`, `min-w-0`), since `className` styles the field itself. */
  wrapperClassName?: string;
};

/**
 * A date field that shows and accepts **dd/mm/yyyy** whatever the browser's locale is (a native
 * `<input type="date">` follows the browser/OS locale, which is month-first for en-US). Drop-in for
 * `<input type="date">`: same `yyyy-mm-dd` value, `min`/`max`, `disabled`, `ref` (the text field), and
 * the calendar icon opens the browser's native date picker.
 */
export function DateInput({ value, onChange, min, max, className, wrapperClassName, disabled, placeholder = "dd/mm/yyyy", ...props }: DateInputProps) {
  const pickerRef = React.useRef<HTMLInputElement>(null);
  const [text, setText] = React.useState(() => isoToDisplayDate(value));
  const [previousValue, setPreviousValue] = React.useState(value);

  // An outside change (form reset, a date picked in the calendar, an edit dialog loading its record)
  // replaces what's shown — but never while the text already parses to the current value, so
  // half-typed text isn't overwritten by the "" emitted for it.
  if (value !== previousValue) {
    setPreviousValue(value);
    if (displayToIsoDate(text) !== value) setText(isoToDisplayDate(value));
  }

  const inRange = (iso: string) => (min == null || iso >= min) && (max == null || iso <= max);
  const parsed = displayToIsoDate(text);
  const invalid = text.length === 10 && (parsed === "" || !inRange(parsed));

  function handleText(raw: string) {
    const masked = maskDateText(raw);
    setText(masked);
    const iso = displayToIsoDate(masked);
    onChange({ target: { value: iso !== "" && inRange(iso) ? iso : "" } });
  }

  function openPicker() {
    const picker = pickerRef.current;
    if (!picker || disabled) return;
    if (typeof picker.showPicker === "function") picker.showPicker();
    else picker.click();
  }

  return (
    <div className={cn("relative", wrapperClassName)}>
      <input
        {...props}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={10}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={props["aria-invalid"] ?? (invalid || undefined)}
        value={text}
        onChange={(e) => handleText(e.target.value)}
        className={cn("w-full", className, "pr-9")}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label="Open calendar"
        // Keeps focus (and a blur-to-commit handler) on the text field while the calendar opens.
        onMouseDown={(e) => e.preventDefault()}
        onClick={openPicker}
        className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors outline-none hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <CalendarDays className="size-4" strokeWidth={1.75} />
      </button>
      {/* The browser's own calendar, never shown as a field — only its picker is used. Its date is yyyy-mm-dd. */}
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        min={min}
        max={max}
        value={parsed}
        onChange={(e) => {
          setText(isoToDisplayDate(e.target.value));
          onChange({ target: { value: e.target.value } });
        }}
        className="pointer-events-none absolute right-0 bottom-0 size-0 opacity-0"
      />
    </div>
  );
}
