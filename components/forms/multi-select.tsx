"use client";

import * as React from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SettingsLabel } from "@/components/settings/settings-label";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectProps {
  label?: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  className?: string;
}

/** Multi-select — a popover checklist with selected options rendered as removable chips on the trigger. */
export function MultiSelect({ label, values, onChange, options, placeholder = "Select…", className }: MultiSelectProps) {
  const id = React.useId();

  function toggle(value: string) {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  }

  const selectedOptions = options.filter((o) => values.includes(o.value));

  return (
    <div className="flex flex-col gap-1.5">
      {label && <SettingsLabel htmlFor={id}>{label}</SettingsLabel>}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className={cn("h-auto min-h-9 w-64 justify-between gap-2 py-1.5 font-normal", className)}
          >
            <div className="flex flex-1 flex-wrap gap-1">
              {selectedOptions.length === 0 && <span className="text-muted-foreground">{placeholder}</span>}
              {selectedOptions.map((option) => (
                <Badge key={option.value} variant="secondary" className="gap-1">
                  {option.label}
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(option.value);
                    }}
                    className="cursor-pointer"
                  >
                    <XIcon className="size-3" />
                  </span>
                </Badge>
              ))}
            </div>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-1.5" align="start">
          <div className="flex flex-col gap-0.5">
            {options.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-muted"
              >
                <Checkbox checked={values.includes(option.value)} onCheckedChange={() => toggle(option.value)} />
                {option.label}
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
