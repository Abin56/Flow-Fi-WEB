import * as React from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

export interface SearchFieldProps extends Omit<React.ComponentProps<"input">, "onChange"> {
  onChange?: (value: string) => void;
  onClear?: () => void;
}

/** Search input with a leading search icon and a clear button that appears once there's a value. */
export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(
  ({ value, onChange, onClear, placeholder = "Search…", className, ...props }, ref) => {
    return (
      <InputGroup className={className}>
        <InputGroupAddon>
          <SearchIcon className="size-4" />
        </InputGroupAddon>
        <InputGroupInput
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange?.(e.target.value)}
          {...props}
        />
        {!!value && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onClear?.()}>
              <XIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    );
  },
);
SearchField.displayName = "SearchField";
