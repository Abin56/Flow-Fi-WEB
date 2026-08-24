import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface InlineValidationProps {
  valid: boolean;
  message: string;
  className?: string;
}

/** Single inline pass/fail row — e.g. one password-strength rule ("At least 8 characters"). Compose a list
 *  of these under a PasswordField. */
export function InlineValidation({ valid, message, className }: InlineValidationProps) {
  return (
    <div className={cn("flex items-center gap-1.5 text-sm", valid ? "text-success" : "text-muted-foreground", className)}>
      {valid ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
      {message}
    </div>
  );
}
