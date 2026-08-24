"use client";

import { useRef, useState } from "react";
import { FileText, UploadCloud, X } from "lucide-react";
import { MAX_FILE_SIZE_BYTES } from "@/lib/statement-intelligence/ingestion-caps";
import { cn } from "@/lib/utils";

const MAX_SIZE_MB = Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024));

interface UploadDropzoneProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  disabled?: boolean;
}

/** Drag-and-drop PDF picker. Real client-side accept filtering only — the actual size/magic-bytes
 *  cap enforcement happens in `validateIngestionCaps` once upload is confirmed. */
export function UploadDropzone({ file, onFileChange, disabled }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(files: FileList | null) {
    const next = files?.[0] ?? null;
    if (next && next.type !== "application/pdf") return;
    onFileChange(next);
  }

  if (file) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 shrink-0 text-primary" />
          <span className="truncate font-medium text-foreground">{file.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{(file.size / (1024 * 1024)).toFixed(1)} MB</span>
        </div>
        {!disabled && (
          <button
            type="button"
            onClick={() => onFileChange(null)}
            aria-label="Remove file"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border px-4 py-6 text-center transition-colors",
        dragOver && "border-primary bg-primary/5",
      )}
    >
      <UploadCloud className="size-6 text-muted-foreground" />
      <p className="text-sm text-foreground">
        Drag &amp; drop PDF here or{" "}
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="font-medium text-primary underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
        >
          Choose File
        </button>
      </p>
      <p className="text-xs text-muted-foreground">Supported formats: PDF, Max {MAX_SIZE_MB}MB</p>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
