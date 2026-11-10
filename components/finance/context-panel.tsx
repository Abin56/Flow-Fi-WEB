"use client";

/**
 * Contextual panels: a floating panel that opens next to what was clicked, without leaving the page.
 *
 * - `ContextPanel`   the shell. Desktop/tablet: a popover anchored to its trigger, flipped/shifted to stay inside the
 *                    viewport, height capped to the room that is actually available. Phone: the same content as a
 *                    bottom sheet. Header and footer stay put; only the body scrolls.
 * - `PanelSection`   a collapsible group (progressive disclosure) with an animated height and a one-line summary.
 * - `PanelOptionList` single-choice rows (category, account…) — compact for a few options, searchable for many.
 * - `StackedRows`    repeating rows (split, add-more, members…): index badge, caller's fields, remove, animated "Add more".
 *
 * Everything is presentational and controlled by the caller; nothing here reads or writes data.
 */

import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

// ---- the shell --------------------------------------------------------------------------------------------------------

const WIDTHS = { sm: "sm:w-[20rem]", md: "sm:w-[26rem]", lg: "sm:w-[34rem]" } as const;

export interface ContextPanelProps {
  /** The element that opens the panel (rendered `asChild`, so pass a button). */
  trigger: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Controlled open state. Omit for uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Footer actions. Omit `onApply` for a panel that applies as you go (it then shows only a Done button). */
  onApply?: () => void;
  applyLabel?: string;
  applyDisabled?: boolean;
  applyLoading?: boolean;
  onCancel?: () => void;
  cancelLabel?: string;
  /** Shown left of the buttons — a total, a validation message… */
  footerNote?: ReactNode;
  /** Close the panel after Apply. Default true. */
  closeOnApply?: boolean;
  width?: keyof typeof WIDTHS;
  /** Clicking outside closes the panel. Turn off for a half-filled form. Default true. */
  dismissOnOutside?: boolean;
  /** Where the popover prefers to open relative to the trigger. */
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  testId?: string;
  className?: string;
}

export function ContextPanel({
  trigger,
  title,
  description,
  children,
  open: openProp,
  onOpenChange,
  onApply,
  applyLabel = "Apply",
  applyDisabled = false,
  applyLoading = false,
  onCancel,
  cancelLabel = "Cancel",
  footerNote,
  closeOnApply = true,
  width = "md",
  dismissOnOutside = true,
  side = "bottom",
  align = "start",
  testId,
  className,
}: ContextPanelProps) {
  const wide = useMediaQuery("(min-width: 640px)");
  const [inner, setInner] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : inner;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  const apply = () => {
    if (applyDisabled || applyLoading) return;
    onApply?.();
    if (closeOnApply) setOpen(false);
  };
  const cancel = () => {
    onCancel?.();
    setOpen(false);
  };
  // Enter in a single-line field applies (the same action as the button); textareas and buttons keep their own Enter.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.defaultPrevented || e.shiftKey || e.nativeEvent.isComposing) return;
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type !== "checkbox" && t.type !== "radio" && !t.closest("[data-no-enter-apply]")) {
      e.preventDefault();
      apply();
    }
  };

  const header = (
    <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Title>{title}</Title>
        <Description className={description ? "text-xs text-muted-foreground" : "sr-only"}>{description ?? title}</Description>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={cancel}
        className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );

  const body = (
    <div data-testid="panel-body" className="@container min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3">
      {children}
    </div>
  );

  const footer = (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-secondary/40 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:pb-2.5">
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">{footerNote}</div>
      {onApply ? (
        <>
          <ClayButton variant="ghost" size="sm" className="h-8 rounded-lg px-3" onClick={cancel}>
            {cancelLabel}
          </ClayButton>
          <ClayButton variant="primary" size="sm" className="h-8 min-w-20 rounded-lg px-4 font-semibold" onClick={apply} disabled={applyDisabled || applyLoading} aria-busy={applyLoading}>
            {applyLabel}
          </ClayButton>
        </>
      ) : (
        <ClayButton variant="primary" size="sm" className="h-8 min-w-20 rounded-lg px-4 font-semibold" onClick={() => setOpen(false)}>
          Done
        </ClayButton>
      )}
    </div>
  );

  if (!wide) {
    return (
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : cancel())}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          showCloseButton={false}
          data-testid={testId}
          data-context-panel="sheet"
          onKeyDown={onKeyDown}
          overlayClassName="bg-black/35"
          className={cn(
            "top-auto bottom-0 left-0 flex max-h-[88dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-[20px] rounded-b-none border border-border bg-popover p-0 ring-0",
            "data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8 duration-200",
            className,
          )}
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong/60" />
          {header}
          {body}
          {footer}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : cancel())} modal={false}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-testid={testId}
          data-context-panel="popover"
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          avoidCollisions
          onKeyDown={onKeyDown}
          onInteractOutside={dismissOnOutside ? undefined : (e) => e.preventDefault()}
          style={{
            // Above dialogs (z 5) so a panel can open from inside one; below nested Select/Popover menus (z-50).
            zIndex: 45,
            maxHeight: "min(36rem, var(--radix-popover-content-available-height))",
            boxShadow: "var(--shadow-e3), 0 24px 48px -28px rgba(10,12,8,0.45)",
          }}
          className={cn(
            "flex w-[min(var(--radix-popover-content-available-width),calc(100vw-1.5rem))] origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            "duration-150 motion-reduce:animate-none",
            WIDTHS[width],
            className,
          )}
        >
          {header}
          {body}
          {footer}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// Dialog parts only exist in the sheet; the popover uses plain elements with the same accessible names.
