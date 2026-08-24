"use client";

import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Export trigger for a chart/report — non-functional placeholder since no export pipeline exists yet.
 *  Options render disabled with a "coming soon" note rather than faking a successful export. */
export function ExportPanel() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ClayButton variant="secondary" size="sm">
          <Download className="size-3.5" />
          Export
        </ClayButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Coming soon</DropdownMenuLabel>
        <DropdownMenuItem disabled>
          <FileText className="size-4" />
          Export as PDF
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <FileSpreadsheet className="size-4" />
          Export as CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
