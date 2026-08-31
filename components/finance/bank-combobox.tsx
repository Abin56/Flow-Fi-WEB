"use client";

import { Check, ChevronsUpDown, Landmark } from "lucide-react";
import { useId, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BANKS, FREQUENT_BANKS, GENERIC_BANK, bankById } from "@/lib/data/bank-registry";
import { BankLogo } from "@/components/finance/bank-logo";
import { cn } from "@/lib/utils";

interface BankComboboxProps {
  value: string | null;
  onChange: (bankId: string | null) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Searchable "which bank is this" picker — 55+ banks in a plain <select> forces
 * scroll-and-scan, so this trades that for type-to-filter with a Popular shortlist
 * up top (same banks `FREQUENT_BANKS` surfaces in the credit-card picker).
 */
export function BankCombobox({ value, onChange, placeholder = "Select bank", className }: BankComboboxProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = bankById(value);
  const rest = BANKS.filter((b) => !b.frequent);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className={cn(
            "flex h-10 w-full items-center gap-2 border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          {selected ? <BankLogo bankId={selected.id} size={24} shape="square" /> : <Landmark className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-left">{selected ? selected.name : placeholder}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent id={listId} className="w-(--radix-popover-trigger-width) rounded-none border border-border p-0" align="start">
        <Command>
          <CommandInput placeholder="Search banks…" />
          <CommandList>
            <CommandEmpty>No bank found.</CommandEmpty>
            {value && (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    onSelect={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    className="text-muted-foreground"
                  >
                    Not set
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading="Popular">
              {FREQUENT_BANKS.map((bank) => (
                <CommandItem
                  key={bank.id}
                  value={bank.name}
                  onSelect={() => {
                    onChange(bank.id);
                    setOpen(false);
                  }}
                >
                  <BankLogo bankId={bank.id} size={24} shape="square" />
                  <span className="flex-1 truncate">{bank.name}</span>
                  {value === bank.id && <Check className="size-4 text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="All Banks">
              {rest.map((bank) => (
                <CommandItem
                  key={bank.id}
                  value={bank.name}
                  onSelect={() => {
                    onChange(bank.id);
                    setOpen(false);
                  }}
                >
                  <BankLogo bankId={bank.id} size={24} shape="square" />
                  <span className="flex-1 truncate">{bank.name}</span>
                  {value === bank.id && <Check className="size-4 text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Not Listed">
              <CommandItem
                value={`${GENERIC_BANK.name} other generic not listed`}
                onSelect={() => {
                  onChange(GENERIC_BANK.id);
                  setOpen(false);
                }}
              >
                <BankLogo bankId={GENERIC_BANK.id} size={24} shape="square" />
                <span className="flex-1 truncate">{GENERIC_BANK.name}</span>
                {value === GENERIC_BANK.id && <Check className="size-4 text-primary" />}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