function Title({ children }: { children: ReactNode }) {
  const wide = useMediaQuery("(min-width: 640px)");
  const cls = "truncate font-heading text-sm leading-tight font-semibold tracking-tight";
  return wide ? <h2 className={cls}>{children}</h2> : <DialogTitle className={cls}>{children}</DialogTitle>;
}
function Description({ children, className }: { children: ReactNode; className?: string }) {
  const wide = useMediaQuery("(min-width: 640px)");
  return wide ? <p className={className}>{children}</p> : <DialogDescription className={className}>{children}</DialogDescription>;
}

// ---- progressive disclosure -----------------------------------------------------------------------------------------------

/** A collapsible group. `summary` is the one-line recap shown while collapsed (e.g. "3 selected"). */
export function PanelSection({
  title,
  summary,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  children,
  className,
}: {
  title: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const id = useId();
  const toggle = () => {
    if (openProp === undefined) setInner(!open);
    onOpenChange?.(!open);
  };
  return (
    <section className={cn("rounded-xl border border-border bg-card", className)} data-state={open ? "open" : "closed"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
        {!open && summary != null && <span className="max-w-[55%] truncate text-xs text-muted-foreground">{summary}</span>}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} strokeWidth={1.75} />
      </button>
      {/* grid-rows 0fr→1fr animates to the content's real height without measuring it */}
      <div id={id} className={cn("grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="border-t border-border px-3 py-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

// ---- single choice --------------------------------------------------------------------------------------------------------

export interface PanelOption {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

/** Single-choice rows. Shows a search field once there are more than `searchAbove` options. */
export function PanelOptionList({
  options,
  value,
  onChange,
  searchAbove = 7,
  emptyLabel = "Nothing matches",
  ariaLabel,
}: {
  options: PanelOption[];
  value: string | null;
  onChange: (value: string) => void;
  searchAbove?: number;
  emptyLabel?: string;
  ariaLabel: string;
}) {
  const [q, setQ] = useState("");
  const shown = q.trim() ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) : options;
  return (
    <div className="flex flex-col gap-2">
      {options.length > searchAbove && (
        <label className="relative block" data-no-enter-apply>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label={`Search ${ariaLabel}`}
            className="h-8 w-full rounded-lg border border-input bg-transparent pr-2 pl-8 text-sm outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
        </label>
      )}
      <div role="listbox" aria-label={ariaLabel} className="flex flex-col gap-0.5">
        {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyLabel}</p>}
        {shown.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onChange(o.value)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                on ? "bg-primary/12 font-medium text-foreground" : "hover:bg-secondary",
              )}
            >
              {o.icon && <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">{o.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{o.label}</span>
                {o.hint && <span className="block truncate text-xs text-muted-foreground">{o.hint}</span>}
              </span>
              {on && <Check className="size-4 shrink-0 text-primary-accent-text" strokeWidth={2.25} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- repeating rows -------------------------------------------------------------------------------------------------------

/**
 * Stacked, numbered rows with a remove button and an "Add more" button. Controlled: the caller owns `rows` and gets the
 * next array in `onChange`. New rows animate in and take focus; removed rows animate out. Scales to dozens of rows
 * because the panel body scrolls, not the page.
 */
export function StackedRows<T extends { id: string }>({
  rows,
  onChange,
  createRow,
  renderRow,
  addLabel = "Add more",
  minRows = 0,
  maxRows,
  emptyState,
  rowLabel = (i) => `Row ${i + 1}`,
  summary,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  createRow: () => T;
  /** Render one row's fields. `update` merges a patch into this row. */
  renderRow: (row: T, index: number, update: (patch: Partial<T>) => void) => ReactNode;
  addLabel?: string;
  minRows?: number;
  maxRows?: number;
  emptyState?: ReactNode;
  rowLabel?: (index: number) => string;
  /** A recap under the rows — a running total, a mismatch warning… */
  summary?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);

  // A row added by the button gets focus on its first field and is scrolled into view; its entrance animation then ends.
  useEffect(() => {
    if (!added) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(added)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el?.querySelector<HTMLElement>("input, button[role='combobox'], select, textarea")?.focus({ preventScroll: true });
    const t = window.setTimeout(() => setAdded(null), 300);
    return () => window.clearTimeout(t);
  }, [added]);

  const add = () => {
    if (maxRows != null && rows.length >= maxRows) return;
    const row = createRow();
    setAdded(row.id);
    onChange([...rows, row]);
  };
  const remove = (id: string) => {
    if (rows.length <= minRows || leaving) return;
    setLeaving(id);
    window.setTimeout(() => {
      onChange(rows.filter((r) => r.id !== id));
      setLeaving(null);
    }, 150);
  };
  const atMax = maxRows != null && rows.length >= maxRows;

  return (
    <div className="flex flex-col gap-2">
      <div ref={listRef} className="flex flex-col gap-2">
        {rows.length === 0 && emptyState && <div className="rounded-xl border border-dashed border-border-strong px-3 py-5 text-center text-xs text-muted-foreground">{emptyState}</div>}
        {rows.map((row, i) => (
          <div
            key={row.id}
            data-row-id={row.id}
            data-testid="stacked-row"
            className={cn(
              "flex items-start gap-2 rounded-xl border border-border bg-card px-2.5 py-2 transition-[opacity,transform] duration-150 motion-reduce:transition-none",
              row.id === added && "animate-in fade-in-0 slide-in-from-top-2 duration-200",
              leaving === row.id && "scale-[0.98] opacity-0",
            )}
          >
            <span aria-hidden className="mt-1.5 grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <div role="group" aria-label={rowLabel(i)} className="grid min-w-0 flex-1 grid-cols-1 gap-2 @min-[23rem]:grid-cols-[1fr_7.5rem]">
              {renderRow(row, i, (patch) => onChange(rows.map((r) => (r.id === row.id ? { ...r, ...patch } : r))))}
            </div>
            {rows.length > minRows && (
              <button
                type="button"
                aria-label={`Remove ${rowLabel(i)}`}
                onClick={() => remove(row.id)}
                className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-expense/10 hover:text-expense focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        disabled={atMax}
        className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-strong text-[13px] font-medium text-foreground outline-none transition-colors hover:border-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="size-4" strokeWidth={2} />
        {addLabel}
        {maxRows != null && <span className="text-xs font-normal text-muted-foreground">({rows.length}/{maxRows})</span>}
      </button>
      {summary && <div className="text-xs text-muted-foreground">{summary}</div>}
    </div>
  );
}

/** Stacks several `PanelSection`s with even spacing. */
export function PanelStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{Children.toArray(children).filter(isValidElement)}</div>;
}
